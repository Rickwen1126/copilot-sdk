import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { RuntimeConnection, type CopilotClientOptions } from "../types.js";
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
import { CodexAppServerGateway } from "./codexAppServerGateway.js";
import type {
    JsonRpcError,
    JsonRpcId,
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
} from "./codexAppServerGateway.js";
import {
    CodexAdapterSessionStore,
    type CodexRuntimeSessionRecord,
} from "./codexAdapterSessionStore.js";
import {
    planDynamicToolCallRouting,
    type DynamicToolCallRoutingPlan,
} from "./codexAdapterToolPolicy.js";

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

type CodexRuntimeGateway = {
    start(): Promise<void>;
    stop(): Promise<void>;
    request(method: string, params?: unknown): Promise<JsonRpcResponse>;
    notify(method: string, params?: unknown): void;
    respond(id: JsonRpcId, result?: unknown, error?: JsonRpcError): void;
    onNotification(handler: (notification: JsonRpcNotification) => void): () => void;
    onRequest(handler: (request: JsonRpcRequest) => void): () => void;
    summary(): unknown;
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
    transcriptLimit?: number;
    runtimeSessionStorePath?: string;
    fallbackWorkspaceParent?: string;
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
    timeout: ReturnType<typeof setTimeout>;
};

type PendingPermissionRequest = {
    codexRequestId: JsonRpcId;
    sessionId: string;
    /** Codex approval method that triggered this request. */
    codexMethod: string;
    /** Raw codex request params, needed by the command decision mapper. */
    codexParams: Record<string, unknown>;
    timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_TRANSCRIPT_LIMIT = 500;
const DEFAULT_FALLBACK_WORKSPACE_PARENT = join(tmpdir(), "copilot-codex-adapter-workspaces");

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
        { id: "session.delete", status: "supported" },
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function hasToolDescriptor(session: SessionState, toolName: string): boolean {
    return session.tools.some((tool) => tool.name === toolName);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function toolFingerprintFromDescriptors(tools: ToolDescriptor[]): string {
    const normalized = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        skipPermission: tool.skipPermission === true,
    }));
    return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

const EMPTY_TOOL_FINGERPRINT = toolFingerprintFromDescriptors([]);

