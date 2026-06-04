import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { CopilotClient, approveAll, defineTool } from "../dist/index.js";
import {
    CodexCopilotAdapterServer,
    type CodexAdapterSandboxMode,
} from "../src/experimental/codexAdapter.js";

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

type TranscriptEntry = {
    at: string;
    direction: string;
    message: unknown;
};

type LedgerBackend = "copilot-cli" | "codex-adapter";
type LedgerEndpoint = "sdk" | "adapter" | "codex" | "copilot" | "unknown";
type LedgerDirection = "request" | "response" | "notification" | "event" | "connection" | "log";
type LedgerStatus = "ok" | "denied" | "error" | "timeout";

type NormalizedLedgerEntry = {
    runId: string;
    backend: LedgerBackend;
    sessionId?: string;
    turnId?: string;
    requestId?: string;
    source: LedgerEndpoint;
    target: LedgerEndpoint;
    method: string;
    direction: LedgerDirection;
    payloadShape: unknown;
    sanitizedPayload: unknown;
    resultShape?: unknown;
    timestamp: string;
    durationMs?: number;
    status: LedgerStatus;
};

type ConformanceStatus = "pass" | "fail" | "not-run";

type ConformanceCheck = {
    capability: string;
    profile: "SDK Core Profile" | "Coding Agent Profile";
    status: ConformanceStatus;
    backendStatus: {
        copilotCli: ConformanceStatus;
        codexAdapter: ConformanceStatus;
    };
    traceParity: ConformanceStatus;
    dataAssertion: ConformanceStatus;
    intentAssertion: ConformanceStatus;
    evidence: string[];
    missing: string[];
};

type ConformanceReport = {
    runId: string;
    generatedAt: string;
    targetProfiles: string[];
    verdict: ConformanceStatus;
    checks: ConformanceCheck[];
    ledgerCounts: {
        copilotCli: number;
        codexAdapter: number;
    };
    ledgers: {
        copilotCli: NormalizedLedgerEntry[];
        codexAdapter: NormalizedLedgerEntry[];
    };
    unsupportedProfiles: string[];
};

type PendingRequest = {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
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

const SPIKE_PHASE = process.env.SPIKE_PHASE ?? "all";
const PROMPT = process.env.SPIKE_PROMPT ?? "Reply with READY and nothing else.";
const RESUME_PROMPT =
    process.env.SPIKE_RESUME_PROMPT ??
    "Reply by repeating your previous answer exactly twice, with no separator and nothing else.";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.4";
const PROTOCOL_TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 45_000);
const OUTPUT_PATH = process.env.SPIKE_OUT;
const ADAPTER_APPROVAL_POLICY = process.env.SPIKE_ADAPTER_APPROVAL_POLICY ?? "never";
const ADAPTER_APPROVALS_REVIEWER = process.env.SPIKE_ADAPTER_APPROVALS_REVIEWER ?? "user";
const ADAPTER_SANDBOX_MODE = process.env.SPIKE_ADAPTER_SANDBOX_MODE ?? "readOnly";
const ADAPTER_NETWORK_ACCESS = process.env.SPIKE_ADAPTER_NETWORK_ACCESS === "1";
const APPROVAL_PROBE_BASE_PATH = process.env.SPIKE_APPROVAL_PROBE_PATH;
const RUN_FILE_PROBE = process.env.SPIKE_FILE_PROBE === "1";
const RUN_TOOL_PROBE = process.env.SPIKE_TOOL_PROBE === "1";
const RUN_TOOL_FAILURE_PROBE = process.env.SPIKE_TOOL_FAILURE_PROBE === "1";
const WORKDIR = process.env.SPIKE_WORKDIR ?? process.cwd();
const CODEX_BIN = resolveBinary("codex");
const RUN_ID = process.env.SPIKE_RUN_ID ?? randomUUID();
const FILE_APPROVE_CONTENT = "file-approval-hello\n";
const FILE_DENY_CONTENT = "file-approval-denied\n";
const TOOL_PROBE_NAME = "lookup_runtime_fact";
const TOOL_PROBE_TOPIC = "codex-adapter";
const TOOL_PROBE_RESULT = "CUSTOM_TOOL_BRIDGE_OK_7F3A";
const TOOL_FAILURE_NAME = "fail_runtime_fact";
const TOOL_FAILURE_ERROR = "CUSTOM_TOOL_FAILURE_EXPECTED_8C2B";
const TOOL_DENIED_NAME = "deny_runtime_fact";
const TOOL_DENIED_RESULT = "CUSTOM_TOOL_DENIED_EXPECTED_4D91";

mkdirSync(WORKDIR, { recursive: true });

type ApprovalProbeBackend = "copilot-cli" | "codex-adapter";

type ApprovalProbeResult = {
    path: string;
    prompt: string;
    assistantMessage?: string;
    permissionRequests: unknown[];
    permissionRequestKinds: string[];
    permissionAssertionFailures: string[];
    preExisting: boolean;
    exists: boolean;
    contents?: string;
};

type ToolDescriptor = {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    skipPermission?: boolean;
};

type ToolHandlerCall = {
    args: unknown;
    invocation: unknown;
    result?: string;
    error?: string;
};

type ToolProbeResult = {
    prompt: string;
    toolName: string;
    expectedTopic: string;
    expectedResult: string;
    assistantMessage?: string;
    handlerCalls: ToolHandlerCall[];
    assertionFailures: string[];
};

type ToolFailureProbeResult = {
    failurePrompt: string;
    deniedPrompt: string;
    expectedTopic: string;
    failureToolName: string;
    deniedToolName: string;
    expectedFailureError: string;
    expectedDeniedResult: string;
    failureAssistantMessage?: string;
    deniedAssistantMessage?: string;
    failureHandlerCalls: ToolHandlerCall[];
    deniedHandlerCalls: ToolHandlerCall[];
    assertionFailures: string[];
};

type PendingDynamicToolCall = {
    codexRequestId: JsonRpcId;
    sessionId: string;
    toolCallId: string;
    toolName: string;
};

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
    if (error && typeof error === "object" && "code" in error && "message" in error) {
        const candidate = error as { code?: unknown; message?: unknown; data?: unknown };
        if (typeof candidate.code === "number" && typeof candidate.message === "string") {
            return {
                code: candidate.code,
                message: candidate.message,
                data: candidate.data,
            };
        }
    }

    const summarized = summarizeUnknownError(error);
    return {
        code: fallbackCode,
        message: summarized.message,
        data: summarized.stack,
    };
}

function prepareProbeCodexHome(): string {
    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const probeHome = mkdtempSync(join(tmpdir(), "copilot-codex-adapter-"));

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

function createCodexEnv(codexHome: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    env.CODEX_HOME = codexHome;
    return env;
}

function isResponse(message: unknown): message is JsonRpcResponse {
    return typeof message === "object" && !!message && "id" in message && !("method" in message);
}

function isRequest(message: unknown): message is JsonRpcRequest {
    return (
        typeof message === "object" &&
        !!message &&
        "id" in message &&
        "method" in message &&
        !("result" in message) &&
        !("error" in message)
    );
}

function isNotification(message: unknown): message is JsonRpcNotification {
    return typeof message === "object" && !!message && "method" in message && !("id" in message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function describeShape(value: unknown, depth = 0): unknown {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return depth >= 2
            ? `array(${value.length})`
            : value.slice(0, 3).map((item) => describeShape(item, depth + 1));
    }
    if (typeof value !== "object") {
        return typeof value;
    }
    if (depth >= 2) {
        return "object";
    }

    const shape: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        shape[key] = describeShape(entry, depth + 1);
    }
    return shape;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function nestedRecord(
    record: Record<string, unknown>,
    key: string
): Record<string, unknown> | undefined {
    const value = record[key];
    return isRecord(value) ? value : undefined;
}

function extractParams(message: unknown): Record<string, unknown> | undefined {
    if (!isRecord(message)) {
        return undefined;
    }
    const params = nestedRecord(message, "params");
    if (params) {
        return params;
    }
    const nestedMessage = nestedRecord(message, "message");
    if (nestedMessage) {
        return extractParams(nestedMessage);
    }
    return undefined;
}

function extractMethod(message: unknown, fallback: string): string {
    if (!isRecord(message)) {
        return fallback;
    }
    const direct = stringField(message, "method");
    if (direct) {
        return direct;
    }
    const nestedMessage = nestedRecord(message, "message");
    if (nestedMessage) {
        return extractMethod(nestedMessage, fallback);
    }
    const event = nestedRecord(message, "event");
    const eventType = event ? stringField(event, "type") : undefined;
    if (eventType) {
        return eventType;
    }
    const type = stringField(message, "type");
    return type ?? fallback;
}

function extractRequestId(message: unknown): string | undefined {
    if (!isRecord(message)) {
        return undefined;
    }
    const id = message.id;
    if (typeof id === "string" || typeof id === "number") {
        return String(id);
    }
    const requestId = stringField(message, "requestId");
    if (requestId) {
        return requestId;
    }
    const params = nestedRecord(message, "params");
    if (params) {
        const fromParams = extractRequestId(params);
        if (fromParams) {
            return fromParams;
        }
    }
    const nestedMessage = nestedRecord(message, "message");
    return nestedMessage ? extractRequestId(nestedMessage) : undefined;
}

function extractSessionId(message: unknown): string | undefined {
    if (!isRecord(message)) {
        return undefined;
    }
    const sessionId = stringField(message, "sessionId");
    if (sessionId) {
        return sessionId;
    }
    const params = nestedRecord(message, "params");
    if (params) {
        const fromParams = extractSessionId(params);
        if (fromParams) {
            return fromParams;
        }
    }
    const result = nestedRecord(message, "result");
    if (result) {
        const fromResult = extractSessionId(result);
        if (fromResult) {
            return fromResult;
        }
    }
    const nestedMessage = nestedRecord(message, "message");
    return nestedMessage ? extractSessionId(nestedMessage) : undefined;
}

function extractTurnId(message: unknown): string | undefined {
    if (!isRecord(message)) {
        return undefined;
    }
    const threadId = stringField(message, "threadId");
    if (threadId) {
        return threadId;
    }
    const turn = nestedRecord(message, "turn");
    const turnId = turn ? stringField(turn, "id") : undefined;
    if (turnId) {
        return turnId;
    }
    const params = nestedRecord(message, "params");
    if (params) {
        const fromParams = extractTurnId(params);
        if (fromParams) {
            return fromParams;
        }
    }
    const nestedMessage = nestedRecord(message, "message");
    return nestedMessage ? extractTurnId(nestedMessage) : undefined;
}

function sanitizePayload(message: unknown): unknown {
    if (typeof message === "string") {
        return {
            type: "string",
            length: message.length,
            sha256: hashString(message),
        };
    }
    if (!isRecord(message)) {
        return message === undefined ? undefined : describeShape(message);
    }

    const params = extractParams(message);
    const event = params && isRecord(params.event) ? params.event : nestedRecord(message, "event");
    const item = params && isRecord(params.item) ? params.item : undefined;
    const turn = params && isRecord(params.turn) ? params.turn : undefined;
    const permissionRequest = params ? nestedRecord(params, "permissionRequest") : undefined;

    return {
        id: extractRequestId(message),
        method: extractMethod(message, "unknown"),
        sessionId: extractSessionId(message),
        threadId: extractTurnId(message),
        eventType: event ? stringField(event, "type") : undefined,
        itemType: item ? stringField(item, "type") : undefined,
        turnStatus: turn ? stringField(turn, "status") : undefined,
        permissionKind: permissionRequest ? stringField(permissionRequest, "kind") : undefined,
        hasResult: "result" in message,
        hasError: "error" in message,
        shape: describeShape(message),
    };
}

function directionKindFromLabel(direction: string): LedgerDirection | undefined {
    if (direction.includes(".request")) {
        return "request";
    }
    if (direction.includes(".response")) {
        return "response";
    }
    if (direction.includes(".notification")) {
        return "notification";
    }
    return undefined;
}

function inferDirectionFromMessage(
    direction: string,
    message: unknown,
    fallback: LedgerDirection
): LedgerDirection {
    const fromLabel = directionKindFromLabel(direction);
    if (fromLabel) {
        return fromLabel;
    }
    if (!isRecord(message)) {
        return fallback;
    }
    if ("result" in message || "error" in message || "response" in message) {
        return "response";
    }
    if ("id" in message && typeof message.method === "string") {
        return "request";
    }
    if (typeof message.method === "string") {
        return "notification";
    }
    return fallback;
}

function directionEndpoints(
    direction: string,
    message: unknown
): {
    source: LedgerEndpoint;
    target: LedgerEndpoint;
    direction: LedgerDirection;
} {
    if (direction.includes("sdk->copilot")) {
        return {
            source: "sdk",
            target: "copilot",
            direction: inferDirectionFromMessage(direction, message, "request"),
        };
    }
    if (direction.includes("copilot->sdk")) {
        return {
            source: "copilot",
            target: "sdk",
            direction: inferDirectionFromMessage(direction, message, "response"),
        };
    }
    if (direction.includes("sdk->adapter")) {
        return {
            source: "sdk",
            target: "adapter",
            direction: inferDirectionFromMessage(direction, message, "request"),
        };
    }
    if (direction.includes("adapter->sdk")) {
        return {
            source: "adapter",
            target: "sdk",
            direction: inferDirectionFromMessage(direction, message, "response"),
        };
    }
    if (direction.includes("adapter->codex")) {
        return {
            source: "adapter",
            target: "codex",
            direction: inferDirectionFromMessage(direction, message, "request"),
        };
    }
    if (direction.includes("codex->adapter")) {
        return {
            source: "codex",
            target: "adapter",
            direction: inferDirectionFromMessage(direction, message, "notification"),
        };
    }
    if (direction.includes("connection")) {
        return { source: "adapter", target: "sdk", direction: "connection" };
    }
    if (direction.includes("stderr")) {
        return { source: "codex", target: "adapter", direction: "log" };
    }
    return { source: "unknown", target: "unknown", direction: "event" };
}

function normalizeTranscript(
    runId: string,
    backend: LedgerBackend,
    entries: TranscriptEntry[]
): NormalizedLedgerEntry[] {
    return entries.map((entry) => {
        const endpoints = directionEndpoints(entry.direction, entry.message);
        const method = extractMethod(entry.message, entry.direction);
        const hasError =
            isRecord(entry.message) &&
            ("error" in entry.message ||
                (isRecord(entry.message.message) && "error" in entry.message.message));
        const status: LedgerStatus = hasError ? "error" : "ok";
        return {
            runId,
            backend,
            sessionId: extractSessionId(entry.message),
            turnId: extractTurnId(entry.message),
            requestId: extractRequestId(entry.message),
            source: endpoints.source,
            target: endpoints.target,
            method,
            direction: endpoints.direction,
            payloadShape: describeShape(entry.message),
            sanitizedPayload: sanitizePayload(entry.message),
            resultShape:
                isRecord(entry.message) && "result" in entry.message
                    ? describeShape(entry.message.result)
                    : undefined,
            timestamp: entry.at,
            status,
        };
    });
}

function coerceTranscriptEntries(value: unknown): TranscriptEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is TranscriptEntry => {
        return (
            isRecord(entry) &&
            typeof entry.at === "string" &&
            typeof entry.direction === "string" &&
            "message" in entry
        );
    });
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function hasLedgerHop(
    ledger: NormalizedLedgerEntry[],
    expected: {
        source?: LedgerEndpoint;
        target?: LedgerEndpoint;
        method: string;
        direction?: LedgerDirection;
    }
): boolean {
    return ledger.some((entry) => {
        return (
            entry.method === expected.method &&
            (expected.source === undefined || entry.source === expected.source) &&
            (expected.target === undefined || entry.target === expected.target) &&
            (expected.direction === undefined || entry.direction === expected.direction)
        );
    });
}

function countLedgerHops(
    ledger: NormalizedLedgerEntry[],
    expected: {
        source?: LedgerEndpoint;
        target?: LedgerEndpoint;
        method: string;
        direction?: LedgerDirection;
    }
): number {
    return ledger.filter((entry) => {
        return (
            entry.method === expected.method &&
            (expected.source === undefined || entry.source === expected.source) &&
            (expected.target === undefined || entry.target === expected.target) &&
            (expected.direction === undefined || entry.direction === expected.direction)
        );
    }).length;
}

function getNestedString(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    if (!record) {
        return undefined;
    }
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function getNestedBoolean(record: Record<string, unknown> | undefined, key: string): boolean {
    if (!record) {
        return false;
    }
    return record[key] === true;
}

function getNestedRecord(
    record: Record<string, unknown> | undefined,
    key: string
): Record<string, unknown> | undefined {
    return record ? nestedRecord(record, key) : undefined;
}

function approvalProbePathForBackend(backend: ApprovalProbeBackend): string | undefined {
    if (!APPROVAL_PROBE_BASE_PATH) {
        return undefined;
    }
    if (SPIKE_PHASE === "all") {
        return `${APPROVAL_PROBE_BASE_PATH}.${backend}`;
    }
    return APPROVAL_PROBE_BASE_PATH;
}

function denialProbePathForBackend(backend: ApprovalProbeBackend): string | undefined {
    if (!APPROVAL_PROBE_BASE_PATH) {
        return undefined;
    }
    if (SPIKE_PHASE === "all") {
        return `${APPROVAL_PROBE_BASE_PATH}.deny.${backend}`;
    }
    return `${APPROVAL_PROBE_BASE_PATH}.deny`;
}

function fileProbeNameForBackend(backend: ApprovalProbeBackend): string | undefined {
    if (!RUN_FILE_PROBE) {
        return undefined;
    }
    if (SPIKE_PHASE === "all") {
        return `codex-file-approval-${RUN_ID}.${backend}.txt`;
    }
    return `codex-file-approval-${RUN_ID}.txt`;
}

function fileDenyProbeNameForBackend(backend: ApprovalProbeBackend): string | undefined {
    if (!RUN_FILE_PROBE) {
        return undefined;
    }
    if (SPIKE_PHASE === "all") {
        return `codex-file-approval-${RUN_ID}.deny.${backend}.txt`;
    }
    return `codex-file-approval-${RUN_ID}.deny.txt`;
}

function fileProbePath(fileName: string | undefined): string | undefined {
    return fileName ? join(WORKDIR, fileName) : undefined;
}

function approvalProbePrompt(path: string): string {
    return `Use a shell command to write exactly hello to ${path}. The shell command should be: printf hello > ${path}. Do not use any other method.`;
}

function denialProbePrompt(path: string): string {
    return `Use a shell command to write exactly denied to ${path}. The shell command should be: printf denied > ${path}. Do not use any other method.`;
}

function fileApprovalProbePrompt(fileName: string): string {
    return [
        `Use the file editing tool, not a shell command, to create a file named ${fileName} in the current working directory.`,
        "The complete file contents must be exactly:",
        FILE_APPROVE_CONTENT,
        "Do not use shell commands.",
    ].join("\n");
}

function fileDenialProbePrompt(fileName: string): string {
    return [
        `Use the file editing tool, not a shell command, to create a file named ${fileName} in the current working directory.`,
        "The complete file contents must be exactly:",
        FILE_DENY_CONTENT,
        "Do not use shell commands.",
        "If the file edit is denied, do not retry and do not use another method; report that the edit was denied.",
    ].join("\n");
}

function toolProbePrompt(): string {
    return [
        `Call the custom tool ${TOOL_PROBE_NAME} exactly once with topic "${TOOL_PROBE_TOPIC}".`,
        "The tool returns a copy-sensitive token.",
        "After the tool returns, reply with the exact token and no extra prose.",
        "Do not transform casing, punctuation, spacing, or word order.",
    ].join("\n");
}

function toolFailurePrompt(): string {
    return [
        `Call the custom tool ${TOOL_FAILURE_NAME} exactly once with topic "${TOOL_PROBE_TOPIC}".`,
        "This tool is expected to fail.",
        "After the failure is reported, acknowledge that the tool failed.",
        "Do not retry and do not call any other tool.",
    ].join("\n");
}

function toolDeniedPrompt(): string {
    return [
        `Call the custom tool ${TOOL_DENIED_NAME} exactly once with topic "${TOOL_PROBE_TOPIC}".`,
        "This tool is expected to return a denied result.",
        "After the denial is reported, acknowledge that the tool was denied.",
        "Do not retry and do not call any other tool.",
    ].join("\n");
}

function validateToolHandlerCall(
    args: unknown,
    invocation: unknown,
    expectedToolName = TOOL_PROBE_NAME
): string[] {
    const failures: string[] = [];
    if (!isRecord(args)) {
        failures.push("tool args are not an object");
    } else if (args.topic !== TOOL_PROBE_TOPIC) {
        failures.push(`tool args.topic is ${String(args.topic)}, expected ${TOOL_PROBE_TOPIC}`);
    }

    if (!isRecord(invocation)) {
        failures.push("tool invocation metadata is not an object");
    } else {
        if (invocation.toolName !== expectedToolName) {
            failures.push(
                `tool invocation.toolName is ${String(invocation.toolName)}, expected ${expectedToolName}`
            );
        }
        if (typeof invocation.toolCallId !== "string" || invocation.toolCallId.length === 0) {
            failures.push("tool invocation.toolCallId is missing");
        }
        if (typeof invocation.sessionId !== "string" || invocation.sessionId.length === 0) {
            failures.push("tool invocation.sessionId is missing");
        }
    }

    return failures;
}

function createLookupRuntimeFactTool(handlerCalls: ToolHandlerCall[], assertionFailures: string[]) {
    return defineTool(TOOL_PROBE_NAME, {
        description: "Returns a deterministic copy-sensitive token for conformance testing.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    description: `Must be "${TOOL_PROBE_TOPIC}".`,
                },
            },
            required: ["topic"],
            additionalProperties: false,
        },
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(args, invocation);
            assertionFailures.push(...failures);
            const call: ToolHandlerCall = {
                args,
                invocation,
                result: failures.length === 0 ? TOOL_PROBE_RESULT : undefined,
                error: failures.length > 0 ? failures.join("; ") : undefined,
            };
            handlerCalls.push(call);
            if (failures.length > 0) {
                throw new Error(failures.join("; "));
            }
            return TOOL_PROBE_RESULT;
        },
    });
}

