import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CodexRuntimeSessionRecord = {
    sdkSessionId: string;
    runtime: "codex";
    runtimeSessionId: string;
    codexThreadId: string;
    cwd: string;
    model?: string;
    toolFingerprint: string;
    codexHomeIdentity?: string;
    createdAt: string;
    updatedAt: string;
};

type StorePayload = {
    version: 1;
    records: CodexRuntimeSessionRecord[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function parseRecord(value: unknown): CodexRuntimeSessionRecord | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.sdkSessionId !== "string" ||
        value.runtime !== "codex" ||
        typeof value.runtimeSessionId !== "string" ||
        typeof value.codexThreadId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.toolFingerprint !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
    ) {
        return null;
    }

    return {
        sdkSessionId: value.sdkSessionId,
        runtime: "codex",
        runtimeSessionId: value.runtimeSessionId,
        codexThreadId: value.codexThreadId,
        cwd: value.cwd,
        model: typeof value.model === "string" ? value.model : undefined,
        toolFingerprint: value.toolFingerprint,
        codexHomeIdentity:
            typeof value.codexHomeIdentity === "string" ? value.codexHomeIdentity : undefined,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

function parsePayload(value: unknown): StorePayload {
    if (!isRecord(value) || !Array.isArray(value.records)) {
        return { version: 1, records: [] };
    }

    return {
        version: 1,
        records: value.records.map(parseRecord).filter((record) => record !== null),
    };
}

export class CodexAdapterSessionStore {
    private records = new Map<string, CodexRuntimeSessionRecord>();

    constructor(private readonly filePath?: string) {
        this.load();
    }

    get(sessionId: string): CodexRuntimeSessionRecord | undefined {
        return this.records.get(sessionId);
    }

    upsert(record: CodexRuntimeSessionRecord): void {
        this.records.set(record.sdkSessionId, record);
        this.flush();
    }

    delete(sessionId: string): void {
        this.records.delete(sessionId);
        this.flush();
    }

    private load(): void {
        if (!this.filePath || !existsSync(this.filePath)) {
            return;
        }

        const payload = parsePayload(JSON.parse(readFileSync(this.filePath, "utf8")));
        this.records = new Map(payload.records.map((record) => [record.sdkSessionId, record]));
    }

    private flush(): void {
        if (!this.filePath) {
            return;
        }

        mkdirSync(dirname(this.filePath), { recursive: true });
        const payload: StorePayload = {
            version: 1,
            records: [...this.records.values()].sort((a, b) =>
                a.sdkSessionId.localeCompare(b.sdkSessionId)
            ),
        };
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
        renameSync(tmpPath, this.filePath);
    }
}
