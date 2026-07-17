import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CopilotClient, RuntimeConnection } from "../dist/index.js";

type JsonRpcId = number | string;

type JsonRpcError = {
    code: number;
    message: string;
    data?: unknown;
};

type JsonRpcMessage = {
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: JsonRpcError;
};

type NotificationRecord = {
    method: string;
    params: unknown;
};

type ServerRequestRecord = {
    id: JsonRpcId;
    method: string;
    params: unknown;
};

type ServerResponseRecord = {
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
};

type ResponseRecord = {
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
};

type PendingRequest = {
    resolve: (value: ResponseRecord) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const CODEX_BIN = resolveCodexBinary();
const CODEX_ARGS = (process.env.CODEX_APP_SERVER_ARGS ?? "app-server")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
const RUN_TURN = process.env.CODEX_RUN_TURN === "1";
const TURN_TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS ?? 45_000);
const TURN_CWD = process.env.CODEX_WORKDIR ?? process.cwd();
const TURN_PROMPT = process.env.CODEX_TURN_PROMPT ?? "Reply with READY and nothing else.";
const TURN_APPROVAL_POLICY = process.env.CODEX_TURN_APPROVAL_POLICY ?? "never";
const TURN_SANDBOX_MODE = process.env.CODEX_TURN_SANDBOX_MODE ?? "readOnly";
const TURN_NETWORK_ACCESS = process.env.CODEX_TURN_NETWORK_ACCESS === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_REQUEST_TIMEOUT_MS ?? 20_000);
const TURN_POST_ERROR_WAIT_MS = Number(process.env.CODEX_TURN_POST_ERROR_WAIT_MS ?? 5_000);
const MAX_NOTIFICATION_SAMPLES = Number(process.env.CODEX_MAX_NOTIFICATION_SAMPLES ?? 200);
const AUTO_APPROVE_COMMAND_REQUESTS = process.env.CODEX_AUTO_APPROVE_COMMAND_REQUESTS === "1";
const COMMAND_APPROVAL_RESPONSE_OVERRIDE = parseJsonValue(
    process.env.CODEX_COMMAND_APPROVAL_RESULT_JSON,
    undefined
);
const STDOUT_LINE_LIMIT = 320;
const PROBE_CODEX_HOME = prepareProbeCodexHome();