function createFailRuntimeFactTool(handlerCalls: ToolHandlerCall[], assertionFailures: string[]) {
    return defineTool(TOOL_FAILURE_NAME, {
        description: "Always throws a deterministic error for conformance testing.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    description: `Must be "${TOOL_PROBE_TOPIC}".`,
                },
            },
            required: ["topic"],
            additionalProperties: false,
        },
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(args, invocation, TOOL_FAILURE_NAME);
            assertionFailures.push(...failures);
            const error = failures.length > 0 ? failures.join("; ") : TOOL_FAILURE_ERROR;
            handlerCalls.push({
                args,
                invocation,
                error,
            });
            throw new Error(error);
        },
    });
}

function createDenyRuntimeFactTool(handlerCalls: ToolHandlerCall[], assertionFailures: string[]) {
    return defineTool(TOOL_DENIED_NAME, {
        description: "Returns a deterministic denied tool result for conformance testing.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    description: `Must be "${TOOL_PROBE_TOPIC}".`,
                },
            },
            required: ["topic"],
            additionalProperties: false,
        },
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(args, invocation, TOOL_DENIED_NAME);
            assertionFailures.push(...failures);
            const result = failures.length > 0 ? failures.join("; ") : TOOL_DENIED_RESULT;
            handlerCalls.push({
                args,
                invocation,
                result,
                error: failures.length > 0 ? failures.join("; ") : undefined,
            });
            if (failures.length > 0) {
                throw new Error(failures.join("; "));
            }
            return {
                textResultForLlm: result,
                resultType: "denied",
                error: result,
            };
        },
    });
}

function permissionRequestKinds(requests: unknown[]): string[] {
    return requests.map((request) => {
        if (isRecord(request) && typeof request.kind === "string") {
            return request.kind;
        }
        return "unknown";
    });
}

function permissionRequestsWithKind(requests: unknown[], kind: string): unknown[] {
    return requests.filter((request) => isRecord(request) && request.kind === kind);
}

function validateShellPermissionRequest(
    request: unknown,
    expectedPath: string,
    expectedContents: string
): string[] {
    const failures: string[] = [];
    if (!isRecord(request)) {
        return ["permission request is not an object"];
    }

    if (request.kind !== "shell") {
        failures.push(`permission request kind is ${String(request.kind)}, expected shell`);
    }

    const fullCommandText =
        typeof request.fullCommandText === "string" ? request.fullCommandText : "";
    if (!fullCommandText.includes(expectedPath)) {
        failures.push("permission request command does not include expected path");
    }
    if (!fullCommandText.includes(`printf ${expectedContents}`)) {
        failures.push("permission request command does not include expected printf contents");
    }
    if (!fullCommandText.includes(">")) {
        failures.push("permission request command does not include a write redirection");
    }

    const commands = Array.isArray(request.commands) ? request.commands : [];
    if (commands.length === 0) {
        failures.push("permission request has no command metadata");
    }

    return failures;
}

function validateWritePermissionRequest(request: unknown, expectedFileName: string): string[] {
    const failures: string[] = [];
    if (!isRecord(request)) {
        return ["permission request is not an object"];
    }

    if (request.kind !== "write") {
        failures.push(`permission request kind is ${String(request.kind)}, expected write`);
    }

    const serialized = JSON.stringify(request);
    if (!serialized.includes(expectedFileName)) {
        failures.push("permission request does not include expected file name");
    }

    return failures;
}

function readApprovalProbeResult(
    path: string,
    prompt: string,
    assistantMessage: string | undefined,
    permissionRequests: unknown[],
    permissionAssertionFailures: string[],
    preExisting: boolean
): ApprovalProbeResult {
    return {
        path,
        prompt,
        assistantMessage,
        permissionRequests,
        permissionRequestKinds: permissionRequestKinds(permissionRequests),
        permissionAssertionFailures,
        preExisting,
        exists: existsSync(path),
        contents: existsSync(path) ? readFileSync(path, "utf8") : undefined,
    };
}

function promptIntentPass(prompt: string, assistantMessage: string | undefined): boolean {
    if (!assistantMessage) {
        return false;
    }
    if (prompt === "Reply with READY and nothing else.") {
        return assistantMessage.trim() === "READY";
    }
    return assistantMessage.trim().length > 0;
}

function statusFromBooleans(...checks: boolean[]): ConformanceStatus {
    return checks.every(Boolean) ? "pass" : "fail";
}

function combineStatuses(...statuses: ConformanceStatus[]): ConformanceStatus {
    if (statuses.includes("fail")) {
        return "fail";
    }
    if (statuses.includes("not-run")) {
        return "not-run";
    }
    return "pass";
}

function makeCheck(input: Omit<ConformanceCheck, "status">): ConformanceCheck {
    return {
        ...input,
        status: combineStatuses(
            input.backendStatus.copilotCli,
            input.backendStatus.codexAdapter,
            input.traceParity,
            input.dataAssertion,
            input.intentAssertion
        ),
    };
}

function collectCopilotLedger(runId: string, protocolRecording: unknown): NormalizedLedgerEntry[] {
    if (!isRecord(protocolRecording)) {
        return [];
    }

    const entries: TranscriptEntry[] = [];
    const legacyRecording = nestedRecord(protocolRecording, "connectionRecording");
    entries.push(...coerceTranscriptEntries(legacyRecording?.transcripts));

    const clientRecording = nestedRecord(protocolRecording, "clientRecording");
    const client1 = clientRecording ? nestedRecord(clientRecording, "client1") : undefined;
    const client2 = clientRecording ? nestedRecord(clientRecording, "client2") : undefined;
    entries.push(...coerceTranscriptEntries(client1?.transcripts));
    entries.push(...coerceTranscriptEntries(client2?.transcripts));

    return normalizeTranscript(runId, "copilot-cli", entries);
}

function collectAdapterLedger(runId: string, adapterValidation: unknown): NormalizedLedgerEntry[] {
    if (!isRecord(adapterValidation)) {
        return [];
    }

    const entries: TranscriptEntry[] = [];
    const adapter = nestedRecord(adapterValidation, "adapter");
    entries.push(...coerceTranscriptEntries(adapter?.transcripts));

    const codex = adapter ? nestedRecord(adapter, "codex") : undefined;
    entries.push(...coerceTranscriptEntries(codex?.transcripts));

    const clientRecording = nestedRecord(adapterValidation, "clientRecording");
    const client1 = clientRecording ? nestedRecord(clientRecording, "client1") : undefined;
    const client2 = clientRecording ? nestedRecord(clientRecording, "client2") : undefined;
    entries.push(...coerceTranscriptEntries(client1?.transcripts));
    entries.push(...coerceTranscriptEntries(client2?.transcripts));

    return normalizeTranscript(runId, "codex-adapter", entries);
}

function buildCoreNewSessionCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineObserved = getNestedRecord(protocol, "observedEventTypes");
    const baselineEvents = baselineObserved
        ? stringArray(baselineObserved.client1)
        : stringArray(protocol?.observedEventTypes);
    const adapterEvents = stringArray(getNestedRecord(adapter, "observedEventTypes")?.client1);
    const baselineMessage = getNestedString(protocol, "assistantMessage");
    const adapterMessage = getNestedString(adapter, "assistantMessage");

    const baselineTrace =
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.create",
        }) &&
        hasLedgerHop(copilotLedger, { source: "sdk", target: "copilot", method: "session.send" }) &&
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.destroy",
        });
    const adapterTrace =
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "session.create",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "thread/start",
        }) &&
        hasLedgerHop(adapterLedger, { source: "sdk", target: "adapter", method: "session.send" }) &&
        hasLedgerHop(adapterLedger, { source: "adapter", target: "codex", method: "turn/start" }) &&
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "session.destroy",
        });
    const baselineData =
        baselineEvents.includes("session.start") &&
        baselineEvents.includes("assistant.message") &&
        baselineEvents.includes("session.idle") &&
        !!baselineMessage;
    const adapterData =
        adapterEvents.includes("session.start") &&
        adapterEvents.includes("assistant.message") &&
        adapterEvents.includes("session.idle") &&
        !!adapterMessage;

    const baselineTraceStatus = protocol ? statusFromBooleans(baselineTrace) : "not-run";
    const adapterTraceStatus = adapter ? statusFromBooleans(adapterTrace) : "not-run";
    const baselineDataStatus = protocol ? statusFromBooleans(baselineData) : "not-run";
    const adapterDataStatus = adapter ? statusFromBooleans(adapterData) : "not-run";
    const baselineIntentStatus = protocol
        ? statusFromBooleans(promptIntentPass(PROMPT, baselineMessage))
        : "not-run";
    const adapterIntentStatus = adapter
        ? statusFromBooleans(promptIntentPass(PROMPT, adapterMessage))
        : "not-run";

    return makeCheck({
        capability: "core new session",
        profile: "SDK Core Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineEvents=${baselineEvents.join(",")}`,
            `adapterEvents=${adapterEvents.join(",")}`,
        ],
        missing: [
            ...(protocol
                ? baselineTrace
                    ? []
                    : ["baseline trace lacks required SDK hops"]
                : ["baseline core scenario is not recorded"]),
            ...(adapter
                ? adapterTrace
                    ? []
                    : ["adapter trace lacks required SDK/Codex hops"]
                : ["adapter core scenario is not recorded"]),
            ...(protocol
                ? baselineData
                    ? []
                    : ["baseline SDK-visible core events/message incomplete"]
                : []),
            ...(adapter
                ? adapterData
                    ? []
                    : ["adapter SDK-visible core events/message incomplete"]
                : []),
        ],
    });
}