function hasResumeToolDescriptors(params: Record<string, unknown>): boolean {
    return Array.isArray(params.tools);
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

export class CodexCopilotAdapterServer {
    private server: Server = createServer();
    private sessions = new Map<string, SessionState>();
    private threadToSession = new Map<string, string>();
    private connections = new Map<string, MessageConnection>();
    private fileChangeSnapshots = new Map<string, unknown[]>();
    private pendingDynamicToolCalls = new Map<string, PendingDynamicToolCall>();
    private pendingPermissionRequests = new Map<string, PendingPermissionRequest>();
    private port = 0;
    private transcript: CodexAdapterTranscriptEntry[] = [];
    private codexUnsubscribe: (() => void) | null = null;
    private codexRequestUnsubscribe: (() => void) | null = null;
    private nextConnectionId = 1;
    private codex: CodexRuntimeGateway;
    private sessionStore: CodexAdapterSessionStore;
    private codexHomeIdentity?: string;
    private transcriptLimit: number;
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
            | "requestTimeoutMs"
            | "fallbackWorkspaceParent"
        >
    > &
        Pick<CodexAdapterOptions, "port">;

    constructor(options: CodexAdapterOptions = {}) {
        if (options.protocolVersion === 2) {
            throw new Error(
                "codex adapter protocolVersion 2 is not supported on SDK v1.0.7: " +
                    "the legacy direct tool.call request flow was removed from the SDK client " +
                    "(requests would fail with MethodNotFound). Use protocolVersion 3 (the default)."
            );
        }
        this.options = {
            host: options.host ?? DEFAULT_HOST,
            port: options.port,
            protocolVersion: options.protocolVersion ?? 3,
            model: options.model ?? DEFAULT_MODEL,
            approvalPolicy: options.approvalPolicy ?? "on-request",
            approvalsReviewer: options.approvalsReviewer ?? "auto_review",
            sandboxMode: options.sandboxMode ?? "workspaceWrite",
            networkAccess: options.networkAccess ?? false,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            fallbackWorkspaceParent:
                options.fallbackWorkspaceParent ?? DEFAULT_FALLBACK_WORKSPACE_PARENT,
        };
        this.transcriptLimit = options.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT;
        this.codex = new CodexAppServerGateway(options);
        this.sessionStore = new CodexAdapterSessionStore(options.runtimeSessionStorePath);
        this.codexHomeIdentity = options.codexHome;
    }

    private recordTranscript(entry: CodexAdapterTranscriptEntry) {
        this.transcript.push(entry);
        if (this.transcript.length > this.transcriptLimit) {
            this.transcript.splice(0, this.transcript.length - this.transcriptLimit);
        }
    }

    async start(): Promise<{ port: number; cliUrl: string; clientOptions: CopilotClientOptions }> {
        await this.codex.start();
        this.codexUnsubscribe = this.codex.onNotification((notification) => {
            this.recordTranscript({
                at: nowIso(),
                direction: "codex->adapter",
                message: notification,
            });
            this.handleCodexNotification(notification);
        });
        this.codexRequestUnsubscribe = this.codex.onRequest((request) => {
            this.recordTranscript({
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
        // v1.0.7 replaced `{ cliUrl, autoStart: false }` with the connection
        // field. `RuntimeConnection.forUri` is the connect-to-existing-server
        // transport (no process spawn), matching the old semantics exactly.
        return {
            connection: RuntimeConnection.forUri(this.cliUrl()),
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
        this.recordTranscript({
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
                this.recordTranscript({
                    at: nowIso(),
                    direction: "sdk->adapter.request",
                    message: { method, params },
                });
                try {
                    const result = await handler(params, connectionId);
                    this.recordTranscript({
                        at: nowIso(),
                        direction: "adapter->sdk.response",
                        message: { method, result },
                    });
                    return result;
                } catch (error) {
                    const rpcError = toJsonRpcError(error);
                    this.recordTranscript({
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
        registerHandler("session.delete", (params) => this.handleSessionDelete(params));
        registerHandler("session.tools.handlePendingToolCall", (params) =>
            this.handlePendingToolCall(params)
        );
        registerHandler("session.permissions.handlePendingPermissionRequest", (params) =>
            this.handlePendingPermissionRequest(params)
        );

        socket.on("close", () => {
            this.connections.delete(connectionId);
            this.detachConnection(connectionId);
            this.recordTranscript({
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
            this.recordTranscript({
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
        this.recordTranscript({
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

    private sessionCreateCwd(params: Record<string, unknown>): string {
        if (typeof params.workingDirectory === "string" && params.workingDirectory.trim()) {
            return params.workingDirectory;
        }

        const workspace = join(this.options.fallbackWorkspaceParent, randomUUID());
        mkdirSync(this.options.fallbackWorkspaceParent, { recursive: true });
        mkdirSync(workspace);
        return workspace;
    }

    private recordConcurrentWorkspaceThreads(
        session: SessionState,
        operation: "create" | "resume"
    ) {
        const overlappingSessions = [...this.sessions.values()]
            .filter(
                (other) =>
                    other.sessionId !== session.sessionId &&
                    other.threadId !== session.threadId &&
                    other.cwd === session.cwd
            )
            .map((other) => ({
                sessionId: other.sessionId,
                threadId: other.threadId,
                attachedConnectionCount: other.attachedConnectionIds.size,
            }));

        if (overlappingSessions.length === 0) {
            return;
        }

        this.recordTranscript({
            at: nowIso(),
            direction: "adapter.workspace.concurrent_threads",
            message: {
                operation,
                cwd: session.cwd,
                sessionId: session.sessionId,
                threadId: session.threadId,
                overlappingSessions,
            },
        });
    }

    private async handleSessionCreate(params: unknown, connectionId: string) {
        if (!isRecord(params)) {
            throw new Error("session.create params missing");
        }

        const sessionId = typeof params.sessionId === "string" ? params.sessionId : randomUUID();
        const cwd = this.sessionCreateCwd(params);
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
            ephemeral: false,
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
        this.sessionStore.upsert(this.sessionRecordFromSession(session, createdAt));
        this.recordConcurrentWorkspaceThreads(session, "create");

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

        const resumeHasTools = hasResumeToolDescriptors(params);
        const resumeTools = resumeHasTools ? toolDescriptorsFromSessionCreateParams(params) : null;
        let session = this.sessions.get(sessionId);
        if (!session) {
            const record = this.sessionStore.get(sessionId);
            if (!record) {
                throw new Error(`Unknown session: ${sessionId}`);
            }
            if (!resumeTools && record.toolFingerprint !== EMPTY_TOOL_FINGERPRINT) {
                throw new Error(
                    `Cannot resume session ${sessionId}: matching tools are required after adapter restart`
                );
            }
            if (
                resumeTools &&
                toolFingerprintFromDescriptors(resumeTools) !== record.toolFingerprint
            ) {
                throw new Error(
                    `Cannot resume session ${sessionId}: tool set is incompatible with the persisted runtime session`
                );
            }
            session = this.sessionFromRecord(record, params, resumeTools ?? []);
            this.sessions.set(session.sessionId, session);
        } else if (
            resumeTools &&
            toolFingerprintFromDescriptors(resumeTools) !==
                toolFingerprintFromDescriptors(session.tools)
        ) {
            throw new Error(
                `Cannot resume session ${sessionId}: tool set is incompatible with the active runtime session`
            );
        }

        const alreadyInUse = session.attachedConnectionIds.size > 0;
        const eventCount = session.events.length;
        session.attachedConnectionIds.add(connectionId);
        session.cwd =
            typeof params.workingDirectory === "string" ? params.workingDirectory : session.cwd;
        session.model = typeof params.model === "string" ? params.model : session.model;
        session.resumeCount += 1;
        this.threadToSession.set(session.threadId, session.sessionId);

        const resumeResponse = await this.codex.request("thread/resume", {
            threadId: session.threadId,
            cwd: session.cwd,
            approvalPolicy: this.options.approvalPolicy,
            approvalsReviewer: this.options.approvalsReviewer,
            sandbox: codexThreadSandboxMode(this.options.sandboxMode),
            initialTurnsPage: {
                limit: 50,
                sortDirection: "desc",
                itemsView: "summary",
            },
        });
        if (resumeResponse.error) {
            throw resumeResponse.error;
        }
        this.sessionStore.upsert(this.sessionRecordFromSession(session, nowIso()));
        this.recordConcurrentWorkspaceThreads(session, "resume");

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

    private async handleSessionDestroy(params: unknown, connectionId: string) {
        const sessionId =
            isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.attachedConnectionIds.delete(connectionId);
                if (
                    session.attachedConnectionIds.size === 0 &&
                    this.threadToSession.has(session.threadId)
                ) {
                    const unsubscribeResponse = await this.codex.request("thread/unsubscribe", {
                        threadId: session.threadId,
                    });
                    if (unsubscribeResponse.error) {
                        this.recordTranscript({
                            at: nowIso(),
                            direction: "adapter.session.destroy.unsubscribe.error",
                            message: {
                                sessionId,
                                threadId: session.threadId,
                                error: unsubscribeResponse.error,
                            },
                        });
                    }
                    this.threadToSession.delete(session.threadId);
                }
            }
        }
        return { success: true };
    }

    private async handleSessionDelete(params: unknown) {
        const sessionId =
            isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (!sessionId) {
            return { success: false, error: "session.delete requires sessionId" };
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: `Unknown session: ${sessionId}` };
        }

        const archiveResponse = await this.codex.request("thread/archive", {
            threadId: session.threadId,
        });
        if (archiveResponse.error) {
            return { success: false, error: archiveResponse.error.message };
        }

        this.emitLifecycle("session.deleted", sessionId, {
            deleteTime: nowIso(),
        });
        this.sessions.delete(sessionId);
        this.threadToSession.delete(session.threadId);
        this.sessionStore.delete(sessionId);
        this.deletePendingToolCallsForSession(sessionId);

        return { success: true };
    }

    private deletePendingToolCallsForSession(sessionId: string) {
        for (const [requestId, pending] of this.pendingDynamicToolCalls.entries()) {
            if (pending.sessionId === sessionId) {
                clearTimeout(pending.timeout);
                this.pendingDynamicToolCalls.delete(requestId);
            }
        }
    }

    private sessionRecordFromSession(
        session: SessionState,
        updatedAt: string
    ): CodexRuntimeSessionRecord {
        return {
            sdkSessionId: session.sessionId,
            runtime: "codex",
            runtimeSessionId: session.threadId,
            codexThreadId: session.threadId,
            cwd: session.cwd,
            model: session.model,
            toolFingerprint: toolFingerprintFromDescriptors(session.tools),
            codexHomeIdentity: this.codexHomeIdentity,
            createdAt: session.createdAt,
            updatedAt,
        };
    }

    private sessionFromRecord(
        record: CodexRuntimeSessionRecord,
        params: Record<string, unknown>,
        tools: ToolDescriptor[]
    ): SessionState {
        return {
            sessionId: record.sdkSessionId,
            threadId: record.runtimeSessionId,
            createdAt: record.createdAt,
            cwd: typeof params.workingDirectory === "string" ? params.workingDirectory : record.cwd,
            model: typeof params.model === "string" ? params.model : record.model,
            tools,
            lastEventId: null,
            events: [],
            attachedConnectionIds: new Set(),
            resumeCount: 0,
        };
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
        clearTimeout(pending.timeout);
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

        this.recordTranscript({
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

        // v1.0.7 removed the client-side handler for direct `permission.request`
        // requests. Delivery now mirrors the runtime: broadcast an ephemeral
        // `permission.requested` session event and wait for the client to answer
        // via the served `session.permissions.handlePendingPermissionRequest` RPC.
        const requestId = randomUUID();
        const timeout = setTimeout(() => {
            const pending = this.pendingPermissionRequests.get(requestId);
            if (!pending) {
                return;
            }
            this.pendingPermissionRequests.delete(requestId);
            this.codex.respond(pending.codexRequestId, { decision: "decline" });
            this.recordTranscript({
                at: nowIso(),
                direction: "adapter.permission.timeout",
                message: {
                    requestId,
                    sessionId: pending.sessionId,
                    codexMethod: pending.codexMethod,
                },
            });
        }, this.options.requestTimeoutMs);
        this.pendingPermissionRequests.set(requestId, {
            codexRequestId: request.id,
            sessionId: session.sessionId,
            codexMethod: request.method,
            codexParams: params,
            timeout,
        });

        this.recordTranscript({
            at: nowIso(),
            direction: "adapter->sdk.event",
            message: {
                method: "permission.requested",
                params: {
                    sessionId: session.sessionId,
                    requestId,
                    permissionRequest,
                },
            },
        });
        this.emitSessionEvent(
            session.sessionId,
            createSessionEvent(
                session,
                "permission.requested",
                {
                    requestId,
                    permissionRequest,
                },
                true
            )
        );
    }

    private handlePendingPermissionRequest(params: unknown) {
        if (!isRecord(params)) {
            throw new Error("session.permissions.handlePendingPermissionRequest params missing");
        }

        const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
        if (!requestId) {
            throw new Error("session.permissions.handlePendingPermissionRequest requires requestId");
        }

        const pending = this.pendingPermissionRequests.get(requestId);
        if (!pending) {
            return { success: false };
        }
        clearTimeout(pending.timeout);
        this.pendingPermissionRequests.delete(requestId);

        const decision =
            pending.codexMethod === "item/fileChange/requestApproval"
                ? mapPermissionResultToCodexFileChangeDecision(params.result)
                : mapPermissionResultToCodexCommandDecision(params.result, pending.codexParams);
        this.codex.respond(pending.codexRequestId, { decision });

        this.recordTranscript({
            at: nowIso(),
            direction: "adapter.permission.completed",
            message: {
                requestId,
                sessionId: pending.sessionId,
                codexMethod: pending.codexMethod,
                decision,
            },
        });
        return { success: true };
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

        const routingPlan = planDynamicToolCallRouting({
            protocolVersion: this.options.protocolVersion,
            sessionId: session.sessionId,
            toolCallId,
            toolName,
            argumentsPayload: params.arguments,
        });

        if (routingPlan.mode === "protocol-v2-sdk-request") {
            return this.handleCodexDynamicToolCallV2(
                request,
                primaryConnection,
                routingPlan.toolCallParams
            );
        }

        const sdkRequestId = routingPlan.sdkRequestId;
        const timeout = setTimeout(() => {
            const pending = this.pendingDynamicToolCalls.get(sdkRequestId);
            if (!pending) {
                return;
            }
            this.pendingDynamicToolCalls.delete(sdkRequestId);
            this.codex.respond(
                pending.codexRequestId,
                mapSdkToolResultToCodexDynamicToolResponse(
                    undefined,
                    `Timed out waiting for SDK tool result: ${pending.toolName}`
                )
            );
            this.recordTranscript({
                at: nowIso(),
                direction: "adapter.tool.timeout",
                message: {
                    requestId: sdkRequestId,
                    sessionId: pending.sessionId,
                    toolName: pending.toolName,
                    toolCallId: pending.toolCallId,
                },
            });
        }, this.options.requestTimeoutMs);
        this.pendingDynamicToolCalls.set(sdkRequestId, {
            codexRequestId: request.id,
            sessionId: session.sessionId,
            toolCallId,
            toolName,
            timeout,
        });

        this.emitSessionEvent(
            session.sessionId,
            createSessionEvent(
                session,
                "external_tool.requested",
                routingPlan.eventData,
                routingPlan.ephemeral
            )
        );
    }

    private async handleCodexDynamicToolCallV2(
        request: JsonRpcRequest,
        primaryConnection: { connectionId: string; connection: MessageConnection },
        toolCallParams: Extract<
            DynamicToolCallRoutingPlan,
            { mode: "protocol-v2-sdk-request" }
        >["toolCallParams"]
    ): Promise<void> {
        this.recordTranscript({
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
            this.recordTranscript({
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
            this.recordTranscript({
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
