import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export type JsonRpcId = number | string;

export type JsonRpcError = {
    code: number;
    message: string;
    data?: unknown;
};

export type JsonRpcResponse = {
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
};

export type JsonRpcRequest = {
    id: JsonRpcId;
    method: string;
    params?: unknown;
};

export type JsonRpcNotification = {
    method: string;
    params?: unknown;
};

export type CodexAppServerGatewayOptions = {
    codexBin?: string;
    codexHome?: string;
    isolateCodexHome?: boolean;
    requestTimeoutMs?: number;
    clientInfo?: {
        name?: string;
        title?: string;
        version?: string;
    };
};

type PendingRequest = {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type CodexGatewayTranscriptEntry = {
    at: string;
    direction: string;
    message: unknown;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

function resolveBinary(name: string): string {
    try {
        return execFileSync("which", [name], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return name;
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

function prepareCodexHome(options: CodexAppServerGatewayOptions): string {
    if (options.codexHome && options.isolateCodexHome === false) {
        return options.codexHome;
    }

    const sourceHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const adapterHome = mkdtempSync(join(tmpdir(), "copilot-codex-adapter-"));

    mkdirSync(join(adapterHome, "sessions"), { recursive: true });
    mkdirSync(join(adapterHome, "archived_sessions"), { recursive: true });
    mkdirSync(join(adapterHome, "tmp"), { recursive: true });

    for (const fileName of ["auth.json", "config.toml", "installation_id", "models_cache.json"]) {
        const sourcePath = join(sourceHome, fileName);
        if (existsSync(sourcePath)) {
            cpSync(sourcePath, join(adapterHome, fileName));
        }
    }

    return adapterHome;
}

function createCodexEnv(codexHome: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    env.CODEX_HOME = codexHome;
    return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function isResponse(message: unknown): message is JsonRpcResponse {
    return isRecord(message) && "id" in message && !("method" in message);
}

function isRequest(message: unknown): message is JsonRpcRequest {
    return (
        isRecord(message) &&
        "id" in message &&
        typeof message.method === "string" &&
        !("result" in message) &&
        !("error" in message)
    );
}

function isNotification(message: unknown): message is JsonRpcNotification {
    return isRecord(message) && typeof message.method === "string" && !("id" in message);
}

export class CodexAppServerGateway {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<JsonRpcId, PendingRequest>();
    private notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
    private requestHandlers = new Set<(request: JsonRpcRequest) => void>();
    private transcript: CodexGatewayTranscriptEntry[] = [];
    private codexHome: string;
    private codexBin: string;
    private requestTimeoutMs: number;
    private clientInfo: Required<Required<CodexAppServerGatewayOptions>["clientInfo"]>;

    constructor(options: CodexAppServerGatewayOptions = {}) {
        this.codexHome = prepareCodexHome(options);
        this.codexBin = options.codexBin ?? resolveBinary("codex");
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.clientInfo = {
            name: options.clientInfo?.name ?? "copilot_sdk_codex_adapter",
            title: options.clientInfo?.title ?? "Copilot SDK Codex Adapter",
            version: options.clientInfo?.version ?? "0.0.0",
        };
    }

    async start(): Promise<void> {
        this.child = spawn(this.codexBin, ["app-server"], {
            env: createCodexEnv(this.codexHome),
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.child.on("exit", (code, signal) => {
            for (const [id, pending] of this.pending.entries()) {
                clearTimeout(pending.timeout);
                pending.reject(
                    new Error(
                        `codex app-server exited before request ${String(id)} completed (code=${String(code)}, signal=${String(signal)})`
                    )
                );
            }
            this.pending.clear();
        });

        const stdout = readline.createInterface({ input: this.child.stdout });
        stdout.on("line", (line) => {
            let parsed: unknown = line;
            try {
                parsed = JSON.parse(line);
            } catch {
                // Keep raw line for transcript.
            }
            this.transcript.push({ at: nowIso(), direction: "codex->adapter", message: parsed });

            if (isRequest(parsed)) {
                for (const handler of this.requestHandlers) {
                    handler(parsed);
                }
                return;
            }

            if (isNotification(parsed)) {
                for (const handler of this.notificationHandlers) {
                    handler(parsed);
                }
                return;
            }

            if (isResponse(parsed)) {
                const pending = this.pending.get(parsed.id);
                if (pending) {
                    this.pending.delete(parsed.id);
                    clearTimeout(pending.timeout);
                    pending.resolve(parsed);
                }
            }
        });

        const stderr = readline.createInterface({ input: this.child.stderr });
        stderr.on("line", (line) => {
            this.transcript.push({
                at: nowIso(),
                direction: "codex-stderr",
                message: line,
            });
        });

        await this.initialize();
    }

    private async initialize(): Promise<void> {
        const response = await this.request("initialize", {
            clientInfo: this.clientInfo,
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
                optOutNotificationMethods: null,
            },
        });
        if (response.error) {
            throw new Error(response.error.message);
        }
        this.notify("initialized", {});
    }

    request(method: string, params?: unknown): Promise<JsonRpcResponse> {
        if (!this.child) {
            throw new Error("codex app-server is not started");
        }

        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params });
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->codex",
            message: { id, method, params },
        });
        this.child.stdin.write(`${payload}\n`);

        return new Promise<JsonRpcResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for codex response to ${method}`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
        });
    }

    notify(method: string, params?: unknown): void {
        if (!this.child) {
            throw new Error("codex app-server is not started");
        }
        const payload = JSON.stringify({ method, params });
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->codex",
            message: { method, params },
        });
        this.child.stdin.write(`${payload}\n`);
    }

    respond(id: JsonRpcId, result?: unknown, error?: JsonRpcError): void {
        if (!this.child) {
            throw new Error("codex app-server is not started");
        }
        const payload = JSON.stringify({
            id,
            ...(error ? { error } : { result }),
        });
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->codex.response",
            message: error ? { id, error } : { id, result },
        });
        this.child.stdin.write(`${payload}\n`);
    }

    onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }

    onRequest(handler: (request: JsonRpcRequest) => void): () => void {
        this.requestHandlers.add(handler);
        return () => this.requestHandlers.delete(handler);
    }

    async stop(): Promise<void> {
        if (!this.child) {
            return;
        }

        this.child.kill("SIGTERM");
        await delay(200);
        if (!this.child.killed) {
            this.child.kill("SIGKILL");
        }
        this.child = null;
    }

    summary() {
        return {
            codexHome: this.codexHome,
            transcripts: this.transcript,
        };
    }
}