function resolveCodexBinary(): string {
    if (process.env.CODEX_APP_SERVER_BIN) {
        return process.env.CODEX_APP_SERVER_BIN;
    }

    try {
        return execFileSync("which", ["codex"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "codex";
    }
}

function prepareProbeCodexHome(): string {
    if (process.env.CODEX_PROBE_USE_REAL_HOME === "1") {
        return process.env.CODEX_HOME ?? join(homedir(), ".codex");
    }

    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const probeHome = mkdtempSync(join(tmpdir(), "codex-app-server-smoke-"));

    mkdirSync(join(probeHome, "sessions"), { recursive: true });
    mkdirSync(join(probeHome, "archived_sessions"), { recursive: true });
    mkdirSync(join(probeHome, "tmp"), { recursive: true });

    for (const fileName of ["auth.json", "config.toml", "installation_id", "models_cache.json"]) {
        const sourcePath = join(sourceHome, fileName);
        if (existsSync(sourcePath)) {
            cpSync(sourcePath, join(probeHome, fileName));
        }
    }

    return probeHome;
}

function createProbeEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    env.CODEX_HOME = PROBE_CODEX_HOME;
    return env;
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
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

function coerceError(value: JsonRpcError | unknown, fallback: string): Error {
    if (value && typeof value === "object" && "message" in value) {
        const maybeMessage = (value as { message?: unknown }).message;
        if (typeof maybeMessage === "string") {
            return new Error(maybeMessage);
        }
    }

    return new Error(fallback);
}

function parseJsonValue(value: string | undefined, fallback: unknown): unknown {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function listAvailableDecisionIds(params: unknown): string[] {
    if (!isRecord(params) || !Array.isArray(params.availableDecisions)) {
        return [];
    }

    const ids: string[] = [];
    for (const entry of params.availableDecisions) {
        if (typeof entry === "string") {
            ids.push(entry);
            continue;
        }
        if (isRecord(entry)) {
            ids.push(...Object.keys(entry));
        }
    }

    return ids;
}

function getProposedExecpolicyAmendment(params: unknown): string[] | null {
    if (!isRecord(params) || !Array.isArray(params.proposedExecpolicyAmendment)) {
        return null;
    }

    const amendment = params.proposedExecpolicyAmendment.filter(
        (entry): entry is string => typeof entry === "string"
    );
    return amendment.length > 0 ? amendment : null;
}

function getProposedNetworkPolicyAmendment(params: unknown): Record<string, unknown> | null {
    if (!isRecord(params) || !Array.isArray(params.proposedNetworkPolicyAmendments)) {
        return null;
    }

    for (const entry of params.proposedNetworkPolicyAmendments) {
        if (isRecord(entry) && entry.action === "allow") {
            return entry;
        }
    }

    const first = params.proposedNetworkPolicyAmendments[0];
    return isRecord(first) ? first : null;
}

function normalizeCommandApprovalResponse(value: unknown): Record<string, unknown> {
    if (isRecord(value) && "decision" in value) {
        return value;
    }

    return { decision: value };
}

function buildCommandApprovalResponse(params: unknown): Record<string, unknown> {
    if (COMMAND_APPROVAL_RESPONSE_OVERRIDE !== undefined) {
        return normalizeCommandApprovalResponse(COMMAND_APPROVAL_RESPONSE_OVERRIDE);
    }

    const availableDecisions = new Set(listAvailableDecisionIds(params));
    const networkPolicyAmendment = getProposedNetworkPolicyAmendment(params);
    if (networkPolicyAmendment && availableDecisions.has("applyNetworkPolicyAmendment")) {
        return {
            decision: {
                applyNetworkPolicyAmendment: {
                    network_policy_amendment: networkPolicyAmendment,
                },
            },
        };
    }

    const execpolicyAmendment = getProposedExecpolicyAmendment(params);
    if (execpolicyAmendment && availableDecisions.has("acceptWithExecpolicyAmendment")) {
        return {
            decision: {
                acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: execpolicyAmendment,
                },
            },
        };
    }

    if (availableDecisions.has("acceptForSession")) {
        return { decision: "acceptForSession" };
    }

    if (availableDecisions.has("accept")) {
        return { decision: "accept" };
    }

    if (availableDecisions.has("cancel")) {
        return { decision: "cancel" };
    }

    return { decision: "accept" };
}

async function probeCopilotClientCompatibility() {
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: CODEX_BIN, args: CODEX_ARGS }),
        env: createProbeEnv(),
        logLevel: "info",
    });

    try {
        await client.start();
        return {
            ok: true,
            note: "Unexpected success. CopilotClient managed to start against codex app-server.",
        };
    } catch (error) {
        return {
            ok: false,
            error: serializeError(error),
        };
    } finally {
        try {
            await client.forceStop();
        } catch {
            // Ignore cleanup failures for probe runs.
        }
    }
}

class RawJsonRpcClient {
    private child: ChildProcessWithoutNullStreams;
    private nextId = 1;
    private pending = new Map<JsonRpcId, PendingRequest>();
    private notifications: NotificationRecord[] = [];
    private serverRequests: ServerRequestRecord[] = [];
    private autoResponses: ServerResponseRecord[] = [];
    private stderrLines: string[] = [];
    private stdoutLines: string[] = [];
    private exitCode: number | null = null;
    private exitSignal: NodeJS.Signals | null = null;