function buildResumeContinuationCheck(
    protocolRecording: unknown,
    adapterValidation: unknown
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineReplaceability = getNestedRecord(protocol, "replaceability");
    const baselineHistoryEvents = stringArray(
        getNestedRecord(protocol, "observedEventTypes")?.history
    );
    const baselineExpected = getNestedString(protocol, "expectedResumedAssistantMessage");
    const baselineActual = getNestedString(protocol, "resumedAssistantMessage");
    const baselineTrace = getNestedBoolean(baselineReplaceability, "supportsResume");
    const baselineData =
        getNestedBoolean(baselineReplaceability, "preservesHistory") &&
        baselineHistoryEvents.includes("user.message") &&
        baselineHistoryEvents.includes("assistant.message");
    const baselineIntent =
        getNestedBoolean(baselineReplaceability, "keepsStateAcrossResume") &&
        baselineActual === baselineExpected;

    const replaceability = getNestedRecord(adapter, "replaceability");
    const historyEvents = stringArray(getNestedRecord(adapter, "observedEventTypes")?.history);
    const expected = getNestedString(adapter, "expectedResumedAssistantMessage");
    const actual = getNestedString(adapter, "resumedAssistantMessage");
    const trace = getNestedBoolean(replaceability, "supportsResume");
    const data =
        getNestedBoolean(replaceability, "preservesHistory") &&
        historyEvents.includes("user.message") &&
        historyEvents.includes("assistant.message");
    const intent =
        getNestedBoolean(replaceability, "keepsStateAcrossResume") && actual === expected;

    const baselineTraceStatus = protocol ? statusFromBooleans(baselineTrace) : "not-run";
    const baselineDataStatus = protocol ? statusFromBooleans(baselineData) : "not-run";
    const baselineIntentStatus = protocol ? statusFromBooleans(baselineIntent) : "not-run";
    const adapterTraceStatus = adapter ? statusFromBooleans(trace) : "not-run";
    const adapterDataStatus = adapter ? statusFromBooleans(data) : "not-run";
    const adapterIntentStatus = adapter ? statusFromBooleans(intent) : "not-run";

    return makeCheck({
        capability: "resume continuation",
        profile: "SDK Core Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineHistoryEvents=${baselineHistoryEvents.join(",")}`,
            `baselineExpectedResumedAssistantMessage=${baselineExpected ?? ""}`,
            `baselineResumedAssistantMessage=${baselineActual ?? ""}`,
            `historyEvents=${historyEvents.join(",")}`,
            `expectedResumedAssistantMessage=${expected ?? ""}`,
            `resumedAssistantMessage=${actual ?? ""}`,
        ],
        missing: [
            ...(protocol
                ? baselineTrace
                    ? []
                    : ["baseline did not prove session.resume"]
                : ["baseline resume scenario is not recorded yet"]),
            ...(protocol
                ? baselineData
                    ? []
                    : ["baseline did not prove preserved user/assistant history"]
                : []),
            ...(protocol
                ? baselineIntent
                    ? []
                    : ["baseline did not prove stateful continuation intent"]
                : []),
            ...(trace ? [] : ["adapter did not prove session.resume"]),
            ...(data ? [] : ["adapter did not prove preserved user/assistant history"]),
            ...(intent ? [] : ["adapter did not prove stateful continuation intent"]),
        ],
    });
}

function buildCommandApprovalCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineApprovalProbe = getNestedRecord(protocol, "approvalProbe");
    const adapterApprovalProbe = getNestedRecord(adapter, "approvalProbe");
    const scenarioConfigured = !!APPROVAL_PROBE_BASE_PATH;

    if (!scenarioConfigured && !baselineApprovalProbe && !adapterApprovalProbe) {
        return makeCheck({
            capability: "command approval approve",
            profile: "Coding Agent Profile",
            backendStatus: {
                copilotCli: "not-run",
                codexAdapter: "not-run",
            },
            traceParity: "not-run",
            dataAssertion: "not-run",
            intentAssertion: "not-run",
            evidence: [],
            missing: ["approval probe path is not configured"],
        });
    }

    const baselinePermissionRequests = Array.isArray(baselineApprovalProbe?.permissionRequests)
        ? baselineApprovalProbe.permissionRequests
        : [];
    const adapterPermissionRequests = Array.isArray(adapterApprovalProbe?.permissionRequests)
        ? adapterApprovalProbe.permissionRequests
        : [];
    const baselinePermissionAssertionFailures = stringArray(
        baselineApprovalProbe?.permissionAssertionFailures
    );
    const adapterPermissionAssertionFailures = stringArray(
        adapterApprovalProbe?.permissionAssertionFailures
    );

    const baselineTrace =
        hasLedgerHop(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "permission.requested",
            direction: "notification",
        }) &&
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.permissions.handlePendingPermissionRequest",
            direction: "request",
        }) &&
        baselinePermissionRequests.length > 0 &&
        baselinePermissionAssertionFailures.length === 0;
    const adapterTrace =
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/commandExecution/requestApproval",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "sdk",
            method: "permission.request",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "permission.request",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "adapter->codex.response",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "serverRequest/resolved",
            direction: "notification",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/completed",
            direction: "notification",
        }) &&
        adapterPermissionRequests.length > 0 &&
        adapterPermissionAssertionFailures.length === 0;

    const baselinePreExisting = baselineApprovalProbe?.preExisting === true;
    const baselineExists = baselineApprovalProbe?.exists === true;
    const baselineContents = getNestedString(baselineApprovalProbe, "contents");
    const baselineData = !baselinePreExisting && baselineExists && baselineContents === "hello";
    const baselineAssistantMessage = getNestedString(baselineApprovalProbe, "assistantMessage");
    const baselineIntent = baselineData && !!baselineAssistantMessage;

    const adapterPreExisting = adapterApprovalProbe?.preExisting === true;
    const adapterExists = adapterApprovalProbe?.exists === true;
    const adapterContents = getNestedString(adapterApprovalProbe, "contents");
    const adapterData = !adapterPreExisting && adapterExists && adapterContents === "hello";
    const adapterAssistantMessage = getNestedString(adapterApprovalProbe, "assistantMessage");
    const adapterIntent = adapterData && !!adapterAssistantMessage;

    const missingProbeStatus = (backendRecorded: boolean): ConformanceStatus => {
        if (!scenarioConfigured) {
            return "not-run";
        }
        return backendRecorded ? "fail" : "not-run";
    };

    const baselineTraceStatus = baselineApprovalProbe
        ? statusFromBooleans(baselineTrace)
        : missingProbeStatus(!!protocol);
    const baselineDataStatus = baselineApprovalProbe
        ? statusFromBooleans(baselineData)
        : missingProbeStatus(!!protocol);
    const baselineIntentStatus = baselineApprovalProbe
        ? statusFromBooleans(baselineIntent)
        : missingProbeStatus(!!protocol);
    const adapterTraceStatus = adapterApprovalProbe
        ? statusFromBooleans(adapterTrace)
        : missingProbeStatus(!!adapter);
    const adapterDataStatus = adapterApprovalProbe
        ? statusFromBooleans(adapterData)
        : missingProbeStatus(!!adapter);
    const adapterIntentStatus = adapterApprovalProbe
        ? statusFromBooleans(adapterIntent)
        : missingProbeStatus(!!adapter);

    return makeCheck({
        capability: "command approval approve",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineApprovalProbe.path=${getNestedString(baselineApprovalProbe, "path") ?? ""}`,
            `baselineApprovalProbe.permissionKinds=${permissionRequestKinds(baselinePermissionRequests).join(",")}`,
            `baselineApprovalProbe.permissionAssertionFailures=${baselinePermissionAssertionFailures.join("|")}`,
            `baselineApprovalProbe.exists=${String(baselineExists)}`,
            `baselineApprovalProbe.contentsHash=${baselineContents ? hashString(baselineContents) : ""}`,
            `adapterApprovalProbe.path=${getNestedString(adapterApprovalProbe, "path") ?? ""}`,
            `adapterApprovalProbe.permissionKinds=${permissionRequestKinds(adapterPermissionRequests).join(",")}`,
            `adapterApprovalProbe.permissionAssertionFailures=${adapterPermissionAssertionFailures.join("|")}`,
            `adapterApprovalProbe.exists=${String(adapterExists)}`,
            `adapterApprovalProbe.contentsHash=${adapterContents ? hashString(adapterContents) : ""}`,
        ],
        missing: [
            ...(!scenarioConfigured ? ["approval probe path is not configured"] : []),
            ...(protocol
                ? baselineApprovalProbe
                    ? []
                    : ["baseline command approval scenario did not produce approvalProbe"]
                : ["baseline command approval scenario is not recorded yet"]),
            ...(adapter
                ? adapterApprovalProbe
                    ? []
                    : ["adapter command approval scenario did not produce approvalProbe"]
                : ["adapter command approval scenario is not recorded yet"]),
            ...(baselineApprovalProbe && baselineTrace
                ? []
                : baselineApprovalProbe
                  ? [
                        "baseline trace lacks permission.requested, handlePendingPermissionRequest, handler callback evidence, or assertive permission validation",
                    ]
                  : []),
            ...(adapterApprovalProbe && adapterTrace
                ? []
                : adapterApprovalProbe
                  ? [
                        "adapter trace lacks Codex request, SDK permission request/response, Codex response/resolved event, command completion, or handler callback evidence",
                    ]
                  : []),
            ...(baselineApprovalProbe && baselinePreExisting
                ? ["baseline approval probe path existed before the scenario"]
                : []),
            ...(adapterApprovalProbe && adapterPreExisting
                ? ["adapter approval probe path existed before the scenario"]
                : []),
            ...baselinePermissionAssertionFailures.map(
                (failure) => `baseline approval permission assertion failed: ${failure}`
            ),
            ...adapterPermissionAssertionFailures.map(
                (failure) => `adapter approval permission assertion failed: ${failure}`
            ),
            ...(baselineApprovalProbe && !baselineData
                ? ["baseline approval side effect did not produce exact fresh contents"]
                : []),
            ...(adapterApprovalProbe && !adapterData
                ? ["adapter approval side effect did not produce exact fresh contents"]
                : []),
            ...(baselineApprovalProbe && !baselineIntent
                ? ["baseline approval intent did not finish with assistant message"]
                : []),
            ...(adapterApprovalProbe && !adapterIntent
                ? ["adapter approval intent did not finish with assistant message"]
                : []),
        ],
    });
}

function buildCommandApprovalDenyCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineDenialProbe = getNestedRecord(protocol, "denialProbe");
    const adapterDenialProbe = getNestedRecord(adapter, "denialProbe");
    const scenarioConfigured = !!APPROVAL_PROBE_BASE_PATH;

    if (!scenarioConfigured && !baselineDenialProbe && !adapterDenialProbe) {
        return makeCheck({
            capability: "command approval deny",
            profile: "Coding Agent Profile",
            backendStatus: {
                copilotCli: "not-run",
                codexAdapter: "not-run",
            },
            traceParity: "not-run",
            dataAssertion: "not-run",
            intentAssertion: "not-run",
            evidence: [],
            missing: ["approval probe path is not configured"],
        });
    }

    const baselinePermissionRequests = Array.isArray(baselineDenialProbe?.permissionRequests)
        ? baselineDenialProbe.permissionRequests
        : [];
    const adapterPermissionRequests = Array.isArray(adapterDenialProbe?.permissionRequests)
        ? adapterDenialProbe.permissionRequests
        : [];
    const baselinePermissionAssertionFailures = stringArray(
        baselineDenialProbe?.permissionAssertionFailures
    );
    const adapterPermissionAssertionFailures = stringArray(
        adapterDenialProbe?.permissionAssertionFailures
    );

    const baselineTrace =
        hasLedgerHop(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "permission.requested",
            direction: "notification",
        }) &&
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.permissions.handlePendingPermissionRequest",
            direction: "request",
        }) &&
        baselinePermissionRequests.length > 0 &&
        baselinePermissionAssertionFailures.length === 0;
    const adapterTrace =
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/commandExecution/requestApproval",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "sdk",
            method: "permission.request",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "permission.request",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "adapter->codex.response",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "serverRequest/resolved",
            direction: "notification",
        }) &&
        adapterPermissionRequests.length > 0 &&
        adapterPermissionAssertionFailures.length === 0;

    const baselinePreExisting = baselineDenialProbe?.preExisting === true;
    const baselineExists = baselineDenialProbe?.exists === true;
    const baselineContents = getNestedString(baselineDenialProbe, "contents");
    const baselineData = !baselinePreExisting && !baselineExists;
    const baselineAssistantMessage = getNestedString(baselineDenialProbe, "assistantMessage");
    const baselineIntent = baselineData && !!baselineAssistantMessage;

    const adapterPreExisting = adapterDenialProbe?.preExisting === true;
    const adapterExists = adapterDenialProbe?.exists === true;
    const adapterContents = getNestedString(adapterDenialProbe, "contents");
    const adapterData = !adapterPreExisting && !adapterExists;
    const adapterAssistantMessage = getNestedString(adapterDenialProbe, "assistantMessage");
    const adapterIntent = adapterData && !!adapterAssistantMessage;

    const missingProbeStatus = (backendRecorded: boolean): ConformanceStatus => {
        if (!scenarioConfigured) {
            return "not-run";
        }
        return backendRecorded ? "fail" : "not-run";
    };

    const baselineTraceStatus = baselineDenialProbe
        ? statusFromBooleans(baselineTrace)
        : missingProbeStatus(!!protocol);
    const baselineDataStatus = baselineDenialProbe
        ? statusFromBooleans(baselineData)
        : missingProbeStatus(!!protocol);
    const baselineIntentStatus = baselineDenialProbe
        ? statusFromBooleans(baselineIntent)
        : missingProbeStatus(!!protocol);
    const adapterTraceStatus = adapterDenialProbe
        ? statusFromBooleans(adapterTrace)
        : missingProbeStatus(!!adapter);
    const adapterDataStatus = adapterDenialProbe
        ? statusFromBooleans(adapterData)
        : missingProbeStatus(!!adapter);
    const adapterIntentStatus = adapterDenialProbe
        ? statusFromBooleans(adapterIntent)
        : missingProbeStatus(!!adapter);

    return makeCheck({
        capability: "command approval deny",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineDenialProbe.path=${getNestedString(baselineDenialProbe, "path") ?? ""}`,
            `baselineDenialProbe.permissionKinds=${permissionRequestKinds(baselinePermissionRequests).join(",")}`,
            `baselineDenialProbe.permissionAssertionFailures=${baselinePermissionAssertionFailures.join("|")}`,
            `baselineDenialProbe.exists=${String(baselineExists)}`,
            `baselineDenialProbe.contentsHash=${baselineContents ? hashString(baselineContents) : ""}`,
            `adapterDenialProbe.path=${getNestedString(adapterDenialProbe, "path") ?? ""}`,
            `adapterDenialProbe.permissionKinds=${permissionRequestKinds(adapterPermissionRequests).join(",")}`,
            `adapterDenialProbe.permissionAssertionFailures=${adapterPermissionAssertionFailures.join("|")}`,
            `adapterDenialProbe.exists=${String(adapterExists)}`,
            `adapterDenialProbe.contentsHash=${adapterContents ? hashString(adapterContents) : ""}`,
        ],
        missing: [
            ...(!scenarioConfigured ? ["approval probe path is not configured"] : []),
            ...(protocol
                ? baselineDenialProbe
                    ? []
                    : ["baseline command denial scenario did not produce denialProbe"]
                : ["baseline command denial scenario is not recorded yet"]),
            ...(adapter
                ? adapterDenialProbe
                    ? []
                    : ["adapter command denial scenario did not produce denialProbe"]
                : ["adapter command denial scenario is not recorded yet"]),
            ...(baselineDenialProbe && baselineTrace
                ? []
                : baselineDenialProbe
                  ? [
                        "baseline denial trace lacks permission.requested, handlePendingPermissionRequest, handler callback evidence, or assertive permission validation",
                    ]
                  : []),
            ...(adapterDenialProbe && adapterTrace
                ? []
                : adapterDenialProbe
                  ? [
                        "adapter denial trace lacks Codex request, SDK permission request/response, Codex response/resolved event, or handler callback evidence",
                    ]
                  : []),
            ...(baselineDenialProbe && baselinePreExisting
                ? ["baseline denial probe path existed before the scenario"]
                : []),
            ...(adapterDenialProbe && adapterPreExisting
                ? ["adapter denial probe path existed before the scenario"]
                : []),
            ...baselinePermissionAssertionFailures.map(
                (failure) => `baseline denial permission assertion failed: ${failure}`
            ),
            ...adapterPermissionAssertionFailures.map(
                (failure) => `adapter denial permission assertion failed: ${failure}`
            ),
            ...(baselineDenialProbe && !baselineData
                ? ["baseline denial side effect was not blocked"]
                : []),
            ...(adapterDenialProbe && !adapterData
                ? ["adapter denial side effect was not blocked"]
                : []),
            ...(baselineDenialProbe && !baselineIntent
                ? ["baseline denial intent did not finish with assistant message"]
                : []),
            ...(adapterDenialProbe && !adapterIntent
                ? ["adapter denial intent did not finish with assistant message"]
                : []),
        ],
    });
}

function buildFileApprovalCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineApprovalProbe = getNestedRecord(protocol, "fileApprovalProbe");
    const adapterApprovalProbe = getNestedRecord(adapter, "fileApprovalProbe");
    const baselineDenialProbe = getNestedRecord(protocol, "fileDenialProbe");
    const adapterDenialProbe = getNestedRecord(adapter, "fileDenialProbe");

    if (
        !RUN_FILE_PROBE &&
        !baselineApprovalProbe &&
        !adapterApprovalProbe &&
        !baselineDenialProbe &&
        !adapterDenialProbe
    ) {
        return makeCheck({
            capability: "file approval approve/deny",
            profile: "Coding Agent Profile",
            backendStatus: {
                copilotCli: "not-run",
                codexAdapter: "not-run",
            },
            traceParity: "not-run",
            dataAssertion: "not-run",
            intentAssertion: "not-run",
            evidence: [],
            missing: ["file approval probe is not enabled"],
        });
    }

    const baselineApprovalRequests = Array.isArray(baselineApprovalProbe?.permissionRequests)
        ? baselineApprovalProbe.permissionRequests
        : [];
    const adapterApprovalRequests = Array.isArray(adapterApprovalProbe?.permissionRequests)
        ? adapterApprovalProbe.permissionRequests
        : [];
    const baselineDenialRequests = Array.isArray(baselineDenialProbe?.permissionRequests)
        ? baselineDenialProbe.permissionRequests
        : [];
    const adapterDenialRequests = Array.isArray(adapterDenialProbe?.permissionRequests)
        ? adapterDenialProbe.permissionRequests
        : [];
    const baselineApprovalWriteRequests = permissionRequestsWithKind(
        baselineApprovalRequests,
        "write"
    );
    const adapterApprovalWriteRequests = permissionRequestsWithKind(
        adapterApprovalRequests,
        "write"
    );
    const baselineDenialWriteRequests = permissionRequestsWithKind(baselineDenialRequests, "write");
    const adapterDenialWriteRequests = permissionRequestsWithKind(adapterDenialRequests, "write");

    const baselineApprovalFailures = stringArray(
        baselineApprovalProbe?.permissionAssertionFailures
    );
    const adapterApprovalFailures = stringArray(adapterApprovalProbe?.permissionAssertionFailures);
    const baselineDenialFailures = stringArray(baselineDenialProbe?.permissionAssertionFailures);
    const adapterDenialFailures = stringArray(adapterDenialProbe?.permissionAssertionFailures);

    const baselineTrace =
        hasLedgerHop(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "permission.requested",
            direction: "notification",
        }) &&
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.permissions.handlePendingPermissionRequest",
            direction: "request",
        }) &&
        baselineApprovalWriteRequests.length > 0 &&
        baselineDenialWriteRequests.length > 0 &&
        baselineApprovalFailures.length === 0 &&
        baselineDenialFailures.length === 0;
    const adapterTrace =
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/fileChange/requestApproval",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "sdk",
            method: "permission.request",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "permission.request",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "adapter->codex.response",
            direction: "response",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "serverRequest/resolved",
            direction: "notification",
        }) &&
        adapterApprovalWriteRequests.length > 0 &&
        adapterDenialWriteRequests.length > 0 &&
        adapterApprovalFailures.length === 0 &&
        adapterDenialFailures.length === 0;

    const baselineApprovalData =
        baselineApprovalProbe?.preExisting !== true &&
        baselineApprovalProbe?.exists === true &&
        getNestedString(baselineApprovalProbe, "contents") === FILE_APPROVE_CONTENT;
    const adapterApprovalData =
        adapterApprovalProbe?.preExisting !== true &&
        adapterApprovalProbe?.exists === true &&
        getNestedString(adapterApprovalProbe, "contents") === FILE_APPROVE_CONTENT;
    const baselineDenialData =
        baselineDenialProbe?.preExisting !== true && baselineDenialProbe?.exists !== true;
    const adapterDenialData =
        adapterDenialProbe?.preExisting !== true && adapterDenialProbe?.exists !== true;
    const baselineData = baselineApprovalData && baselineDenialData;
    const adapterData = adapterApprovalData && adapterDenialData;

    const baselineIntent =
        baselineData &&
        !!getNestedString(baselineApprovalProbe, "assistantMessage") &&
        !!getNestedString(baselineDenialProbe, "assistantMessage");
    const adapterIntent =
        adapterData &&
        !!getNestedString(adapterApprovalProbe, "assistantMessage") &&
        !!getNestedString(adapterDenialProbe, "assistantMessage");

    const missingProbeStatus = (backendRecorded: boolean): ConformanceStatus => {
        if (!RUN_FILE_PROBE) {
            return "not-run";
        }
        return backendRecorded ? "fail" : "not-run";
    };

    const baselineTraceStatus =
        baselineApprovalProbe && baselineDenialProbe
            ? statusFromBooleans(baselineTrace)
            : missingProbeStatus(!!protocol);
    const baselineDataStatus =
        baselineApprovalProbe && baselineDenialProbe
            ? statusFromBooleans(baselineData)
            : missingProbeStatus(!!protocol);
    const baselineIntentStatus =
        baselineApprovalProbe && baselineDenialProbe
            ? statusFromBooleans(baselineIntent)
            : missingProbeStatus(!!protocol);
    const adapterTraceStatus =
        adapterApprovalProbe && adapterDenialProbe
            ? statusFromBooleans(adapterTrace)
            : missingProbeStatus(!!adapter);
    const adapterDataStatus =
        adapterApprovalProbe && adapterDenialProbe
            ? statusFromBooleans(adapterData)
            : missingProbeStatus(!!adapter);
    const adapterIntentStatus =
        adapterApprovalProbe && adapterDenialProbe
            ? statusFromBooleans(adapterIntent)
            : missingProbeStatus(!!adapter);

    return makeCheck({
        capability: "file approval approve/deny",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineFileApproval.path=${getNestedString(baselineApprovalProbe, "path") ?? ""}`,
            `baselineFileApproval.permissionKinds=${permissionRequestKinds(baselineApprovalRequests).join(",")}`,
            `baselineFileApproval.permissionAssertionFailures=${baselineApprovalFailures.join("|")}`,
            `baselineFileApproval.contentsHash=${hashString(getNestedString(baselineApprovalProbe, "contents") ?? "")}`,
            `baselineFileDenial.path=${getNestedString(baselineDenialProbe, "path") ?? ""}`,
            `baselineFileDenial.permissionKinds=${permissionRequestKinds(baselineDenialRequests).join(",")}`,
            `baselineFileDenial.permissionAssertionFailures=${baselineDenialFailures.join("|")}`,
            `baselineFileDenial.exists=${String(baselineDenialProbe?.exists === true)}`,
            `adapterFileApproval.path=${getNestedString(adapterApprovalProbe, "path") ?? ""}`,
            `adapterFileApproval.permissionKinds=${permissionRequestKinds(adapterApprovalRequests).join(",")}`,
            `adapterFileApproval.permissionAssertionFailures=${adapterApprovalFailures.join("|")}`,
            `adapterFileApproval.contentsHash=${hashString(getNestedString(adapterApprovalProbe, "contents") ?? "")}`,
            `adapterFileDenial.path=${getNestedString(adapterDenialProbe, "path") ?? ""}`,
            `adapterFileDenial.permissionKinds=${permissionRequestKinds(adapterDenialRequests).join(",")}`,
            `adapterFileDenial.permissionAssertionFailures=${adapterDenialFailures.join("|")}`,
            `adapterFileDenial.exists=${String(adapterDenialProbe?.exists === true)}`,
        ],
        missing: [
            ...(!RUN_FILE_PROBE ? ["file approval probe is not enabled"] : []),
            ...(protocol
                ? baselineApprovalProbe
                    ? []
                    : ["baseline file approval scenario did not produce fileApprovalProbe"]
                : ["baseline file approval scenario is not recorded yet"]),
            ...(protocol
                ? baselineDenialProbe
                    ? []
                    : ["baseline file denial scenario did not produce fileDenialProbe"]
                : ["baseline file denial scenario is not recorded yet"]),
            ...(adapter
                ? adapterApprovalProbe
                    ? []
                    : ["adapter file approval scenario did not produce fileApprovalProbe"]
                : ["adapter file approval scenario is not recorded yet"]),
            ...(adapter
                ? adapterDenialProbe
                    ? []
                    : ["adapter file denial scenario did not produce fileDenialProbe"]
                : ["adapter file denial scenario is not recorded yet"]),
            ...(baselineApprovalProbe && baselineDenialProbe && baselineTrace
                ? []
                : baselineApprovalProbe && baselineDenialProbe
                  ? [
                        "baseline file trace lacks permission.requested, handlePendingPermissionRequest, handler callback evidence, or assertive permission validation",
                    ]
                  : []),
            ...(adapterApprovalProbe && adapterDenialProbe && adapterTrace
                ? []
                : adapterApprovalProbe && adapterDenialProbe
                  ? [
                        "adapter file trace lacks Codex file approval request, SDK permission request/response, Codex response/resolved event, or handler callback evidence",
                    ]
                  : []),
            ...baselineApprovalFailures.map(
                (failure) => `baseline file approval permission assertion failed: ${failure}`
            ),
            ...adapterApprovalFailures.map(
                (failure) => `adapter file approval permission assertion failed: ${failure}`
            ),
            ...baselineDenialFailures.map(
                (failure) => `baseline file denial permission assertion failed: ${failure}`
            ),
            ...adapterDenialFailures.map(
                (failure) => `adapter file denial permission assertion failed: ${failure}`
            ),
            ...(baselineApprovalProbe && !baselineApprovalData
                ? ["baseline file approval did not produce exact fresh contents"]
                : []),
            ...(adapterApprovalProbe && !adapterApprovalData
                ? ["adapter file approval did not produce exact fresh contents"]
                : []),
            ...(baselineDenialProbe && !baselineDenialData
                ? ["baseline file denial side effect was not blocked"]
                : []),
            ...(adapterDenialProbe && !adapterDenialData
                ? ["adapter file denial side effect was not blocked"]
                : []),
            ...(baselineApprovalProbe && baselineDenialProbe && !baselineIntent
                ? ["baseline file approval/denial did not finish with assistant messages"]
                : []),
            ...(adapterApprovalProbe && adapterDenialProbe && !adapterIntent
                ? ["adapter file approval/denial did not finish with assistant messages"]
                : []),
        ],
    });
}

function toolProbeDataPass(probe: Record<string, unknown> | undefined): boolean {
    if (!probe) {
        return false;
    }
    const handlerCalls = Array.isArray(probe.handlerCalls) ? probe.handlerCalls : [];
    const assertionFailures = stringArray(probe.assertionFailures);
    const firstHandlerCall = isRecord(handlerCalls[0]) ? handlerCalls[0] : undefined;
    const args = isRecord(firstHandlerCall?.args) ? firstHandlerCall.args : {};
    const invocation = isRecord(firstHandlerCall?.invocation) ? firstHandlerCall.invocation : {};
    return (
        handlerCalls.length === 1 &&
        assertionFailures.length === 0 &&
        getNestedString(probe, "expectedResult") === TOOL_PROBE_RESULT &&
        args.topic === TOOL_PROBE_TOPIC &&
        invocation.toolName === TOOL_PROBE_NAME &&
        typeof invocation.toolCallId === "string" &&
        invocation.toolCallId.length > 0 &&
        firstHandlerCall?.result === TOOL_PROBE_RESULT
    );
}

function toolProbeIntentPass(probe: Record<string, unknown> | undefined): boolean {
    const assistantMessage = getNestedString(probe, "assistantMessage");
    return toolProbeDataPass(probe) && !!assistantMessage && assistantMessage.trim().length > 0;
}

function toolProbeFinalMessageUsesResult(probe: Record<string, unknown> | undefined): boolean {
    return (getNestedString(probe, "assistantMessage") ?? "").includes(TOOL_PROBE_RESULT);
}

function toolProbeHandlerCallSummary(probe: Record<string, unknown> | undefined): string {
    const handlerCalls = Array.isArray(probe?.handlerCalls) ? probe.handlerCalls : [];
    return handlerCalls
        .map((call) => {
            if (!isRecord(call)) {
                return "invalid";
            }
            const args = isRecord(call.args) ? call.args : {};
            const invocation = isRecord(call.invocation) ? call.invocation : {};
            return [
                `topic=${String(args.topic ?? "")}`,
                `toolName=${String(invocation.toolName ?? "")}`,
                `toolCallId=${String(invocation.toolCallId ?? "")}`,
                `resultHash=${typeof call.result === "string" ? hashString(call.result) : ""}`,
                `error=${typeof call.error === "string" ? call.error : ""}`,
            ].join(";");
        })
        .join("|");
}

function buildCustomToolCallCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineToolProbe = getNestedRecord(protocol, "toolProbe");
    const adapterToolProbe = getNestedRecord(adapter, "toolProbe");

    if (!RUN_TOOL_PROBE && !baselineToolProbe && !adapterToolProbe) {
        return makeCheck({
            capability: "custom tool call",
            profile: "Coding Agent Profile",
            backendStatus: {
                copilotCli: "not-run",
                codexAdapter: "not-run",
            },
            traceParity: "not-run",
            dataAssertion: "not-run",
            intentAssertion: "not-run",
            evidence: [],
            missing: ["custom tool probe is not enabled"],
        });
    }

    const baselineFailures = stringArray(baselineToolProbe?.assertionFailures);
    const adapterFailures = stringArray(adapterToolProbe?.assertionFailures);
    const baselineHandlerCalls = Array.isArray(baselineToolProbe?.handlerCalls)
        ? baselineToolProbe.handlerCalls
        : [];
    const adapterHandlerCalls = Array.isArray(adapterToolProbe?.handlerCalls)
        ? adapterToolProbe.handlerCalls
        : [];

    const baselineTrace =
        hasLedgerHop(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.requested",
            direction: "notification",
        }) &&
        hasLedgerHop(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.completed",
            direction: "notification",
        }) &&
        hasLedgerHop(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.tools.handlePendingToolCall",
            direction: "request",
        }) &&
        baselineHandlerCalls.length === 1 &&
        baselineFailures.length === 0;
    const adapterTrace =
        hasLedgerHop(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/tool/call",
            direction: "request",
        }) &&
        (hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "sdk",
            method: "session.event",
            direction: "notification",
        }) ||
            hasLedgerHop(adapterLedger, {
                source: "copilot",
                target: "sdk",
                method: "external_tool.requested",
                direction: "notification",
            })) &&
        hasLedgerHop(adapterLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.completed",
            direction: "notification",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "session.tools.handlePendingToolCall",
            direction: "request",
        }) &&
        hasLedgerHop(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "adapter->codex.response",
            direction: "response",
        }) &&
        adapterHandlerCalls.length === 1 &&
        adapterFailures.length === 0;

    const baselineData = toolProbeDataPass(baselineToolProbe);
    const adapterData = toolProbeDataPass(adapterToolProbe);
    const baselineIntent = toolProbeIntentPass(baselineToolProbe);
    const adapterIntent = toolProbeIntentPass(adapterToolProbe);

    const missingProbeStatus = (backendRecorded: boolean): ConformanceStatus => {
        if (!RUN_TOOL_PROBE) {
            return "not-run";
        }
        return backendRecorded ? "fail" : "not-run";
    };

    const baselineTraceStatus = baselineToolProbe
        ? statusFromBooleans(baselineTrace)
        : missingProbeStatus(!!protocol);
    const baselineDataStatus = baselineToolProbe
        ? statusFromBooleans(baselineData)
        : missingProbeStatus(!!protocol);
    const baselineIntentStatus = baselineToolProbe
        ? statusFromBooleans(baselineIntent)
        : missingProbeStatus(!!protocol);
    const adapterTraceStatus = adapterToolProbe
        ? statusFromBooleans(adapterTrace)
        : missingProbeStatus(!!adapter);
    const adapterDataStatus = adapterToolProbe
        ? statusFromBooleans(adapterData)
        : missingProbeStatus(!!adapter);
    const adapterIntentStatus = adapterToolProbe
        ? statusFromBooleans(adapterIntent)
        : missingProbeStatus(!!adapter);

    return makeCheck({
        capability: "custom tool call",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineToolProbe.toolName=${getNestedString(baselineToolProbe, "toolName") ?? ""}`,
            `baselineToolProbe.handlerCalls=${toolProbeHandlerCallSummary(baselineToolProbe)}`,
            `baselineToolProbe.assertionFailures=${baselineFailures.join("|")}`,
            `baselineToolProbe.assistantHash=${hashString(getNestedString(baselineToolProbe, "assistantMessage") ?? "")}`,
            `baselineToolProbe.finalUsesResult=${String(toolProbeFinalMessageUsesResult(baselineToolProbe))}`,
            `adapterToolProbe.toolName=${getNestedString(adapterToolProbe, "toolName") ?? ""}`,
            `adapterToolProbe.handlerCalls=${toolProbeHandlerCallSummary(adapterToolProbe)}`,
            `adapterToolProbe.assertionFailures=${adapterFailures.join("|")}`,
            `adapterToolProbe.assistantHash=${hashString(getNestedString(adapterToolProbe, "assistantMessage") ?? "")}`,
            `adapterToolProbe.finalUsesResult=${String(toolProbeFinalMessageUsesResult(adapterToolProbe))}`,
        ],
        missing: [
            ...(!RUN_TOOL_PROBE ? ["custom tool probe is not enabled"] : []),
            ...(protocol
                ? baselineToolProbe
                    ? []
                    : ["baseline custom tool scenario did not produce toolProbe"]
                : ["baseline custom tool scenario is not recorded yet"]),
            ...(adapter
                ? adapterToolProbe
                    ? []
                    : ["adapter custom tool scenario did not produce toolProbe"]
                : ["adapter custom tool scenario is not recorded yet"]),
            ...(baselineToolProbe && baselineTrace
                ? []
                : baselineToolProbe
                  ? [
                        "baseline tool trace lacks external_tool.requested, handlePendingToolCall, or handler callback evidence",
                    ]
                  : []),
            ...(adapterToolProbe && adapterTrace
                ? []
                : adapterToolProbe
                  ? [
                        "adapter tool trace lacks Codex item/tool/call, SDK external_tool request, handlePendingToolCall, Codex response, or handler callback evidence",
                    ]
                  : []),
            ...baselineFailures.map((failure) => `baseline tool assertion failed: ${failure}`),
            ...adapterFailures.map((failure) => `adapter tool assertion failed: ${failure}`),
            ...(baselineToolProbe && !baselineData
                ? ["baseline custom tool did not return expected result through handler"]
                : []),
            ...(adapterToolProbe && !adapterData
                ? ["adapter custom tool did not return expected result through handler"]
                : []),
            ...(baselineToolProbe && !baselineIntent
                ? ["baseline custom tool turn did not complete with a final assistant answer"]
                : []),
            ...(adapterToolProbe && !adapterIntent
                ? ["adapter custom tool turn did not complete with a final assistant answer"]
                : []),
        ],
    });
}

