import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { CopilotClientOptions } from "../types.js";
import {
    codexSandboxPolicy,
    codexThreadSandboxMode,
    dynamicToolsFromDescriptors,
    extractFileChangesFromParams,
    mapCodexCommandApprovalToPermissionRequest,
    mapCodexFileChangeApprovalToPermissionRequest,
    mapCodexModels,
    mapPermissionResultToCodexCommandDecision,
    mapPermissionResultToCodexFileChangeDecision,
    mapSdkToolResultToCodexDynamicToolResponse,
    toolDescriptorsFromSessionCreateParams,
} from "./codexAdapterMappers.js";
import type { ToolDescriptor } from "./codexAdapterMappers.js";

type JsonRpcId = number | string;

type JsonRpcError = {
    code: number;
    message: string;
    data?: unknown;
};

type JsonRpcResponse = {
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
};

type JsonRpcRequest = {
    id: JsonRpcId;
    method: string;
    params?: unknown;
};

type JsonRpcNotification = {
    method: string;
    params?: unknown;
};

type PendingRequest = {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

export type CodexAdapterSandboxMode =
    | "dangerFullAccess"
    | "danger-full-access"
    | "readOnly"
    | "read-only"
    | "workspaceWrite"
    | "workspace-write";

export type CodexAdapterCapabilityStatus = "supported" | "unsupported" | "deferred";

export type CodexAdapterCapabilityFlag = {
    id: string;
    status: CodexAdapterCapabilityStatus;
    reason?: string;
};

export type CodexAdapterTranscriptEntry = {
    at: string;
    direction: string;
    message: unknown;
};

export type CodexAdapterOptions = {
    codexBin?: string;
    codexHome?: string;
    isolateCodexHome?: boolean;
    host?: string;
    port?: number;
    protocolVersion?: 2 | 3;
    model?: string;
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandboxMode?: CodexAdapterSandboxMode;
    networkAccess?: boolean;
    requestTimeoutMs?: number;
    clientInfo?: {
        name?: string;
        title?: string;
        version?: string;
    };
};

type SessionState = {
    sessionId: string;
    threadId: string;
    createdAt: string;
    cwd: string;
    model?: string;
    tools: ToolDescriptor[];
    lastEventId: string | null;
    events: unknown[];
    attachedConnectionIds: Set<string>;
    resumeCount: number;
};

type PendingDynamicToolCall = {
    codexRequestId: JsonRpcId;
    sessionId: string;
    toolCallId: string;
    toolName: string;
};

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_HOST = "127.0.0.1";

export const CODEX_ADAPTER_CAPABILITIES = {
    targetProfiles: ["SDK Core Profile", "Coding Agent Profile"],
    flags: [
        { id: "ping", status: "supported" },
        { id: "status.get", status: "supported" },
        { id: "auth.getStatus", status: "supported" },
        { id: "models.list", status: "supported" },
        { id: "session.create", status: "supported" },
        { id: "session.resume", status: "supported" },
        { id: "session.getMessages", status: "supported" },
        { id: "session.send", status: "supported" },
        { id: "session.destroy", status: "supported" },
        { id: "command approval", status: "supported" },
        { id: "file approval", status: "supported" },
        { id: "custom tool call", status: "supported" },
        { id: "tool failure/denial", status: "supported" },
        {
            id: "Interactive Profile",
            status: "deferred",
            reason: "user input and elicitation are not in the selected runtime profile",
        },
        {
            id: "Fidelity Profile",
            status: "deferred",
            reason: "streaming deltas, usage events, and sub-agent fidelity are not first-gate parity",
        },
        {
            id: "Extended CLI Profile",
            status: "deferred",
            reason: "CLI escape-hatch RPCs are required only when a product path consumes them",
        },
    ] satisfies CodexAdapterCapabilityFlag[],
} as const;

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

function summarizeUnknownError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return {
        name: "Error",
        message: typeof error === "string" ? error : JSON.stringify(error),
    };
}

function toJsonRpcError(error: unknown, fallbackCode = -32603): JsonRpcError {
    if (isRecord(error) && typeof error.code === "number" && typeof error.message === "string") {
        return {
            code: error.code,
            message: error.message,
            data: error.data,
        };
    }

    const summarized = summarizeUnknownError(error);
    return {
        code: fallbackCode,
        message: summarized.message,
        data: summarized.stack,
    };
}