    constructor() {
        this.child = spawn(CODEX_BIN, CODEX_ARGS, {
            env: createProbeEnv(),
            stdio: ["pipe", "pipe", "pipe"],
        });

        const stdout = readline.createInterface({ input: this.child.stdout });
        stdout.on("line", (line) => {
            this.stdoutLines.push(line);
            this.handleLine(line);
        });

        const stderr = readline.createInterface({ input: this.child.stderr });
        stderr.on("line", (line) => {
            this.stderrLines.push(line);
        });

        this.child.on("exit", (code, signal) => {
            this.exitCode = code;
            this.exitSignal = signal;

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
    }

    private handleLine(line: string): void {
        let parsed: JsonRpcMessage;
        try {
            parsed = JSON.parse(line) as JsonRpcMessage;
        } catch {
            return;
        }

        if (
            parsed.method &&
            parsed.id !== undefined &&
            parsed.result === undefined &&
            parsed.error === undefined
        ) {
            if (this.serverRequests.length < MAX_NOTIFICATION_SAMPLES) {
                this.serverRequests.push({
                    id: parsed.id,
                    method: parsed.method,
                    params: parsed.params ?? null,
                });
            }

            if (
                AUTO_APPROVE_COMMAND_REQUESTS &&
                parsed.method === "item/commandExecution/requestApproval"
            ) {
                const response = buildCommandApprovalResponse(parsed.params ?? null);
                if (this.autoResponses.length < MAX_NOTIFICATION_SAMPLES) {
                    this.autoResponses.push({
                        id: parsed.id,
                        result: response,
                    });
                }
                this.sendResponse(parsed.id, response);
            }
            return;
        }

        if (parsed.method && parsed.id === undefined) {
            if (this.notifications.length < MAX_NOTIFICATION_SAMPLES) {
                this.notifications.push({
                    method: parsed.method,
                    params: parsed.params ?? null,
                });
            }
            return;
        }

        if (parsed.id === undefined) {
            return;
        }

        const pending = this.pending.get(parsed.id);
        if (!pending) {
            return;
        }

        this.pending.delete(parsed.id);
        clearTimeout(pending.timeout);
        pending.resolve({
            id: parsed.id,
            result: parsed.result,
            error: parsed.error,
        });
    }

    sendNotification(method: string, params?: unknown): void {
        const payload = JSON.stringify({
            method,
            params,
        });
        this.child.stdin.write(`${payload}\n`);
    }

    sendResponse(id: JsonRpcId, result?: unknown, error?: JsonRpcError): void {
        const payload = JSON.stringify({
            id,
            ...(error ? { error } : { result }),
        });
        this.child.stdin.write(`${payload}\n`);
    }

    async sendRequest(method: string, params?: unknown): Promise<ResponseRecord> {
        const id = this.nextId++;
        const payload = JSON.stringify({
            method,
            id,
            params,
        });

        const responsePromise = new Promise<ResponseRecord>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        `Timed out waiting for response to ${method} after ${REQUEST_TIMEOUT_MS}ms`
                    )
                );
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timeout });
        });

        this.child.stdin.write(`${payload}\n`);
        return await responsePromise;
    }

    async waitForNotification(method: string, timeoutMs: number): Promise<NotificationRecord> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const match = this.notifications.find((entry) => entry.method === method);
            if (match) {
                return match;
            }
            await delay(50);
        }

        throw new Error(`Timed out waiting for notification ${method}`);
    }

    async shutdown(): Promise<void> {
        if (!this.child.killed) {
            this.child.kill("SIGTERM");
        }
        await delay(200);
        if (this.exitCode === null && this.exitSignal === null) {
            this.child.kill("SIGKILL");
        }
    }

    summary() {
        return {
            notifications: this.notifications,
            serverRequests: this.serverRequests,
            autoResponses: this.autoResponses,
            stderrLines: this.stderrLines,
            stdoutLines: this.stdoutLines.map((line) =>
                line.length > STDOUT_LINE_LIMIT ? `${line.slice(0, STDOUT_LINE_LIMIT)}...` : line
            ),
            exitCode: this.exitCode,
            exitSignal: this.exitSignal,
        };
    }
}

function summarizeModels(result: unknown): unknown {
    if (
        !result ||
        typeof result !== "object" ||
        !("data" in result) ||
        !Array.isArray(result.data)
    ) {
        return result;
    }

    const models = result.data
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : null,
            supportsPersonality:
                typeof entry.supportsPersonality === "boolean" ? entry.supportsPersonality : null,
            defaultReasoningEffort:
                typeof entry.defaultReasoningEffort === "string"
                    ? entry.defaultReasoningEffort
                    : null,
            isDefault: typeof entry.isDefault === "boolean" ? entry.isDefault : null,
        }));

    return {
        count: models.length,
        ids: models.map((model) => model.id),
        defaultModel: models.find((model) => model.isDefault) ?? null,
    };
}

function extractThreadId(result: unknown): string | null {
    if (!result || typeof result !== "object" || !("thread" in result)) {
        return null;
    }

    const thread = result.thread;
    if (!thread || typeof thread !== "object" || !("id" in thread)) {
        return null;
    }

    return typeof thread.id === "string" ? thread.id : String(thread.id);
}

function extractAccountType(result: unknown): string | null {
    if (!result || typeof result !== "object" || !("account" in result)) {
        return null;
    }

    const account = result.account;
    if (!account || typeof account !== "object" || !("type" in account)) {
        return null;
    }

    return typeof account.type === "string" ? account.type : String(account.type);
}