function firstProbeHandlerCall(
    probe: Record<string, unknown> | undefined,
    key: string
): Record<string, unknown> | undefined {
    const calls = Array.isArray(probe?.[key]) ? probe[key] : [];
    const first = calls[0];
    return isRecord(first) ? first : undefined;
}

function probeHandlerCallMatches(
    call: Record<string, unknown> | undefined,
    expectedToolName: string,
    expectedField: "result" | "error",
    expectedValue: string
): boolean {
    if (!call) {
        return false;
    }
    const args = isRecord(call.args) ? call.args : {};
    const invocation = isRecord(call.invocation) ? call.invocation : {};
    return (
        args.topic === TOOL_PROBE_TOPIC &&
        invocation.toolName === expectedToolName &&
        typeof invocation.toolCallId === "string" &&
        invocation.toolCallId.length > 0 &&
        call[expectedField] === expectedValue
    );
}

function toolFailureProbeDataPass(probe: Record<string, unknown> | undefined): boolean {
    if (!probe) {
        return false;
    }
    const failureHandlerCalls = Array.isArray(probe.failureHandlerCalls)
        ? probe.failureHandlerCalls
        : [];
    const deniedHandlerCalls = Array.isArray(probe.deniedHandlerCalls)
        ? probe.deniedHandlerCalls
        : [];
    const assertionFailures = stringArray(probe.assertionFailures);
    return (
        failureHandlerCalls.length === 1 &&
        deniedHandlerCalls.length === 1 &&
        assertionFailures.length === 0 &&
        getNestedString(probe, "expectedFailureError") === TOOL_FAILURE_ERROR &&
        getNestedString(probe, "expectedDeniedResult") === TOOL_DENIED_RESULT &&
        probeHandlerCallMatches(
            firstProbeHandlerCall(probe, "failureHandlerCalls"),
            TOOL_FAILURE_NAME,
            "error",
            TOOL_FAILURE_ERROR
        ) &&
        probeHandlerCallMatches(
            firstProbeHandlerCall(probe, "deniedHandlerCalls"),
            TOOL_DENIED_NAME,
            "result",
            TOOL_DENIED_RESULT
        )
    );
}

function toolFailureProbeIntentPass(probe: Record<string, unknown> | undefined): boolean {
    const failureAssistantMessage = getNestedString(probe, "failureAssistantMessage");
    const deniedAssistantMessage = getNestedString(probe, "deniedAssistantMessage");
    return (
        toolFailureProbeDataPass(probe) &&
        !!failureAssistantMessage &&
        failureAssistantMessage.trim().length > 0 &&
        !!deniedAssistantMessage &&
        deniedAssistantMessage.trim().length > 0
    );
}

function toolFailureHandlerCallSummary(
    probe: Record<string, unknown> | undefined,
    key: string
): string {
    const handlerCalls = Array.isArray(probe?.[key]) ? probe[key] : [];
    return handlerCalls
        .map((call) => {
            if (!isRecord(call)) {
                return "invalid";
            }
            const args = isRecord(call.args) ? call.args : {};
            const invocation = isRecord(call.invocation) ? call.invocation : {};
            return [
                `topic=${String(args.topic ?? "")}`,
                `toolName=${String(invocation.toolName ?? "")}`,
                `toolCallId=${String(invocation.toolCallId ?? "")}`,
                `resultHash=${typeof call.result === "string" ? hashString(call.result) : ""}`,
                `errorHash=${typeof call.error === "string" ? hashString(call.error) : ""}`,
            ].join(";");
        })
        .join("|");
}

function buildToolDenyOrFailureCheck(
    protocolRecording: unknown,
    adapterValidation: unknown,
    copilotLedger: NormalizedLedgerEntry[],
    adapterLedger: NormalizedLedgerEntry[]
): ConformanceCheck {
    const protocol = isRecord(protocolRecording) ? protocolRecording : undefined;
    const adapter = isRecord(adapterValidation) ? adapterValidation : undefined;
    const baselineToolFailureProbe = getNestedRecord(protocol, "toolFailureProbe");
    const adapterToolFailureProbe = getNestedRecord(adapter, "toolFailureProbe");

    if (!RUN_TOOL_FAILURE_PROBE && !baselineToolFailureProbe && !adapterToolFailureProbe) {
        return notRunCheck(
            "tool deny or failure",
            "Coding Agent Profile",
            "tool failure probe is not enabled"
        );
    }

    const baselineFailures = stringArray(baselineToolFailureProbe?.assertionFailures);
    const adapterFailures = stringArray(adapterToolFailureProbe?.assertionFailures);
    const baselineFailureCalls = Array.isArray(baselineToolFailureProbe?.failureHandlerCalls)
        ? baselineToolFailureProbe.failureHandlerCalls
        : [];
    const baselineDeniedCalls = Array.isArray(baselineToolFailureProbe?.deniedHandlerCalls)
        ? baselineToolFailureProbe.deniedHandlerCalls
        : [];
    const adapterFailureCalls = Array.isArray(adapterToolFailureProbe?.failureHandlerCalls)
        ? adapterToolFailureProbe.failureHandlerCalls
        : [];
    const adapterDeniedCalls = Array.isArray(adapterToolFailureProbe?.deniedHandlerCalls)
        ? adapterToolFailureProbe.deniedHandlerCalls
        : [];

    const baselineTrace =
        countLedgerHops(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.requested",
            direction: "notification",
        }) >= 2 &&
        countLedgerHops(copilotLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.completed",
            direction: "notification",
        }) >= 2 &&
        countLedgerHops(copilotLedger, {
            source: "sdk",
            target: "copilot",
            method: "session.tools.handlePendingToolCall",
            direction: "request",
        }) >= 2 &&
        baselineFailureCalls.length === 1 &&
        baselineDeniedCalls.length === 1 &&
        baselineFailures.length === 0;

    const adapterTrace =
        countLedgerHops(adapterLedger, {
            source: "codex",
            target: "adapter",
            method: "item/tool/call",
            direction: "request",
        }) >= 2 &&
        countLedgerHops(adapterLedger, {
            source: "sdk",
            target: "adapter",
            method: "session.tools.handlePendingToolCall",
            direction: "request",
        }) >= 2 &&
        countLedgerHops(adapterLedger, {
            source: "adapter",
            target: "codex",
            method: "adapter->codex.response",
            direction: "response",
        }) >= 2 &&
        countLedgerHops(adapterLedger, {
            source: "copilot",
            target: "sdk",
            method: "external_tool.completed",
            direction: "notification",
        }) >= 2 &&
        adapterFailureCalls.length === 1 &&
        adapterDeniedCalls.length === 1 &&
        adapterFailures.length === 0;

    const baselineData = toolFailureProbeDataPass(baselineToolFailureProbe);
    const adapterData = toolFailureProbeDataPass(adapterToolFailureProbe);
    const baselineIntent = toolFailureProbeIntentPass(baselineToolFailureProbe);
    const adapterIntent = toolFailureProbeIntentPass(adapterToolFailureProbe);

    const missingProbeStatus = (backendRecorded: boolean): ConformanceStatus => {
        if (!RUN_TOOL_FAILURE_PROBE) {
            return "not-run";
        }
        return backendRecorded ? "fail" : "not-run";
    };

    const baselineTraceStatus = baselineToolFailureProbe
        ? statusFromBooleans(baselineTrace)
        : missingProbeStatus(!!protocol);
    const baselineDataStatus = baselineToolFailureProbe
        ? statusFromBooleans(baselineData)
        : missingProbeStatus(!!protocol);
    const baselineIntentStatus = baselineToolFailureProbe
        ? statusFromBooleans(baselineIntent)
        : missingProbeStatus(!!protocol);
    const adapterTraceStatus = adapterToolFailureProbe
        ? statusFromBooleans(adapterTrace)
        : missingProbeStatus(!!adapter);
    const adapterDataStatus = adapterToolFailureProbe
        ? statusFromBooleans(adapterData)
        : missingProbeStatus(!!adapter);
    const adapterIntentStatus = adapterToolFailureProbe
        ? statusFromBooleans(adapterIntent)
        : missingProbeStatus(!!adapter);

    return makeCheck({
        capability: "tool deny or failure",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatuses(
                baselineTraceStatus,
                baselineDataStatus,
                baselineIntentStatus
            ),
            codexAdapter: combineStatuses(
                adapterTraceStatus,
                adapterDataStatus,
                adapterIntentStatus
            ),
        },
        traceParity: combineStatuses(baselineTraceStatus, adapterTraceStatus),
        dataAssertion: combineStatuses(baselineDataStatus, adapterDataStatus),
        intentAssertion: combineStatuses(baselineIntentStatus, adapterIntentStatus),
        evidence: [
            `baselineToolFailure.failureCalls=${toolFailureHandlerCallSummary(baselineToolFailureProbe, "failureHandlerCalls")}`,
            `baselineToolFailure.deniedCalls=${toolFailureHandlerCallSummary(baselineToolFailureProbe, "deniedHandlerCalls")}`,
            `baselineToolFailure.assertionFailures=${baselineFailures.join("|")}`,
            `baselineToolFailure.failureAssistantHash=${hashString(getNestedString(baselineToolFailureProbe, "failureAssistantMessage") ?? "")}`,
            `baselineToolFailure.deniedAssistantHash=${hashString(getNestedString(baselineToolFailureProbe, "deniedAssistantMessage") ?? "")}`,
            `adapterToolFailure.failureCalls=${toolFailureHandlerCallSummary(adapterToolFailureProbe, "failureHandlerCalls")}`,
            `adapterToolFailure.deniedCalls=${toolFailureHandlerCallSummary(adapterToolFailureProbe, "deniedHandlerCalls")}`,
            `adapterToolFailure.assertionFailures=${adapterFailures.join("|")}`,
            `adapterToolFailure.failureAssistantHash=${hashString(getNestedString(adapterToolFailureProbe, "failureAssistantMessage") ?? "")}`,
            `adapterToolFailure.deniedAssistantHash=${hashString(getNestedString(adapterToolFailureProbe, "deniedAssistantMessage") ?? "")}`,
        ],
        missing: [
            ...(!RUN_TOOL_FAILURE_PROBE ? ["tool failure probe is not enabled"] : []),
            ...(protocol
                ? baselineToolFailureProbe
                    ? []
                    : ["baseline tool failure scenario did not produce toolFailureProbe"]
                : ["baseline tool failure scenario is not recorded yet"]),
            ...(adapter
                ? adapterToolFailureProbe
                    ? []
                    : ["adapter tool failure scenario did not produce toolFailureProbe"]
                : ["adapter tool failure scenario is not recorded yet"]),
            ...(baselineToolFailureProbe && baselineTrace
                ? []
                : baselineToolFailureProbe
                  ? [
                        "baseline tool failure trace lacks external_tool requested/completed, handlePendingToolCall, or handler callback evidence",
                    ]
                  : []),
            ...(adapterToolFailureProbe && adapterTrace
                ? []
                : adapterToolFailureProbe
                  ? [
                        "adapter tool failure trace lacks Codex item/tool/call, SDK handlePendingToolCall, Codex response, or completion evidence",
                    ]
                  : []),
            ...baselineFailures.map(
                (failure) => `baseline tool failure assertion failed: ${failure}`
            ),
            ...adapterFailures.map(
                (failure) => `adapter tool failure assertion failed: ${failure}`
            ),
            ...(baselineToolFailureProbe && !baselineData
                ? ["baseline tool failure/denial did not preserve expected handler results"]
                : []),
            ...(adapterToolFailureProbe && !adapterData
                ? ["adapter tool failure/denial did not preserve expected handler results"]
                : []),
            ...(baselineToolFailureProbe && !baselineIntent
                ? ["baseline tool failure/denial turns did not complete with assistant messages"]
                : []),
            ...(adapterToolFailureProbe && !adapterIntent
                ? ["adapter tool failure/denial turns did not complete with assistant messages"]
                : []),
        ],
    });
}

