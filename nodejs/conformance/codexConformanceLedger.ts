import { createHash } from "node:crypto";

export type TranscriptEntry = {
    at: string;
    direction: string;
    message: unknown;
};

export type LedgerBackend = "copilot-cli" | "codex-adapter";
export type LedgerEndpoint = "sdk" | "adapter" | "codex" | "copilot" | "unknown";
export type LedgerDirection =
    | "request"
    | "response"
    | "notification"
    | "event"
    | "connection"
    | "log";
export type LedgerStatus = "ok" | "denied" | "error" | "timeout";

export type NormalizedLedgerEntry = {
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

export type LedgerHopExpectation = {
    source?: LedgerEndpoint;
    target?: LedgerEndpoint;
    method: string;
    direction?: LedgerDirection;
};

export function normalizeTranscript(
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

export function collectCopilotLedger(
    runId: string,
    protocolRecording: unknown
): NormalizedLedgerEntry[] {
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

export function collectAdapterLedger(
    runId: string,
    adapterValidation: unknown
): NormalizedLedgerEntry[] {
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

export function hasLedgerHop(
    ledger: NormalizedLedgerEntry[],
    expected: LedgerHopExpectation
): boolean {
    return ledger.some((entry) => ledgerEntryMatches(entry, expected));
}

export function countLedgerHops(
    ledger: NormalizedLedgerEntry[],
    expected: LedgerHopExpectation
): number {
    return ledger.filter((entry) => ledgerEntryMatches(entry, expected)).length;
}

function ledgerEntryMatches(entry: NormalizedLedgerEntry, expected: LedgerHopExpectation): boolean {
    return (
        entry.method === expected.method &&
        (expected.source === undefined || entry.source === expected.source) &&
        (expected.target === undefined || entry.target === expected.target) &&
        (expected.direction === undefined || entry.direction === expected.direction)
    );
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

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