async function probeRawAppServer() {
    const client = new RawJsonRpcClient();

    try {
        const initialize = await client.sendRequest("initialize", {
            clientInfo: {
                name: "copilot_sdk_codex_probe",
                title: "Copilot SDK Codex Probe",
                version: "0.0.0",
            },
            capabilities: null,
        });
        if (initialize.error) {
            throw coerceError(initialize.error, "initialize failed");
        }

        client.sendNotification("initialized", {});

        const copilotRpcMethods = [
            "ping",
            "status.get",
            "auth.getStatus",
            "models.list",
            "session.create",
            "session.resume",
        ] as const;
        const copilotRpcCompatibility = Object.fromEntries(
            await Promise.all(
                copilotRpcMethods.map(async (method) => {
                    const response = await client.sendRequest(method, {});
                    return [
                        method,
                        response.error ? { error: response.error } : { result: response.result },
                    ];
                })
            )
        );

        const account = await client.sendRequest("account/read", { refreshToken: false });
        const accountRefresh = await client.sendRequest("account/read", { refreshToken: true });
        const models = await client.sendRequest("model/list", { includeHidden: false, limit: 20 });
        const thread = await client.sendRequest("thread/start", {
            cwd: TURN_CWD,
            approvalPolicy: TURN_APPROVAL_POLICY,
            ephemeral: true,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
        });

        const report: Record<string, unknown> = {
            initialize: initialize.result,
            copilotRpcCompatibility,
            account: account.error ? { error: account.error } : account.result,
            accountRefresh: accountRefresh.error
                ? { error: accountRefresh.error }
                : accountRefresh.result,
            models: models.error ? { error: models.error } : summarizeModels(models.result),
            thread: thread.error ? { error: thread.error } : thread.result,
        };

        const threadStarted = await client
            .waitForNotification("thread/started", 3_000)
            .catch((error) => ({
                method: "thread/started",
                params: { error: serializeError(error) },
            }));
        report.threadStartedNotification = threadStarted;

        const threadId = extractThreadId(thread.result);
        const accountType = extractAccountType(account.result);

        if (accountType === "chatgpt") {
            const rateLimits = await client.sendRequest("account/rateLimits/read", {});
            report.rateLimits = rateLimits.error ? { error: rateLimits.error } : rateLimits.result;
        }

        if (RUN_TURN && threadId) {
            try {
                const turn = await client.sendRequest("turn/start", {
                    threadId,
                    input: [
                        {
                            type: "text",
                            text: TURN_PROMPT,
                            text_elements: [],
                        },
                    ],
                    approvalPolicy: TURN_APPROVAL_POLICY,
                    sandboxPolicy: {
                        type: TURN_SANDBOX_MODE,
                        access: { type: "fullAccess" },
                        networkAccess: TURN_NETWORK_ACCESS,
                    },
                });

                report.turn = turn.error ? { error: turn.error } : turn.result;

                if (!turn.error) {
                    const turnCompleted = await client
                        .waitForNotification("turn/completed", TURN_TIMEOUT_MS)
                        .catch((error) => ({
                            method: "turn/completed",
                            params: { error: serializeError(error) },
                        }));
                    report.turnCompletedNotification = turnCompleted;
                }
            } catch (error) {
                report.turnRequestError = serializeError(error);
                await delay(TURN_POST_ERROR_WAIT_MS);
            }
        }

        report.transport = client.summary();
        return report;
    } finally {
        await client.shutdown();
    }
}

async function main() {
    const copilotSdkCompatibility = await probeCopilotClientCompatibility();
    const rawAppServer = await probeRawAppServer();

    const report = {
        binary: CODEX_BIN,
        binaryArgs: CODEX_ARGS,
        probeCodexHome: PROBE_CODEX_HOME,
        strippedOpenAiApiKey: process.env.OPENAI_API_KEY !== undefined,
        runTurn: RUN_TURN,
        cwd: TURN_CWD,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        turnPostErrorWaitMs: TURN_POST_ERROR_WAIT_MS,
        autoApproveCommandRequests: AUTO_APPROVE_COMMAND_REQUESTS,
        commandApprovalResponseOverride: COMMAND_APPROVAL_RESPONSE_OVERRIDE,
        turnPrompt: TURN_PROMPT,
        turnApprovalPolicy: TURN_APPROVAL_POLICY,
        turnSandboxMode: TURN_SANDBOX_MODE,
        turnNetworkAccess: TURN_NETWORK_ACCESS,
        copilotSdkCompatibility,
        rawAppServer,
    };

    console.log(JSON.stringify(report, null, 2));
}

await main();