function notRunCheck(
    capability: string,
    profile: ConformanceCheck["profile"],
    reason: string
): ConformanceCheck {
    return makeCheck({
        capability,
        profile,
        backendStatus: {
            copilotCli: "not-run",
            codexAdapter: "not-run",
        },
        traceParity: "not-run",
        dataAssertion: "not-run",
        intentAssertion: "not-run",
        evidence: [],
        missing: [reason],
    });
}

function buildConformanceReport(runId: string, result: Record<string, unknown>): ConformanceReport {
    const protocolRecording = result.protocolRecording;
    const adapterValidation = result.adapterValidation;
    const copilotLedger = collectCopilotLedger(runId, protocolRecording);
    const adapterLedger = collectAdapterLedger(runId, adapterValidation);
    const checks = [
        buildCoreNewSessionCheck(
            protocolRecording,
            adapterValidation,
            copilotLedger,
            adapterLedger
        ),
        buildResumeContinuationCheck(protocolRecording, adapterValidation),
        buildCommandApprovalCheck(
            protocolRecording,
            adapterValidation,
            copilotLedger,
            adapterLedger
        ),
        buildCommandApprovalDenyCheck(
            protocolRecording,
            adapterValidation,
            copilotLedger,
            adapterLedger
        ),
        buildFileApprovalCheck(protocolRecording, adapterValidation, copilotLedger, adapterLedger),
        buildCustomToolCallCheck(
            protocolRecording,
            adapterValidation,
            copilotLedger,
            adapterLedger
        ),
        buildToolDenyOrFailureCheck(
            protocolRecording,
            adapterValidation,
            copilotLedger,
            adapterLedger
        ),
    ];
    const verdict = combineStatuses(...checks.map((check) => check.status));

    return {
        runId,
        generatedAt: nowIso(),
        targetProfiles: ["SDK Core Profile", "Coding Agent Profile"],
        verdict,
        checks,
        ledgerCounts: {
            copilotCli: copilotLedger.length,
            codexAdapter: adapterLedger.length,
        },
        ledgers: {
            copilotCli: copilotLedger,
            codexAdapter: adapterLedger,
        },
        unsupportedProfiles: ["Interactive Profile", "Fidelity Profile", "Extended CLI Profile"],
    };
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

function mapCodexCommandApprovalToPermissionRequest(params: unknown): Record<string, unknown> {
    const payload = isRecord(params) ? params : {};
    const fullCommandText =
        typeof payload.command === "string"
            ? payload.command
            : Array.isArray(payload.proposedExecpolicyAmendment)
              ? payload.proposedExecpolicyAmendment.join(" ")
              : "";
    const availableDecisions = new Set(listAvailableDecisionIds(params));
    const commandActions = Array.isArray(payload.commandActions) ? payload.commandActions : [];
    const commands = commandActions.filter(isRecord).map((entry) => {
        const command =
            typeof entry.command === "string"
                ? entry.command
                : typeof entry.cmd === "string"
                  ? entry.cmd
                  : fullCommandText;
        return {
            identifier: command.split(/\s+/, 1)[0] ?? "command",
            readOnly: false,
        };
    });

    return {
        kind: "shell",
        toolCallId: typeof payload.itemId === "string" ? payload.itemId : undefined,
        intention:
            typeof payload.reason === "string" && payload.reason.length > 0
                ? payload.reason
                : "Execute a shell command outside the current approval boundary.",
        canOfferSessionApproval:
            availableDecisions.has("acceptForSession") ||
            availableDecisions.has("acceptWithExecpolicyAmendment"),
        fullCommandText,
        hasWriteFileRedirection: />{1,2}/.test(fullCommandText),
        commands: commands.length > 0 ? commands : [{ identifier: "command", readOnly: false }],
        possiblePaths: [],
        possibleUrls: [],
    };
}

function mapPermissionResultToCodexCommandDecision(
    permissionResult: unknown,
    requestParams: unknown
): unknown {
    const kind =
        isRecord(permissionResult) && typeof permissionResult.kind === "string"
            ? permissionResult.kind
            : null;
    if (kind !== "approved") {
        return "decline";
    }

    const availableDecisions = new Set(listAvailableDecisionIds(requestParams));
    if (availableDecisions.has("accept")) {
        return "accept";
    }

    const execpolicyAmendment = getProposedExecpolicyAmendment(requestParams);
    if (execpolicyAmendment && availableDecisions.has("acceptWithExecpolicyAmendment")) {
        return {
            acceptWithExecpolicyAmendment: {
                execpolicy_amendment: execpolicyAmendment,
            },
        };
    }

    const networkPolicyAmendment = getProposedNetworkPolicyAmendment(requestParams);
    if (networkPolicyAmendment && availableDecisions.has("applyNetworkPolicyAmendment")) {
        return {
            applyNetworkPolicyAmendment: {
                network_policy_amendment: networkPolicyAmendment,
            },
        };
    }

    if (availableDecisions.has("acceptForSession")) {
        return "acceptForSession";
    }

    return "accept";
}

function extractFileChangesFromParams(params: unknown): unknown[] {
    if (!isRecord(params)) {
        return [];
    }
    if (Array.isArray(params.changes)) {
        return params.changes;
    }
    const item = nestedRecord(params, "item");
    if (item && Array.isArray(item.changes)) {
        return item.changes;
    }
    return [];
}

function fileChangePaths(changes: unknown[]): string[] {
    return changes
        .filter(isRecord)
        .map((change) => (typeof change.path === "string" ? change.path : undefined))
        .filter((path): path is string => !!path);
}

function mapCodexFileChangeApprovalToPermissionRequest(
    params: unknown,
    changes: unknown[]
): Record<string, unknown> {
    const payload = isRecord(params) ? params : {};
    const paths = fileChangePaths(changes);
    return {
        kind: "write",
        toolCallId: typeof payload.itemId === "string" ? payload.itemId : undefined,
        intention:
            typeof payload.reason === "string" && payload.reason.length > 0
                ? payload.reason
                : "Apply file changes outside the current approval boundary.",
        grantRoot: typeof payload.grantRoot === "string" ? payload.grantRoot : undefined,
        paths,
        possiblePaths: paths,
        changes,
    };
}

function mapPermissionResultToCodexFileChangeDecision(permissionResult: unknown): unknown {
    const kind =
        isRecord(permissionResult) && typeof permissionResult.kind === "string"
            ? permissionResult.kind
            : null;
    if (kind !== "approved") {
        return "decline";
    }
    return "accept";
}

function toolDescriptorsFromSessionCreateParams(params: unknown): ToolDescriptor[] {
    if (!isRecord(params) || !Array.isArray(params.tools)) {
        return [];
    }

    return params.tools.filter(isRecord).map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : "unknown_tool",
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isRecord(tool.parameters) ? tool.parameters : undefined,
        skipPermission: tool.skipPermission === true,
    }));
}