function prepareCodexHome(options: CodexAdapterOptions): string {
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

function hasToolDescriptor(session: SessionState, toolName: string): boolean {
    return session.tools.some((tool) => tool.name === toolName);
}

function createSessionEvent<T extends string, D>(
    session: SessionState,
    type: T,
    data: D,
    ephemeral = false
) {
    const id = randomUUID();
    const event = {
        type,
        data,
        id,
        parentId: session.lastEventId,
        timestamp: nowIso(),
        ephemeral,
    };
    session.lastEventId = id;
    return event;
}

export class CodexAppServerClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<JsonRpcId, PendingRequest>();
    private notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
    private requestHandlers = new Set<(request: JsonRpcRequest) => void>();
    private transcript: CodexAdapterTranscriptEntry[] = [];
    private codexHome: string;
    private codexBin: string;
    private requestTimeoutMs: number;
    private clientInfo: Required<Required<CodexAdapterOptions>["clientInfo"]>;

    constructor(options: CodexAdapterOptions = {}) {
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

export class CodexCopilotAdapterServer {
    private server: Server = createServer();
    private sessions = new Map<string, SessionState>();
    private threadToSession = new Map<string, string>();
    private connections = new Map<string, MessageConnection>();
    private fileChangeSnapshots = new Map<string, unknown[]>();
    private pendingDynamicToolCalls = new Map<string, PendingDynamicToolCall>();
    private port = 0;
    private transcript: CodexAdapterTranscriptEntry[] = [];
    private codexUnsubscribe: (() => void) | null = null;
    private codexRequestUnsubscribe: (() => void) | null = null;
    private nextConnectionId = 1;
    private codex: CodexAppServerClient;
    private options: Required<
        Pick<
            CodexAdapterOptions,
            | "host"
            | "protocolVersion"
            | "model"
            | "approvalPolicy"
            | "approvalsReviewer"
            | "sandboxMode"
            | "networkAccess"
        >
    > &
        Pick<CodexAdapterOptions, "port">;

    constructor(options: CodexAdapterOptions = {}, codex?: CodexAppServerClient) {
        this.options = {
            host: options.host ?? DEFAULT_HOST,
            port: options.port,
            protocolVersion: options.protocolVersion ?? 3,
            model: options.model ?? DEFAULT_MODEL,
            approvalPolicy: options.approvalPolicy ?? "never",
            approvalsReviewer: options.approvalsReviewer ?? "user",
            sandboxMode: options.sandboxMode ?? "readOnly",
            networkAccess: options.networkAccess ?? false,
        };
        this.codex = codex ?? new CodexAppServerClient(options);
    }

    async start(): Promise<{ port: number; cliUrl: string; clientOptions: CopilotClientOptions }> {
        await this.codex.start();
        this.codexUnsubscribe = this.codex.onNotification((notification) => {
            this.transcript.push({
                at: nowIso(),
                direction: "codex->adapter",
                message: notification,
            });
            this.handleCodexNotification(notification);
        });
        this.codexRequestUnsubscribe = this.codex.onRequest((request) => {
            this.transcript.push({
                at: nowIso(),
                direction: "codex->adapter.request",
                message: request,
            });
            void this.handleCodexRequest(request);
        });
        this.server.on("connection", (socket) => {
            this.bindSocket(socket);
        });

        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.options.port ?? 0, this.options.host, () => resolve());
        });

        const address = this.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Failed to determine adapter port");
        }
        this.port = address.port;
        return {
            port: this.port,
            cliUrl: this.cliUrl(),
            clientOptions: this.clientOptions(),
        };
    }

    cliUrl(): string {
        if (!this.port) {
            throw new Error("Codex adapter server is not started");
        }
        return `${this.options.host}:${this.port}`;
    }

    clientOptions(): CopilotClientOptions {
        return {
            autoStart: false,
            cliUrl: this.cliUrl(),
        };
    }

    capabilities() {
        return CODEX_ADAPTER_CAPABILITIES;
    }

    private bindSocket(socket: Socket) {
        const connectionId = `sdk-${this.nextConnectionId++}`;
        const connection = createMessageConnection(
            new StreamMessageReader(socket),
            new StreamMessageWriter(socket)
        );
        this.connections.set(connectionId, connection);
        this.transcript.push({
            at: nowIso(),
            direction: "adapter.connection.open",
            message: {
                connectionId,
                connectionCount: this.connections.size,
            },
        });

        const registerHandler = (
            method: string,
            handler: (params: unknown, connectionId: string) => Promise<unknown> | unknown
        ) => {
            connection.onRequest(method, async (params: unknown) => {
                this.transcript.push({
                    at: nowIso(),
                    direction: "sdk->adapter.request",
                    message: { method, params },
                });
                try {
                    const result = await handler(params, connectionId);
                    this.transcript.push({
                        at: nowIso(),
                        direction: "adapter->sdk.response",
                        message: { method, result },
                    });
                    return result;
                } catch (error) {
                    const rpcError = toJsonRpcError(error);
                    this.transcript.push({
                        at: nowIso(),
                        direction: "adapter->sdk.response",
                        message: { method, error: rpcError },
                    });
                    throw rpcError;
                }
            });
        };

        registerHandler("ping", (params) => this.handlePing(params));
        registerHandler("status.get", () => ({
            version: "codex-copilot-adapter",
            protocolVersion: this.options.protocolVersion,
        }));
        registerHandler("auth.getStatus", () => this.handleAuthStatus());
        registerHandler("models.list", () => this.handleModelsList());
        registerHandler("session.create", (params, id) => this.handleSessionCreate(params, id));
        registerHandler("session.resume", (params, id) => this.handleSessionResume(params, id));
        registerHandler("session.getMessages", (params, id) =>
            this.handleSessionGetMessages(params, id)
        );
        registerHandler("session.send", (params, id) => this.handleSessionSend(params, id));
        registerHandler("session.destroy", (params, id) => this.handleSessionDestroy(params, id));
        registerHandler("session.tools.handlePendingToolCall", (params) =>
            this.handlePendingToolCall(params)
        );

        socket.on("close", () => {
            this.connections.delete(connectionId);
            this.detachConnection(connectionId);
            this.transcript.push({
                at: nowIso(),
                direction: "adapter.connection.close",
                message: {
                    connectionId,
                    connectionCount: this.connections.size,
                },
            });
        });

        connection.listen();
    }

    private writeNotification(
        method: string,
        params: unknown,
        targetConnectionIds?: Iterable<string>
    ) {
        const connectionIds = targetConnectionIds
            ? [...new Set([...targetConnectionIds])]
            : [...this.connections.keys()];
        if (connectionIds.length === 0) {
            this.transcript.push({
                at: nowIso(),
                direction: "adapter->sdk.notification.skipped",
                message: {
                    method,
                    reason: "no-target-connections",
                },
            });
            return;
        }
        const notification = { method, params };
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->sdk.notification",
            message: notification,
        });
        for (const connectionId of connectionIds) {
            const connection = this.connections.get(connectionId);
            if (!connection) {
                continue;
            }
            void connection.sendNotification(method, params).catch(() => {
                this.connections.delete(connectionId);
                this.detachConnection(connectionId);
            });
        }
    }

    private getPrimaryConnection(session: SessionState): {
        connectionId: string;
        connection: MessageConnection;
    } | null {
        for (const connectionId of session.attachedConnectionIds) {
            const connection = this.connections.get(connectionId);
            if (connection) {
                return { connectionId, connection };
            }
        }
        return null;
    }

    private detachConnection(connectionId: string) {
        for (const session of this.sessions.values()) {
            if (!session.attachedConnectionIds.delete(connectionId)) {
                continue;
            }
            if (session.attachedConnectionIds.size === 0) {
                this.threadToSession.delete(session.threadId);
            }
        }
    }

    private emitLifecycle(type: string, sessionId: string, metadata?: Record<string, unknown>) {
        const session = this.sessions.get(sessionId);
        this.writeNotification(
            "session.lifecycle",
            { type, sessionId, metadata },
            session?.attachedConnectionIds
        );
    }

    private emitSessionEvent(sessionId: string, event: unknown) {
        const session = this.sessions.get(sessionId);
        if (session && isRecord(event) && (!("ephemeral" in event) || event.ephemeral !== true)) {
            session.events.push(event);
        }
        this.writeNotification(
            "session.event",
            { sessionId, event },
            session?.attachedConnectionIds
        );
    }

    private handlePing(params: unknown) {
        const message =
            isRecord(params) && typeof params.message === "string" ? params.message : undefined;
        return {
            message: message ? `pong: ${message}` : "pong",
            timestamp: Date.now(),
            protocolVersion: this.options.protocolVersion,
        };
    }

    private async handleAuthStatus() {
        const response = await this.codex.request("account/read", { refreshToken: false });
        if (response.error) {
            return {
                isAuthenticated: false,
                statusMessage: response.error.message,
            };
        }

        const account =
            isRecord(response.result) && isRecord(response.result.account)
                ? response.result.account
                : null;

        if (!account) {
            return {
                isAuthenticated: false,
                statusMessage: "No account",
            };
        }

        return {
            isAuthenticated: true,
            authType: account.type === "apiKey" ? "api-key" : "user",
            login: typeof account.email === "string" ? account.email : undefined,
            statusMessage: `${String(account.type)}:${String(account.planType ?? "unknown")}`,
        };
    }

    private async handleModelsList() {
        const response = await this.codex.request("model/list", {
            includeHidden: false,
            limit: 50,
        });
        if (response.error) {
            throw response.error;
        }

        return {
            models: mapCodexModels(response.result),
        };
    }

    private extractBaseInstructions(params: Record<string, unknown>): string | undefined {
        const systemMessage = isRecord(params.systemMessage) ? params.systemMessage : null;
        if (!systemMessage) {
            return undefined;
        }
        const content = systemMessage.content;
        return typeof content === "string" && content.trim().length > 0 ? content : undefined;
    }

    private async handleSessionCreate(params: unknown, connectionId: string) {
        if (!isRecord(params)) {
            throw new Error("session.create params missing");
        }

        const sessionId = typeof params.sessionId === "string" ? params.sessionId : randomUUID();
        const cwd =
            typeof params.workingDirectory === "string" ? params.workingDirectory : process.cwd();
        const createdAt = nowIso();
        const model = typeof params.model === "string" ? params.model : this.options.model;
        const reasoningEffort =
            typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined;
        const tools = toolDescriptorsFromSessionCreateParams(params);
        const dynamicTools = dynamicToolsFromDescriptors(tools);
        const baseInstructions = this.extractBaseInstructions(params);

        const threadResponse = await this.codex.request("thread/start", {
            cwd,
            model,
            approvalPolicy: this.options.approvalPolicy,
            approvalsReviewer: this.options.approvalsReviewer,
            sandbox: codexThreadSandboxMode(this.options.sandboxMode),
            ephemeral: true,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...(baseInstructions ? { baseInstructions } : {}),
            ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
        });
        if (threadResponse.error) {
            throw threadResponse.error;
        }

        const thread =
            isRecord(threadResponse.result) && isRecord(threadResponse.result.thread)
                ? threadResponse.result.thread
                : null;
        const threadId = thread && typeof thread.id === "string" ? thread.id : null;

        if (!threadId) {
            throw new Error("thread/start did not return thread.id");
        }

        const session: SessionState = {
            sessionId,
            threadId,
            createdAt,
            cwd,
            model,
            tools,
            lastEventId: null,
            events: [],
            attachedConnectionIds: new Set([connectionId]),
            resumeCount: 0,
        };
        this.sessions.set(sessionId, session);
        this.threadToSession.set(threadId, sessionId);

        this.emitLifecycle("session.created", sessionId, {
            startTime: createdAt,
            modifiedTime: createdAt,
        });
        this.emitSessionEvent(
            sessionId,
            createSessionEvent(session, "session.start", {
                sessionId,
                startTime: createdAt,
                version: 1,
                producer: "codex-copilot-adapter",
                copilotVersion: "codex-copilot-adapter",
                selectedModel: model,
                reasoningEffort,
                context: {
                    cwd,
                },
            })
        );

        return {
            sessionId,
            capabilities: {
                ui: {
                    elicitation: false,
                },
            },
        };
    }

    private async handleSessionResume(params: unknown, connectionId: string) {
        if (!isRecord(params)) {
            throw new Error("session.resume params missing");
        }

        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (!sessionId) {
            throw new Error("session.resume requires sessionId");
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unknown session: ${sessionId}`);
        }

        const alreadyInUse = session.attachedConnectionIds.size > 0;
        const eventCount = session.events.length;
        session.attachedConnectionIds.add(connectionId);
        session.cwd =
            typeof params.workingDirectory === "string" ? params.workingDirectory : session.cwd;
        session.model = typeof params.model === "string" ? params.model : session.model;
        session.resumeCount += 1;
        this.threadToSession.set(session.threadId, session.sessionId);

        const resumeTime = nowIso();
        this.emitLifecycle("session.resumed", session.sessionId, {
            resumeTime,
            eventCount,
            alreadyInUse,
        });

        if (params.disableResume !== true) {
            this.emitSessionEvent(
                session.sessionId,
                createSessionEvent(session, "session.resume", {
                    resumeTime,
                    eventCount,
                    selectedModel: session.model ?? this.options.model,
                    reasoningEffort:
                        typeof params.reasoningEffort === "string"
                            ? params.reasoningEffort
                            : undefined,
                    alreadyInUse,
                    context: {
                        cwd: session.cwd,
                    },
                })
            );
        }

        return {
            sessionId: session.sessionId,
            capabilities: {
                ui: {
                    elicitation: false,
                },
            },
        };
    }

    private handleSessionGetMessages(params: unknown, connectionId: string) {
        const sessionId =
            isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (!sessionId) {
            throw new Error("session.getMessages requires sessionId");
        }

        const session = this.sessions.get(sessionId);
        if (!session || !session.attachedConnectionIds.has(connectionId)) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        return {
            events: [...session.events],
        };
    }

    private async handleSessionSend(params: unknown, connectionId: string) {
        if (!isRecord(params)) {
            throw new Error("session.send params missing");
        }

        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
        if (!sessionId || !prompt) {
            throw new Error("session.send requires sessionId and prompt");
        }

        const session = this.sessions.get(sessionId);
        if (!session || !session.attachedConnectionIds.has(connectionId)) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        const userMessageId = randomUUID();
        this.emitSessionEvent(
            session.sessionId,
            createSessionEvent(session, "user.message", {
                content: prompt,
                messageId: userMessageId,
            })
        );

        const response = await this.codex.request("turn/start", {
            threadId: session.threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            model: session.model ?? this.options.model,
            approvalPolicy: this.options.approvalPolicy,
            approvalsReviewer: this.options.approvalsReviewer,
            sandboxPolicy: codexSandboxPolicy(this.options.sandboxMode, this.options.networkAccess),
        });
        if (response.error) {
            throw response.error;
        }

        return {
            messageId: userMessageId,
        };
    }

    private handleSessionDestroy(params: unknown, connectionId: string) {
        const sessionId =
            isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.attachedConnectionIds.delete(connectionId);
                if (session.attachedConnectionIds.size === 0) {
                    this.threadToSession.delete(session.threadId);
                }
            }
        }
        return { success: true };
    }

    private handlePendingToolCall(params: unknown) {
        if (!isRecord(params)) {
            throw new Error("session.tools.handlePendingToolCall params missing");
        }

        const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
        if (!requestId) {
            throw new Error("session.tools.handlePendingToolCall requires requestId");
        }

        const pending = this.pendingDynamicToolCalls.get(requestId);
        if (!pending) {
            return { success: false };
        }
        this.pendingDynamicToolCalls.delete(requestId);

        const response = mapSdkToolResultToCodexDynamicToolResponse(params.result, params.error);
        this.codex.respond(pending.codexRequestId, response);

        const session = this.sessions.get(pending.sessionId);
        if (session) {
            this.emitSessionEvent(
                pending.sessionId,
                createSessionEvent(
                    session,
                    "external_tool.completed",
                    {
                        requestId,
                    },
                    true
                )
            );
        }

        this.transcript.push({
            at: nowIso(),
            direction: "adapter.tool.completed",
            message: {
                requestId,
                sessionId: pending.sessionId,
                toolName: pending.toolName,
                toolCallId: pending.toolCallId,
                success: response.success,
            },
        });

        return { success: true };
    }

    private handleCodexNotification(notification: JsonRpcNotification) {
        const params = notification.params;
        if (!isRecord(params)) {
            return;
        }
        const fileChangeItemId =
            typeof params.itemId === "string"
                ? params.itemId
                : isRecord(params.item) && typeof params.item.id === "string"
                  ? params.item.id
                  : undefined;
        const fileChanges = extractFileChangesFromParams(params);
        if (fileChangeItemId && fileChanges.length > 0) {
            this.fileChangeSnapshots.set(fileChangeItemId, fileChanges);
        }

        const threadId =
            typeof params.threadId === "string"
                ? params.threadId
                : isRecord(params.thread) && typeof params.thread.id === "string"
                  ? params.thread.id
                  : undefined;
        if (!threadId) {
            return;
        }

        const sessionId = this.threadToSession.get(threadId);
        if (!sessionId) {
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        if (notification.method === "item/completed") {
            const item = isRecord(params.item) ? params.item : null;
            if (item?.type === "agentMessage") {
                this.emitSessionEvent(
                    sessionId,
                    createSessionEvent(session, "assistant.message", {
                        content: typeof item.text === "string" ? item.text : "",
                        messageId:
                            typeof item.id === "string" ? item.id : `assistant-${randomUUID()}`,
                        phase: typeof item.phase === "string" ? item.phase : undefined,
                    })
                );
            }
        } else if (notification.method === "turn/completed") {
            const turn = isRecord(params.turn) ? params.turn : null;
            const status = typeof turn?.status === "string" ? turn.status : "completed";
            if (status === "completed") {
                this.emitSessionEvent(sessionId, createSessionEvent(session, "session.idle", {}));
            } else {
                this.emitSessionEvent(
                    sessionId,
                    createSessionEvent(session, "session.error", {
                        errorType: "adapter",
                        message: `Codex turn completed with status=${status}`,
                    })
                );
            }
        }
    }

    private async handleCodexRequest(request: JsonRpcRequest): Promise<void> {
        if (
            request.method !== "item/commandExecution/requestApproval" &&
            request.method !== "item/fileChange/requestApproval" &&
            request.method !== "item/tool/call"
        ) {
            return;
        }

        const params = isRecord(request.params) ? request.params : {};
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (!threadId) {
            if (request.method === "item/tool/call") {
                this.codex.respond(request.id, {
                    contentItems: [
                        { type: "inputText", text: "dynamic tool request missing threadId" },
                    ],
                    success: false,
                });
            } else {
                this.codex.respond(request.id, { decision: "decline" });
            }
            return;
        }

        const sessionId = this.threadToSession.get(threadId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session) {
            if (request.method === "item/tool/call") {
                this.codex.respond(request.id, {
                    contentItems: [
                        { type: "inputText", text: "dynamic tool request has no session" },
                    ],
                    success: false,
                });
            } else {
                this.codex.respond(request.id, { decision: "decline" });
            }
            return;
        }

        const primaryConnection = this.getPrimaryConnection(session);
        if (!primaryConnection) {
            if (request.method === "item/tool/call") {
                this.codex.respond(request.id, {
                    contentItems: [
                        { type: "inputText", text: "dynamic tool request has no SDK connection" },
                    ],
                    success: false,
                });
            } else {
                this.codex.respond(request.id, { decision: "decline" });
            }
            return;
        }

        if (request.method === "item/tool/call") {
            await this.handleCodexDynamicToolCall(request, params, session, primaryConnection);
            return;
        }

        const changes =
            request.method === "item/fileChange/requestApproval" &&
            typeof params.itemId === "string"
                ? (this.fileChangeSnapshots.get(params.itemId) ?? [])
                : [];
        const permissionRequest =
            request.method === "item/fileChange/requestApproval"
                ? mapCodexFileChangeApprovalToPermissionRequest(params, changes)
                : mapCodexCommandApprovalToPermissionRequest(params);
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->sdk.request",
            message: {
                method: "permission.request",
                params: {
                    sessionId: session.sessionId,
                    permissionRequest,
                },
            },
        });

        try {
            const response = await primaryConnection.connection.sendRequest("permission.request", {
                sessionId: session.sessionId,
                permissionRequest,
            });
            this.transcript.push({
                at: nowIso(),
                direction: "sdk->adapter.response",
                message: {
                    method: "permission.request",
                    response,
                },
            });

            const result = isRecord(response) && "result" in response ? response.result : response;
            const decision =
                request.method === "item/fileChange/requestApproval"
                    ? mapPermissionResultToCodexFileChangeDecision(result)
                    : mapPermissionResultToCodexCommandDecision(result, params);
            this.codex.respond(request.id, { decision });
        } catch (error) {
            this.transcript.push({
                at: nowIso(),
                direction: "sdk->adapter.response",
                message: {
                    method: "permission.request",
                    error: summarizeUnknownError(error),
                },
            });
            this.codex.respond(request.id, { decision: "decline" });
        }
    }

    private handleCodexDynamicToolCall(
        request: JsonRpcRequest,
        params: Record<string, unknown>,
        session: SessionState,
        primaryConnection: { connectionId: string; connection: MessageConnection }
    ): Promise<void> | void {
        const toolName = typeof params.tool === "string" ? params.tool : undefined;
        const toolCallId = typeof params.callId === "string" ? params.callId : String(request.id);
        if (!toolName) {
            this.codex.respond(request.id, {
                contentItems: [
                    { type: "inputText", text: "dynamic tool request missing tool name" },
                ],
                success: false,
            });
            return;
        }

        if (!hasToolDescriptor(session, toolName)) {
            this.codex.respond(request.id, {
                contentItems: [
                    {
                        type: "inputText",
                        text: `dynamic tool ${toolName} is not registered with the SDK session`,
                    },
                ],
                success: false,
            });
            return;
        }

        if (this.options.protocolVersion === 2) {
            return this.handleCodexDynamicToolCallV2(
                request,
                params,
                session,
                primaryConnection,
                toolName,
                toolCallId
            );
        }

        const sdkRequestId = `codex-dynamic-tool:${toolCallId}`;
        this.pendingDynamicToolCalls.set(sdkRequestId, {
            codexRequestId: request.id,
            sessionId: session.sessionId,
            toolCallId,
            toolName,
        });

        this.emitSessionEvent(
            session.sessionId,
            createSessionEvent(
                session,
                "external_tool.requested",
                {
                    requestId: sdkRequestId,
                    sessionId: session.sessionId,
                    toolCallId,
                    toolName,
                    arguments: params.arguments,
                },
                true
            )
        );
    }

    private async handleCodexDynamicToolCallV2(
        request: JsonRpcRequest,
        params: Record<string, unknown>,
        session: SessionState,
        primaryConnection: { connectionId: string; connection: MessageConnection },
        toolName: string,
        toolCallId: string
    ): Promise<void> {
        const toolCallParams = {
            sessionId: session.sessionId,
            toolCallId,
            toolName,
            arguments: params.arguments,
        };
        this.transcript.push({
            at: nowIso(),
            direction: "adapter->sdk.request",
            message: {
                method: "tool.call",
                params: toolCallParams,
            },
        });
        try {
            const response = await primaryConnection.connection.sendRequest(
                "tool.call",
                toolCallParams
            );
            this.transcript.push({
                at: nowIso(),
                direction: "sdk->adapter.response",
                message: {
                    method: "tool.call",
                    response,
                },
            });
            const result = isRecord(response) && "result" in response ? response.result : response;
            this.codex.respond(
                request.id,
                mapSdkToolResultToCodexDynamicToolResponse(result, undefined)
            );
        } catch (error) {
            const summarized = summarizeUnknownError(error);
            this.transcript.push({
                at: nowIso(),
                direction: "sdk->adapter.response",
                message: {
                    method: "tool.call",
                    error: summarized,
                },
            });
            this.codex.respond(
                request.id,
                mapSdkToolResultToCodexDynamicToolResponse(undefined, summarized.message)
            );
        }
    }

    async stop(): Promise<void> {
        this.codexUnsubscribe?.();
        this.codexUnsubscribe = null;
        this.codexRequestUnsubscribe?.();
        this.codexRequestUnsubscribe = null;
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        await this.codex.stop();
    }

    summary() {
        return {
            port: this.port,
            transcripts: this.transcript,
            codex: this.codex.summary(),
            capabilities: CODEX_ADAPTER_CAPABILITIES,
        };
    }
}

export function createCodexCopilotClientOptions(
    adapter: CodexCopilotAdapterServer
): CopilotClientOptions {
    return adapter.clientOptions();
}