function dynamicToolsFromDescriptors(tools: ToolDescriptor[]): Record<string, unknown>[] {
    return tools
        .filter((tool) => tool.name !== "unknown_tool")
        .map((tool) => ({
            name: tool.name,
            description: tool.description ?? `SDK tool ${tool.name}`,
            inputSchema: tool.parameters ?? {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            deferLoading: false,
        }));
}

function hasToolDescriptor(session: SessionState, toolName: string): boolean {
    return session.tools.some((tool) => tool.name === toolName);
}

function mapSdkToolResultToCodexDynamicToolResponse(
    result: unknown,
    error: unknown
): Record<string, unknown> {
    if (typeof error === "string" && error.length > 0) {
        return {
            contentItems: [{ type: "inputText", text: error }],
            success: false,
        };
    }

    if (typeof result === "string") {
        return {
            contentItems: [{ type: "inputText", text: result }],
            success: true,
        };
    }

    if (isRecord(result)) {
        const text =
            typeof result.textResultForLlm === "string"
                ? result.textResultForLlm
                : JSON.stringify(result);
        const resultType = typeof result.resultType === "string" ? result.resultType : "success";
        return {
            contentItems: [{ type: "inputText", text }],
            success: !["failure", "rejected", "denied", "timeout"].includes(resultType),
        };
    }

    return {
        contentItems: [
            {
                type: "inputText",
                text: result == null ? "" : JSON.stringify(result),
            },
        ],
        success: true,
    };
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

function mapCodexModels(result: unknown) {
    const data =
        result && typeof result === "object" && "data" in result && Array.isArray(result.data)
            ? result.data
            : [];

    return data
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => {
            const inputModalities = Array.isArray(entry.inputModalities)
                ? entry.inputModalities.filter((item): item is string => typeof item === "string")
                : [];
            const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
                ? entry.supportedReasoningEfforts
                      .map((item) =>
                          item && typeof item === "object" && "reasoningEffort" in item
                              ? item.reasoningEffort
                              : undefined
                      )
                      .filter((item): item is string => typeof item === "string")
                : [];

            return {
                id: typeof entry.id === "string" ? entry.id : "unknown",
                name: typeof entry.displayName === "string" ? entry.displayName : String(entry.id),
                capabilities: {
                    supports: {
                        vision: inputModalities.includes("image"),
                        reasoningEffort: supportedReasoningEfforts.length > 0,
                    },
                    limits: {
                        max_context_window_tokens: 0,
                    },
                },
                supportedReasoningEfforts,
                defaultReasoningEffort:
                    typeof entry.defaultReasoningEffort === "string"
                        ? entry.defaultReasoningEffort
                        : undefined,
            };
        });
}

function normalizedAdapterSandboxMode(): "dangerFullAccess" | "readOnly" | "workspaceWrite" {
    if (
        ADAPTER_SANDBOX_MODE === "danger-full-access" ||
        ADAPTER_SANDBOX_MODE === "dangerFullAccess"
    ) {
        return "dangerFullAccess";
    }
    if (ADAPTER_SANDBOX_MODE === "workspace-write" || ADAPTER_SANDBOX_MODE === "workspaceWrite") {
        return "workspaceWrite";
    }
    return "readOnly";
}

function codexThreadSandboxMode(): "danger-full-access" | "read-only" | "workspace-write" {
    const mode = normalizedAdapterSandboxMode();
    if (mode === "dangerFullAccess") {
        return "danger-full-access";
    }
    if (mode === "workspaceWrite") {
        return "workspace-write";
    }
    return "read-only";
}

function codexSandboxPolicy(): Record<string, unknown> {
    const mode = normalizedAdapterSandboxMode();
    if (mode === "dangerFullAccess") {
        return {
            type: "dangerFullAccess",
        };
    }

    if (mode === "workspaceWrite") {
        return {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: ADAPTER_NETWORK_ACCESS,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        };
    }

    return {
        type: "readOnly",
        networkAccess: ADAPTER_NETWORK_ACCESS,
    };
}

function attachClientProtocolRecorder(client: CopilotClient) {
    const transcripts: TranscriptEntry[] = [];
    const connection = (client as unknown as { connection?: MessageConnection }).connection;
    if (!connection) {
        throw new Error("Client connection not available for protocol recording");
    }

    const mutableConnection = connection as MessageConnection & {
        sendRequest: MessageConnection["sendRequest"];
    };
    const originalSendRequest = mutableConnection.sendRequest.bind(connection);
    mutableConnection.sendRequest = (async (method: string, ...args: unknown[]) => {
        const params = args[0];
        transcripts.push({
            at: nowIso(),
            direction: "sdk->copilot.request",
            message: { method, params },
        });
        try {
            const result = await originalSendRequest(method, ...(args as [unknown]));
            transcripts.push({
                at: nowIso(),
                direction: "copilot->sdk.response",
                message: { method, result },
            });
            return result;
        } catch (error) {
            transcripts.push({
                at: nowIso(),
                direction: "copilot->sdk.response",
                message: { method, error: summarizeUnknownError(error) },
            });
            throw error;
        }
    }) as MessageConnection["sendRequest"];

    const patchNotificationHandler = (
        name: "handleSessionEventNotification" | "handleSessionLifecycleNotification"
    ) => {
        const current = (client as unknown as Record<string, unknown>)[name];
        if (typeof current !== "function") {
            return;
        }
        const original = current.bind(client);
        (client as unknown as Record<string, unknown>)[name] = (notification: unknown) => {
            transcripts.push({
                at: nowIso(),
                direction:
                    name === "handleSessionEventNotification"
                        ? "copilot->sdk.notification.session.event"
                        : "copilot->sdk.notification.session.lifecycle",
                message: notification,
            });
            return original(notification);
        };
    };

    patchNotificationHandler("handleSessionEventNotification");
    patchNotificationHandler("handleSessionLifecycleNotification");

    return {
        summary() {
            return {
                requestMethods: transcripts
                    .filter((entry) => entry.direction === "sdk->copilot.request")
                    .map((entry) =>
                        entry.message &&
                        typeof entry.message === "object" &&
                        "method" in entry.message
                            ? String(entry.message.method)
                            : "unknown"
                    ),
                notificationKinds: transcripts
                    .filter((entry) => entry.direction.startsWith("copilot->sdk.notification"))
                    .map((entry) => entry.direction),
                transcripts,
            };
        },
    };
}

class RawCodexAppServerClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<JsonRpcId, PendingRequest>();
    private notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
    private requestHandlers = new Set<(request: JsonRpcRequest) => void>();
    private transcript: TranscriptEntry[] = [];
    private codexHome = prepareProbeCodexHome();

    async start(): Promise<void> {
        this.child = spawn(CODEX_BIN, ["app-server"], {
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
            clientInfo: {
                name: "copilot_sdk_adapter_spike",
                title: "Copilot SDK Adapter Spike",
                version: "0.0.0",
            },
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
            }, PROTOCOL_TIMEOUT_MS);
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

class _MinimalCopilotAdapterServer {
    private server = createServer();
    private sessions = new Map<string, SessionState>();
    private threadToSession = new Map<string, string>();
    private connections = new Map<string, MessageConnection>();
    private fileChangeSnapshots = new Map<string, unknown[]>();
    private pendingDynamicToolCalls = new Map<string, PendingDynamicToolCall>();
    private port = 0;
    private transcript: TranscriptEntry[] = [];
    private codexUnsubscribe: (() => void) | null = null;
    private codexRequestUnsubscribe: (() => void) | null = null;
    private codex: RawCodexAppServerClient;
    private nextConnectionId = 1;

    constructor(codex: RawCodexAppServerClient) {
        this.codex = codex;
    }

    async start(): Promise<number> {
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
            this.server.listen(0, "127.0.0.1", () => resolve());
        });

        const address = this.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Failed to determine adapter port");
        }
        this.port = address.port;
        return this.port;
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
            version: "codex-adapter-spike",
            protocolVersion: 3,
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
        if (
            session &&
            event &&
            typeof event === "object" &&
            (!("ephemeral" in event) || event.ephemeral !== true)
        ) {
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
            params && typeof params === "object" && "message" in params
                ? (params as { message?: string }).message
                : undefined;
        return {
            message: message ? `pong: ${message}` : "pong",
            timestamp: Date.now(),
            protocolVersion: 3,
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
            response.result &&
            typeof response.result === "object" &&
            "account" in response.result &&
            response.result.account &&
            typeof response.result.account === "object"
                ? (response.result.account as Record<string, unknown>)
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

    private async handleSessionCreate(params: unknown, connectionId: string) {
        if (!params || typeof params !== "object") {
            throw new Error("session.create params missing");
        }

        const payload = params as {
            sessionId?: string;
            workingDirectory?: string;
            model?: string;
            reasoningEffort?: string;
        };
        const sessionId = payload.sessionId ?? randomUUID();
        const cwd = payload.workingDirectory ?? process.cwd();
        const createdAt = nowIso();
        const tools = toolDescriptorsFromSessionCreateParams(params);
        const dynamicTools = dynamicToolsFromDescriptors(tools);

        const threadResponse = await this.codex.request("thread/start", {
            cwd,
            model: payload.model ?? MODEL,
            approvalPolicy: ADAPTER_APPROVAL_POLICY,
            approvalsReviewer: ADAPTER_APPROVALS_REVIEWER,
            sandbox: codexThreadSandboxMode(),
            ephemeral: true,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
        });
        if (threadResponse.error) {
            throw threadResponse.error;
        }

        const threadId =
            threadResponse.result &&
            typeof threadResponse.result === "object" &&
            "thread" in threadResponse.result &&
            threadResponse.result.thread &&
            typeof threadResponse.result.thread === "object" &&
            "id" in threadResponse.result.thread
                ? String(threadResponse.result.thread.id)
                : null;

        if (!threadId) {
            throw new Error("thread/start did not return thread.id");
        }

        const session: SessionState = {
            sessionId,
            threadId,
            createdAt,
            cwd,
            model: payload.model,
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
                producer: "codex-adapter-spike",
                copilotVersion: "codex-adapter-spike",
                selectedModel: payload.model ?? MODEL,
                reasoningEffort: payload.reasoningEffort,
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
        if (!params || typeof params !== "object") {
            throw new Error("session.resume params missing");
        }

        const payload = params as {
            sessionId?: string;
            workingDirectory?: string;
            model?: string;
            reasoningEffort?: string;
            disableResume?: boolean;
        };
        if (!payload.sessionId) {
            throw new Error("session.resume requires sessionId");
        }

        const session = this.sessions.get(payload.sessionId);
        if (!session) {
            throw new Error(`Unknown session: ${payload.sessionId}`);
        }

        const alreadyInUse = session.attachedConnectionIds.size > 0;
        const eventCount = session.events.length;
        session.attachedConnectionIds.add(connectionId);
        session.cwd = payload.workingDirectory ?? session.cwd;
        session.model = payload.model ?? session.model;
        session.resumeCount += 1;
        this.threadToSession.set(session.threadId, session.sessionId);

        const resumeTime = nowIso();
        this.emitLifecycle("session.resumed", session.sessionId, {
            resumeTime,
            eventCount,
            alreadyInUse,
        });

        if (!payload.disableResume) {
            this.emitSessionEvent(
                session.sessionId,
                createSessionEvent(session, "session.resume", {
                    resumeTime,
                    eventCount,
                    selectedModel: session.model ?? MODEL,
                    reasoningEffort: payload.reasoningEffort,
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
            params && typeof params === "object" && "sessionId" in params
                ? String((params as { sessionId: string }).sessionId)
                : undefined;
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
        if (!params || typeof params !== "object") {
            throw new Error("session.send params missing");
        }

        const payload = params as {
            sessionId?: string;
            prompt?: string;
        };
        if (!payload.sessionId || !payload.prompt) {
            throw new Error("session.send requires sessionId and prompt");
        }

        const session = this.sessions.get(payload.sessionId);
        if (!session || !session.attachedConnectionIds.has(connectionId)) {
            throw new Error(`Session not found: ${payload.sessionId}`);
        }

        const userMessageId = randomUUID();
        this.emitSessionEvent(
            session.sessionId,
            createSessionEvent(session, "user.message", {
                role: "user",
                content: payload.prompt,
                messageId: userMessageId,
            })
        );

        const response = await this.codex.request("turn/start", {
            threadId: session.threadId,
            input: [{ type: "text", text: payload.prompt, text_elements: [] }],
            model: session.model ?? MODEL,
            approvalPolicy: ADAPTER_APPROVAL_POLICY,
            approvalsReviewer: ADAPTER_APPROVALS_REVIEWER,
            sandboxPolicy: codexSandboxPolicy(),
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
            params && typeof params === "object" && "sessionId" in params
                ? String((params as { sessionId: string }).sessionId)
                : undefined;
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
        if (!params || typeof params !== "object") {
            return;
        }
        const paramsRecord = params as Record<string, unknown>;
        const fileChangeItemId =
            typeof paramsRecord.itemId === "string"
                ? paramsRecord.itemId
                : isRecord(paramsRecord.item) && typeof paramsRecord.item.id === "string"
                  ? paramsRecord.item.id
                  : undefined;
        const fileChanges = extractFileChangesFromParams(paramsRecord);
        if (fileChangeItemId && fileChanges.length > 0) {
            this.fileChangeSnapshots.set(fileChangeItemId, fileChanges);
        }

        const threadId =
            "threadId" in params
                ? String((params as { threadId: string }).threadId)
                : "thread" in params &&
                    params.thread &&
                    typeof params.thread === "object" &&
                    "id" in params.thread
                  ? String(params.thread.id)
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
            const item =
                "item" in params && params.item && typeof params.item === "object"
                    ? (params.item as Record<string, unknown>)
                    : null;
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
            const turn =
                "turn" in params && params.turn && typeof params.turn === "object"
                    ? (params.turn as Record<string, unknown>)
                    : null;
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
            this.handleCodexDynamicToolCall(request, params, session);
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
        session: SessionState
    ) {
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
        };
    }
}

async function startClientWithRecorder(client: CopilotClient) {
    const mutableClient = client as unknown as {
        connectToServer?: () => Promise<void>;
    };
    const originalConnectToServer = mutableClient.connectToServer;
    if (typeof originalConnectToServer !== "function") {
        throw new Error("CopilotClient.connectToServer is not available for recorder hook");
    }

    let recorder: ReturnType<typeof attachClientProtocolRecorder> | undefined;

    mutableClient.connectToServer = async () => {
        await originalConnectToServer.call(client);
        recorder = attachClientProtocolRecorder(client);
        mutableClient.connectToServer = originalConnectToServer;
    };

    try {
        await client.start();
    } catch (error) {
        mutableClient.connectToServer = originalConnectToServer;
        throw error;
    }

    if (!recorder) {
        recorder = attachClientProtocolRecorder(client);
    }

    return recorder;
}

async function runToolProbeWithClient(
    client: CopilotClient,
    observedEvents: Array<{ type: string; data?: unknown }>,
    stepTrace: string[],
    tracePrefix: string
): Promise<ToolProbeResult> {
    const prompt = toolProbePrompt();
    const handlerCalls: ToolHandlerCall[] = [];
    const assertionFailures: string[] = [];
    const session = await client.createSession({
        onPermissionRequest: approveAll,
        tools: [createLookupRuntimeFactTool(handlerCalls, assertionFailures)],
        model: MODEL,
        workingDirectory: WORKDIR,
        onEvent: (event) => observedEvents.push({ type: event.type, data: event.data }),
    });
    stepTrace.push(`${tracePrefix}.session_created`);
    const assistantMessage = await session.sendAndWait({ prompt }, PROTOCOL_TIMEOUT_MS);
    stepTrace.push(`${tracePrefix}.turn_completed`);
    await session.disconnect();
    stepTrace.push(`${tracePrefix}.disconnected`);

    return {
        prompt,
        toolName: TOOL_PROBE_NAME,
        expectedTopic: TOOL_PROBE_TOPIC,
        expectedResult: TOOL_PROBE_RESULT,
        assistantMessage: assistantMessage?.data.content,
        handlerCalls,
        assertionFailures,
    };
}

async function runToolFailureProbeWithClient(
    client: CopilotClient,
    observedEvents: Array<{ type: string; data?: unknown }>,
    stepTrace: string[],
    tracePrefix: string
): Promise<ToolFailureProbeResult> {
    const failurePrompt = toolFailurePrompt();
    const deniedPrompt = toolDeniedPrompt();
    const failureHandlerCalls: ToolHandlerCall[] = [];
    const deniedHandlerCalls: ToolHandlerCall[] = [];
    const assertionFailures: string[] = [];

    const failureSession = await client.createSession({
        onPermissionRequest: approveAll,
        tools: [createFailRuntimeFactTool(failureHandlerCalls, assertionFailures)],
        model: MODEL,
        workingDirectory: WORKDIR,
        onEvent: (event) => observedEvents.push({ type: event.type, data: event.data }),
    });
    stepTrace.push(`${tracePrefix}.failure_session_created`);
    const failureAssistantMessage = await failureSession.sendAndWait(
        { prompt: failurePrompt },
        PROTOCOL_TIMEOUT_MS
    );
    stepTrace.push(`${tracePrefix}.failure_turn_completed`);
    await failureSession.disconnect();
    stepTrace.push(`${tracePrefix}.failure_disconnected`);

    const deniedSession = await client.createSession({
        onPermissionRequest: approveAll,
        tools: [createDenyRuntimeFactTool(deniedHandlerCalls, assertionFailures)],
        model: MODEL,
        workingDirectory: WORKDIR,
        onEvent: (event) => observedEvents.push({ type: event.type, data: event.data }),
    });
    stepTrace.push(`${tracePrefix}.denied_session_created`);
    const deniedAssistantMessage = await deniedSession.sendAndWait(
        { prompt: deniedPrompt },
        PROTOCOL_TIMEOUT_MS
    );
    stepTrace.push(`${tracePrefix}.denied_turn_completed`);
    await deniedSession.disconnect();
    stepTrace.push(`${tracePrefix}.denied_disconnected`);

    return {
        failurePrompt,
        deniedPrompt,
        expectedTopic: TOOL_PROBE_TOPIC,
        failureToolName: TOOL_FAILURE_NAME,
        deniedToolName: TOOL_DENIED_NAME,
        expectedFailureError: TOOL_FAILURE_ERROR,
        expectedDeniedResult: TOOL_DENIED_RESULT,
        failureAssistantMessage: failureAssistantMessage?.data.content,
        deniedAssistantMessage: deniedAssistantMessage?.data.content,
        failureHandlerCalls,
        deniedHandlerCalls,
        assertionFailures,
    };
}

async function recordRealCopilotProtocol() {
    const client1 = new CopilotClient({
        autoStart: false,
        useStdio: false,
        logLevel: "info",
    });
    let client2: CopilotClient | undefined;

    const observedEventsClient1: Array<{ type: string; data?: unknown }> = [];
    const observedEventsClient2: Array<{ type: string; data?: unknown }> = [];
    const observedEventsApproval: Array<{ type: string; data?: unknown }> = [];
    const observedEventsDenial: Array<{ type: string; data?: unknown }> = [];
    const observedEventsFileApproval: Array<{ type: string; data?: unknown }> = [];
    const observedEventsFileDenial: Array<{ type: string; data?: unknown }> = [];
    const observedEventsToolProbe: Array<{ type: string; data?: unknown }> = [];
    const observedEventsToolFailureProbe: Array<{ type: string; data?: unknown }> = [];
    const stepTrace: string[] = [];
    let approvalProbe: ApprovalProbeResult | undefined;
    let denialProbe: ApprovalProbeResult | undefined;
    let fileApprovalProbe: ApprovalProbeResult | undefined;
    let fileDenialProbe: ApprovalProbeResult | undefined;
    let toolProbe: ToolProbeResult | undefined;
    let toolFailureProbe: ToolFailureProbeResult | undefined;

    try {
        stepTrace.push("client1.start");
        const recorder1 = await startClientWithRecorder(client1);
        stepTrace.push("client1.started");
        const status = await client1.getStatus();
        stepTrace.push("client1.status");
        const auth = await client1.getAuthStatus();
        stepTrace.push("client1.auth");
        const models = await client1.listModels();
        stepTrace.push("client1.models");
        const session1 = await client1.createSession({
            onPermissionRequest: approveAll,
            model: MODEL,
            workingDirectory: WORKDIR,
            onEvent: (event) => observedEventsClient1.push({ type: event.type, data: event.data }),
        });
        stepTrace.push("session1.created");
        const assistantMessage = await session1.sendAndWait(
            { prompt: PROMPT },
            PROTOCOL_TIMEOUT_MS
        );
        stepTrace.push("session1.first_turn_completed");
        const sessionId = session1.sessionId;
        await session1.disconnect();
        stepTrace.push("session1.disconnected");
        await client1.stop();
        stepTrace.push("client1.stopped");

        client2 = new CopilotClient({
            autoStart: false,
            useStdio: false,
            logLevel: "info",
        });
        stepTrace.push("client2.start");
        const recorder2 = await startClientWithRecorder(client2);
        stepTrace.push("client2.started");
        const session2 = await client2.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            workingDirectory: WORKDIR,
            onEvent: (event) => observedEventsClient2.push({ type: event.type, data: event.data }),
        });
        stepTrace.push("session2.resumed");
        const history = await session2.getMessages();
        stepTrace.push("session2.history_loaded");
        const resumedAssistantMessage = await session2.sendAndWait(
            { prompt: RESUME_PROMPT },
            PROTOCOL_TIMEOUT_MS
        );
        stepTrace.push("session2.second_turn_completed");
        await session2.disconnect();
        stepTrace.push("session2.disconnected");

        const approvalProbePath = approvalProbePathForBackend("copilot-cli");
        if (approvalProbePath) {
            const approvalProbePromptText = approvalProbePrompt(approvalProbePath);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(approvalProbePath);
            const approvalSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    const failures = validateShellPermissionRequest(
                        request,
                        approvalProbePath,
                        "hello"
                    );
                    permissionAssertionFailures.push(...failures);
                    if (failures.length > 0) {
                        return {
                            kind: "denied-interactively-by-user" as const,
                            feedback: failures.join("; "),
                        };
                    }
                    return { kind: "approved" as const };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsApproval.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("approvalProbe.session_created");
            const approvalAssistantMessage = await approvalSession.sendAndWait(
                { prompt: approvalProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("approvalProbe.turn_completed");
            await approvalSession.disconnect();
            stepTrace.push("approvalProbe.disconnected");
            approvalProbe = readApprovalProbeResult(
                approvalProbePath,
                approvalProbePromptText,
                approvalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const denialProbePath = denialProbePathForBackend("copilot-cli");
        if (denialProbePath) {
            const denialProbePromptText = denialProbePrompt(denialProbePath);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(denialProbePath);
            const denialSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    permissionAssertionFailures.push(
                        ...validateShellPermissionRequest(request, denialProbePath, "denied")
                    );
                    return {
                        kind: "denied-interactively-by-user" as const,
                        feedback:
                            "Denied by conformance probe. Do not retry this file edit or use another method.",
                    };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsDenial.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("denialProbe.session_created");
            const denialAssistantMessage = await denialSession.sendAndWait(
                { prompt: denialProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("denialProbe.turn_completed");
            await denialSession.disconnect();
            stepTrace.push("denialProbe.disconnected");
            denialProbe = readApprovalProbeResult(
                denialProbePath,
                denialProbePromptText,
                denialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const fileApprovalName = fileProbeNameForBackend("copilot-cli");
        const fileApprovalPath = fileProbePath(fileApprovalName);
        if (fileApprovalName && fileApprovalPath) {
            const fileApprovalPromptText = fileApprovalProbePrompt(fileApprovalName);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(fileApprovalPath);
            const fileApprovalSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    if (isRecord(request) && request.kind !== "write") {
                        return { kind: "approved" as const };
                    }
                    const failures = validateWritePermissionRequest(request, fileApprovalName);
                    permissionAssertionFailures.push(...failures);
                    if (failures.length > 0) {
                        return {
                            kind: "denied-interactively-by-user" as const,
                            feedback: failures.join("; "),
                        };
                    }
                    return { kind: "approved" as const };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsFileApproval.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("fileApprovalProbe.session_created");
            const fileApprovalAssistantMessage = await fileApprovalSession.sendAndWait(
                { prompt: fileApprovalPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileApprovalProbe.turn_completed");
            await fileApprovalSession.disconnect();
            stepTrace.push("fileApprovalProbe.disconnected");
            fileApprovalProbe = readApprovalProbeResult(
                fileApprovalPath,
                fileApprovalPromptText,
                fileApprovalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const fileDenialName = fileDenyProbeNameForBackend("copilot-cli");
        const fileDenialPath = fileProbePath(fileDenialName);
        if (fileDenialName && fileDenialPath) {
            const fileDenialPromptText = fileDenialProbePrompt(fileDenialName);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(fileDenialPath);
            const fileDenialSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    if (isRecord(request) && request.kind !== "write") {
                        return { kind: "approved" as const };
                    }
                    permissionAssertionFailures.push(
                        ...validateWritePermissionRequest(request, fileDenialName)
                    );
                    return {
                        kind: "denied-interactively-by-user" as const,
                        feedback:
                            "Denied by conformance probe. Do not retry this file edit or use another method.",
                    };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsFileDenial.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("fileDenialProbe.session_created");
            const fileDenialAssistantMessage = await fileDenialSession.sendAndWait(
                { prompt: fileDenialPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileDenialProbe.turn_completed");
            await fileDenialSession.disconnect();
            stepTrace.push("fileDenialProbe.disconnected");
            fileDenialProbe = readApprovalProbeResult(
                fileDenialPath,
                fileDenialPromptText,
                fileDenialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        if (RUN_TOOL_PROBE) {
            toolProbe = await runToolProbeWithClient(
                client2,
                observedEventsToolProbe,
                stepTrace,
                "toolProbe"
            );
        }

        if (RUN_TOOL_FAILURE_PROBE) {
            toolFailureProbe = await runToolFailureProbeWithClient(
                client2,
                observedEventsToolFailureProbe,
                stepTrace,
                "toolFailureProbe"
            );
        }

        const firstAnswer = assistantMessage?.data.content?.trim() ?? "";
        const resumedAnswer = resumedAssistantMessage?.data.content?.trim() ?? "";
        const expectedResumedAnswer = firstAnswer ? `${firstAnswer}${firstAnswer}` : "";

        return {
            clientRecording: {
                client1: recorder1.summary(),
                client2: recorder2.summary(),
            },
            status,
            auth,
            modelIds: models.map((model) => model.id),
            observedEventTypes: {
                client1: observedEventsClient1.map((event) => event.type),
                client2: observedEventsClient2.map((event) => event.type),
                approvalProbe: observedEventsApproval.map((event) => event.type),
                denialProbe: observedEventsDenial.map((event) => event.type),
                fileApprovalProbe: observedEventsFileApproval.map((event) => event.type),
                fileDenialProbe: observedEventsFileDenial.map((event) => event.type),
                toolProbe: observedEventsToolProbe.map((event) => event.type),
                toolFailureProbe: observedEventsToolFailureProbe.map((event) => event.type),
                history: history.map((event) => event.type),
            },
            assistantMessage: assistantMessage?.data.content,
            resumedAssistantMessage: resumedAssistantMessage?.data.content,
            expectedResumedAssistantMessage: expectedResumedAnswer,
            approvalProbe,
            denialProbe,
            fileApprovalProbe,
            fileDenialProbe,
            toolProbe,
            toolFailureProbe,
            replaceability: {
                supportsCreate: true,
                supportsResume: history.some((event) => event.type === "session.resume"),
                preservesHistory:
                    history.some((event) => event.type === "user.message") &&
                    history.some((event) => event.type === "assistant.message"),
                keepsStateAcrossResume:
                    expectedResumedAnswer.length > 0 && resumedAnswer === expectedResumedAnswer,
            },
            stepTrace,
        };
    } catch (error) {
        return {
            failure: summarizeUnknownError(error),
            observedEventTypes: {
                client1: observedEventsClient1.map((event) => event.type),
                client2: observedEventsClient2.map((event) => event.type),
                approvalProbe: observedEventsApproval.map((event) => event.type),
                denialProbe: observedEventsDenial.map((event) => event.type),
                fileApprovalProbe: observedEventsFileApproval.map((event) => event.type),
                fileDenialProbe: observedEventsFileDenial.map((event) => event.type),
                toolProbe: observedEventsToolProbe.map((event) => event.type),
                toolFailureProbe: observedEventsToolFailureProbe.map((event) => event.type),
            },
            approvalProbe,
            denialProbe,
            fileApprovalProbe,
            fileDenialProbe,
            toolProbe,
            toolFailureProbe,
            stepTrace,
        };
    } finally {
        await client1.stop().catch(() => {});
        await client2?.stop().catch(() => {});
    }
}

async function runAdapterValidation() {
    const adapter = new CodexCopilotAdapterServer({
        model: MODEL,
        approvalPolicy: ADAPTER_APPROVAL_POLICY,
        approvalsReviewer: ADAPTER_APPROVALS_REVIEWER,
        sandboxMode: ADAPTER_SANDBOX_MODE as CodexAdapterSandboxMode,
        networkAccess: ADAPTER_NETWORK_ACCESS,
        requestTimeoutMs: PROTOCOL_TIMEOUT_MS,
        clientInfo: {
            name: "copilot_sdk_adapter_spike",
            title: "Copilot SDK Adapter Spike",
            version: "0.0.0",
        },
    });
    const { port } = await adapter.start();
    const client1 = new CopilotClient({
        autoStart: false,
        cliUrl: `127.0.0.1:${port}`,
        logLevel: "info",
    });
    const observedEventsClient1: Array<{ type: string; data?: unknown }> = [];
    const observedEventsClient2: Array<{ type: string; data?: unknown }> = [];
    const observedEventsApproval: Array<{ type: string; data?: unknown }> = [];
    const observedEventsDenial: Array<{ type: string; data?: unknown }> = [];
    const observedEventsFileApproval: Array<{ type: string; data?: unknown }> = [];
    const observedEventsFileDenial: Array<{ type: string; data?: unknown }> = [];
    const observedEventsToolProbe: Array<{ type: string; data?: unknown }> = [];
    const observedEventsToolFailureProbe: Array<{ type: string; data?: unknown }> = [];
    let client2: CopilotClient | undefined;
    const stepTrace: string[] = [];
    let approvalProbe: ApprovalProbeResult | undefined;
    let denialProbe: ApprovalProbeResult | undefined;
    let fileApprovalProbe: ApprovalProbeResult | undefined;
    let fileDenialProbe: ApprovalProbeResult | undefined;
    let toolProbe: ToolProbeResult | undefined;
    let toolFailureProbe: ToolFailureProbeResult | undefined;

    try {
        stepTrace.push("client1.start");
        const recorder1 = await startClientWithRecorder(client1);
        stepTrace.push("client1.started");
        const status = await client1.getStatus();
        stepTrace.push("client1.status");
        const auth = await client1.getAuthStatus();
        stepTrace.push("client1.auth");
        const models = await client1.listModels();
        stepTrace.push("client1.models");
        const session1 = await client1.createSession({
            onPermissionRequest: approveAll,
            model: MODEL,
            workingDirectory: WORKDIR,
            onEvent: (event) => observedEventsClient1.push({ type: event.type, data: event.data }),
        });
        stepTrace.push("session1.created");
        const assistantMessage = await session1.sendAndWait(
            { prompt: PROMPT },
            PROTOCOL_TIMEOUT_MS
        );
        stepTrace.push("session1.first_turn_completed");
        const sessionId = session1.sessionId;
        await session1.disconnect();
        stepTrace.push("session1.disconnected");
        await client1.stop();
        stepTrace.push("client1.stopped");

        client2 = new CopilotClient({
            autoStart: false,
            cliUrl: `127.0.0.1:${port}`,
            logLevel: "info",
        });
        stepTrace.push("client2.start");
        const recorder2 = await startClientWithRecorder(client2);
        stepTrace.push("client2.started");
        const session2 = await client2.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            workingDirectory: WORKDIR,
            onEvent: (event) => observedEventsClient2.push({ type: event.type, data: event.data }),
        });
        stepTrace.push("session2.resumed");
        const history = await session2.getMessages();
        stepTrace.push("session2.history_loaded");
        const resumedAssistantMessage = await session2.sendAndWait(
            { prompt: RESUME_PROMPT },
            PROTOCOL_TIMEOUT_MS
        );
        stepTrace.push("session2.second_turn_completed");
        await session2.disconnect();
        stepTrace.push("session2.disconnected");

        const approvalProbePath = approvalProbePathForBackend("codex-adapter");
        if (approvalProbePath) {
            const approvalProbePromptText = approvalProbePrompt(approvalProbePath);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(approvalProbePath);
            const approvalSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    const failures = validateShellPermissionRequest(
                        request,
                        approvalProbePath,
                        "hello"
                    );
                    permissionAssertionFailures.push(...failures);
                    if (failures.length > 0) {
                        return {
                            kind: "denied-interactively-by-user" as const,
                            feedback: failures.join("; "),
                        };
                    }
                    return { kind: "approved" as const };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsApproval.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("approvalProbe.session_created");
            const approvalAssistantMessage = await approvalSession.sendAndWait(
                { prompt: approvalProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("approvalProbe.turn_completed");
            await approvalSession.disconnect();
            stepTrace.push("approvalProbe.disconnected");
            approvalProbe = readApprovalProbeResult(
                approvalProbePath,
                approvalProbePromptText,
                approvalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const denialProbePath = denialProbePathForBackend("codex-adapter");
        if (denialProbePath) {
            const denialProbePromptText = denialProbePrompt(denialProbePath);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(denialProbePath);
            const denialSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    permissionAssertionFailures.push(
                        ...validateShellPermissionRequest(request, denialProbePath, "denied")
                    );
                    return {
                        kind: "denied-interactively-by-user" as const,
                        feedback: "Denied by conformance probe.",
                    };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsDenial.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("denialProbe.session_created");
            const denialAssistantMessage = await denialSession.sendAndWait(
                { prompt: denialProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("denialProbe.turn_completed");
            await denialSession.disconnect();
            stepTrace.push("denialProbe.disconnected");
            denialProbe = readApprovalProbeResult(
                denialProbePath,
                denialProbePromptText,
                denialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const fileApprovalName = fileProbeNameForBackend("codex-adapter");
        const fileApprovalPath = fileProbePath(fileApprovalName);
        if (fileApprovalName && fileApprovalPath) {
            const fileApprovalPromptText = fileApprovalProbePrompt(fileApprovalName);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(fileApprovalPath);
            const fileApprovalSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    if (isRecord(request) && request.kind !== "write") {
                        return { kind: "approved" as const };
                    }
                    const failures = validateWritePermissionRequest(request, fileApprovalName);
                    permissionAssertionFailures.push(...failures);
                    if (failures.length > 0) {
                        return {
                            kind: "denied-interactively-by-user" as const,
                            feedback: failures.join("; "),
                        };
                    }
                    return { kind: "approved" as const };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsFileApproval.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("fileApprovalProbe.session_created");
            const fileApprovalAssistantMessage = await fileApprovalSession.sendAndWait(
                { prompt: fileApprovalPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileApprovalProbe.turn_completed");
            await fileApprovalSession.disconnect();
            stepTrace.push("fileApprovalProbe.disconnected");
            fileApprovalProbe = readApprovalProbeResult(
                fileApprovalPath,
                fileApprovalPromptText,
                fileApprovalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        const fileDenialName = fileDenyProbeNameForBackend("codex-adapter");
        const fileDenialPath = fileProbePath(fileDenialName);
        if (fileDenialName && fileDenialPath) {
            const fileDenialPromptText = fileDenialProbePrompt(fileDenialName);
            const permissionRequests: unknown[] = [];
            const permissionAssertionFailures: string[] = [];
            const preExisting = existsSync(fileDenialPath);
            const fileDenialSession = await client2.createSession({
                onPermissionRequest: (request) => {
                    permissionRequests.push(request);
                    if (isRecord(request) && request.kind !== "write") {
                        return { kind: "approved" as const };
                    }
                    permissionAssertionFailures.push(
                        ...validateWritePermissionRequest(request, fileDenialName)
                    );
                    return {
                        kind: "denied-interactively-by-user" as const,
                        feedback: "Denied by conformance probe.",
                    };
                },
                model: MODEL,
                workingDirectory: WORKDIR,
                onEvent: (event) =>
                    observedEventsFileDenial.push({ type: event.type, data: event.data }),
            });
            stepTrace.push("fileDenialProbe.session_created");
            const fileDenialAssistantMessage = await fileDenialSession.sendAndWait(
                { prompt: fileDenialPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileDenialProbe.turn_completed");
            await fileDenialSession.disconnect();
            stepTrace.push("fileDenialProbe.disconnected");
            fileDenialProbe = readApprovalProbeResult(
                fileDenialPath,
                fileDenialPromptText,
                fileDenialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting
            );
        }

        if (RUN_TOOL_PROBE) {
            toolProbe = await runToolProbeWithClient(
                client2,
                observedEventsToolProbe,
                stepTrace,
                "toolProbe"
            );
        }

        if (RUN_TOOL_FAILURE_PROBE) {
            toolFailureProbe = await runToolFailureProbeWithClient(
                client2,
                observedEventsToolFailureProbe,
                stepTrace,
                "toolFailureProbe"
            );
        }

        const firstAnswer = assistantMessage?.data.content?.trim() ?? "";
        const resumedAnswer = resumedAssistantMessage?.data.content?.trim() ?? "";
        const expectedResumedAnswer = firstAnswer ? `${firstAnswer}${firstAnswer}` : "";

        return {
            adapter: adapter.summary(),
            clientRecording: {
                client1: recorder1.summary(),
                client2: recorder2.summary(),
            },
            status,
            auth,
            modelIds: models.map((model) => model.id),
            observedEventTypes: {
                client1: observedEventsClient1.map((event) => event.type),
                client2: observedEventsClient2.map((event) => event.type),
                approvalProbe: observedEventsApproval.map((event) => event.type),
                denialProbe: observedEventsDenial.map((event) => event.type),
                fileApprovalProbe: observedEventsFileApproval.map((event) => event.type),
                fileDenialProbe: observedEventsFileDenial.map((event) => event.type),
                toolProbe: observedEventsToolProbe.map((event) => event.type),
                toolFailureProbe: observedEventsToolFailureProbe.map((event) => event.type),
                history: history.map((event) => event.type),
            },
            assistantMessage: assistantMessage?.data.content,
            resumedAssistantMessage: resumedAssistantMessage?.data.content,
            expectedResumedAssistantMessage: expectedResumedAnswer,
            approvalProbe,
            denialProbe,
            fileApprovalProbe,
            fileDenialProbe,
            toolProbe,
            toolFailureProbe,
            replaceability: {
                supportsCreate: true,
                supportsResume: history.some((event) => event.type === "session.resume"),
                preservesHistory:
                    history.some((event) => event.type === "user.message") &&
                    history.some((event) => event.type === "assistant.message"),
                keepsStateAcrossResume:
                    expectedResumedAnswer.length > 0 && resumedAnswer === expectedResumedAnswer,
            },
            stepTrace,
        };
    } catch (error) {
        return {
            adapter: adapter.summary(),
            failure: summarizeUnknownError(error),
            observedEventTypes: {
                client1: observedEventsClient1.map((event) => event.type),
                client2: observedEventsClient2.map((event) => event.type),
                approvalProbe: observedEventsApproval.map((event) => event.type),
                denialProbe: observedEventsDenial.map((event) => event.type),
                fileApprovalProbe: observedEventsFileApproval.map((event) => event.type),
                fileDenialProbe: observedEventsFileDenial.map((event) => event.type),
                toolProbe: observedEventsToolProbe.map((event) => event.type),
                toolFailureProbe: observedEventsToolFailureProbe.map((event) => event.type),
            },
            approvalProbe,
            denialProbe,
            fileApprovalProbe,
            fileDenialProbe,
            toolProbe,
            toolFailureProbe,
            stepTrace,
        };
    } finally {
        await client1.stop().catch(() => {});
        await client2?.stop().catch(() => {});
        await adapter.stop().catch(() => {});
    }
}

async function main() {
    const result: Record<string, unknown> = {
        runId: RUN_ID,
        phase: SPIKE_PHASE,
        prompt: PROMPT,
        resumePrompt: RESUME_PROMPT,
        model: MODEL,
    };

    if (SPIKE_PHASE === "record" || SPIKE_PHASE === "all") {
        result.protocolRecording = await recordRealCopilotProtocol();
    }

    if (SPIKE_PHASE === "adapter" || SPIKE_PHASE === "all") {
        result.adapterValidation = await runAdapterValidation();
    }

    result.conformanceReport = buildConformanceReport(RUN_ID, result);

    const output = JSON.stringify(result, null, 2);
    if (OUTPUT_PATH) {
        writeFileSync(OUTPUT_PATH, output);
    }
    console.log(output);
}

await main();
