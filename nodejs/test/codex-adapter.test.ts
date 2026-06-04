import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { approveAll, CopilotClient } from "../src/index.js";
import {
    CODEX_ADAPTER_CAPABILITIES,
    CodexCopilotAdapterServer,
} from "../src/experimental/codexAdapter.js";
import { CodexAppServerGateway } from "../src/experimental/codexAppServerGateway.js";

type FakeCodexMessage = {
    method: string;
    params?: unknown;
};

type FakeCodexResponse = {
    id: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};

class FakeCodexGateway {
    readonly requests: FakeCodexMessage[] = [];
    readonly notifications: FakeCodexMessage[] = [];
    readonly responses: Array<{ id: number | string; result?: unknown; error?: unknown }> = [];
    private notificationHandlers = new Set<(notification: FakeCodexMessage) => void>();
    private requestHandlers = new Set<(request: FakeCodexMessage & { id: number | string }) => void>();
    private readonly threadId = "fake-thread-1";

    async start(): Promise<void> {}

    async stop(): Promise<void> {}

    async request(method: string, params?: unknown): Promise<FakeCodexResponse> {
        this.requests.push({ method, params });

        if (method === "thread/start") {
            return {
                id: this.requests.length,
                result: {
                    thread: {
                        id: this.threadId,
                    },
                },
            };
        }

        if (method === "turn/start") {
            setTimeout(() => {
                this.emitNotification("item/completed", {
                    threadId: this.threadId,
                    item: {
                        type: "agentMessage",
                        id: "assistant-message-1",
                        text: "adapter characterization reply",
                    },
                });
                this.emitNotification("turn/completed", {
                    threadId: this.threadId,
                    turn: {
                        status: "completed",
                    },
                });
            }, 0);
            return {
                id: this.requests.length,
                result: {
                    turn: {
                        id: "fake-turn-1",
                    },
                },
            };
        }

        if (method === "model/list") {
            return {
                id: this.requests.length,
                result: {
                    data: [],
                },
            };
        }

        if (method === "account/read") {
            return {
                id: this.requests.length,
                result: {
                    account: {
                        type: "apiKey",
                        planType: "test",
                    },
                },
            };
        }

        return {
            id: this.requests.length,
            result: {},
        };
    }

    notify(method: string, params?: unknown): void {
        this.notifications.push({ method, params });
    }

    respond(id: number | string, result?: unknown, error?: unknown): void {
        this.responses.push({ id, result, error });
    }

    onNotification(handler: (notification: FakeCodexMessage) => void): () => void {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }

    onRequest(handler: (request: FakeCodexMessage & { id: number | string }) => void): () => void {
        this.requestHandlers.add(handler);
        return () => this.requestHandlers.delete(handler);
    }

    summary() {
        return {
            codexHome: "fake-codex-home",
            transcripts: this.requests,
        };
    }

    private emitNotification(method: string, params?: unknown): void {
        const notification = { method, params };
        for (const handler of this.notificationHandlers) {
            handler(notification);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function readPackageJson(): Record<string, unknown> {
    const raw = readFileSync(join(import.meta.dirname, "../package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
        throw new Error("package.json did not parse as an object");
    }
    return parsed;
}

function listTypeScriptFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root)) {
        const entryPath = join(root, entry);
        const stats = statSync(entryPath);
        if (stats.isDirectory()) {
            files.push(...listTypeScriptFiles(entryPath));
            continue;
        }
        if (entryPath.endsWith(".ts")) {
            files.push(entryPath);
        }
    }
    return files;
}

describe("Codex adapter experimental boundary", () => {
    it("declares the selected runtime profiles and supported capability flags", () => {
        expect(CODEX_ADAPTER_CAPABILITIES.targetProfiles).toEqual([
            "SDK Core Profile",
            "Coding Agent Profile",
        ]);

        const supported = new Set(
            CODEX_ADAPTER_CAPABILITIES.flags
                .filter((flag) => flag.status === "supported")
                .map((flag) => flag.id)
        );

        expect(supported).toEqual(
            new Set([
                "ping",
                "status.get",
                "auth.getStatus",
                "models.list",
                "session.create",
                "session.resume",
                "session.getMessages",
                "session.send",
                "session.destroy",
                "command approval",
                "file approval",
                "custom tool call",
                "tool failure/denial",
            ])
        );
    });

    it("keeps profile expansion explicit instead of silently claiming full CLI parity", () => {
        const deferred = new Set(
            CODEX_ADAPTER_CAPABILITIES.flags
                .filter((flag) => flag.status === "deferred")
                .map((flag) => flag.id)
        );

        expect(deferred).toEqual(
            new Set(["Interactive Profile", "Fidelity Profile", "Extended CLI Profile"])
        );
    });

    it("exposes a named server boundary instead of only an example script", () => {
        const adapter = new CodexCopilotAdapterServer({ codexBin: "codex" });
        expect(adapter.capabilities()).toBe(CODEX_ADAPTER_CAPABILITIES);
        expect(() => adapter.clientOptions()).toThrow(/not started/);
    });

    it("keeps root SDK exports free of experimental adapter internals", async () => {
        const sdk = await import("../src/index.js");
        expect("CodexCopilotAdapterServer" in sdk).toBe(false);
        expect("CodexAppServerClient" in sdk).toBe(false);
        expect("CODEX_ADAPTER_CAPABILITIES" in sdk).toBe(false);
    });

    it("keeps experimental adapter subpath free of raw gateway classes", async () => {
        const adapterModule = await import("../src/experimental/codexAdapter.js");
        expect("CodexCopilotAdapterServer" in adapterModule).toBe(true);
        expect("CODEX_ADAPTER_CAPABILITIES" in adapterModule).toBe(true);
        expect("CodexAppServerClient" in adapterModule).toBe(false);
        expect("CodexAppServerGateway" in adapterModule).toBe(false);
    });

    it("does not publish internal runtime implementation subpaths", () => {
        const packageJson = readPackageJson();
        const exportsValue = packageJson.exports;
        expect(isRecord(exportsValue)).toBe(true);

        const exportKeys = Object.keys(exportsValue as Record<string, unknown>);
        expect(exportKeys).toContain("./experimental/codex-adapter");
        expect(exportKeys).not.toContain("./experimental/codex-adapter/internal");
        expect(exportKeys.filter((key) => key.includes("internal"))).toEqual([]);
    });

    it("keeps core SDK source files from importing experimental Codex adapter internals", () => {
        const srcRoot = join(import.meta.dirname, "../src");
        const checkedFiles = listTypeScriptFiles(srcRoot).filter(
            (filePath) => !filePath.includes(`${join("src", "experimental")}/`)
        );

        const violations = checkedFiles
            .map((filePath) => ({
                filePath,
                content: readFileSync(filePath, "utf8"),
            }))
            .filter(({ content }) =>
                [
                    "experimental/codexAdapter",
                    "CodexCopilotAdapterServer",
                    "CodexAppServerClient",
                    "CODEX_ADAPTER_CAPABILITIES",
                ].some((needle) => content.includes(needle))
            )
            .map(({ filePath }) => filePath);

        expect(violations).toEqual([]);
    });

    it("characterizes create and send behavior through the SDK-facing adapter seam", async () => {
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fakeCodex;
        await adapter.start();
        onTestFinished(() => adapter.stop());

        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        onTestFinished(async () => {
            await client.stop();
        });

        const session = await client.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            systemMessage: {
                mode: "replace",
                content: "You are the adapter characterization test assistant.",
            },
        });

        const threadStart = fakeCodex.requests.find((entry) => entry.method === "thread/start");
        expect(threadStart?.params).toEqual(
            expect.objectContaining({
                model: "gpt-test",
                baseInstructions: "You are the adapter characterization test assistant.",
            })
        );

        const assistantMessage = await session.sendAndWait(
            {
                prompt: "Reply through the fake Codex gateway.",
            },
            1_000
        );
        expect(assistantMessage?.data.content).toBe("adapter characterization reply");

        const turnStart = fakeCodex.requests.find((entry) => entry.method === "turn/start");
        expect(turnStart?.params).toEqual(
            expect.objectContaining({
                threadId: "fake-thread-1",
                model: "gpt-test",
            })
        );

        const events = await session.getMessages();
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
                "session.start",
                "user.message",
                "assistant.message",
                "session.idle",
            ])
        );
    });
});

describe("Codex app-server gateway internal boundary", () => {
    it("keeps pre-start gateway errors observable instead of silently succeeding", () => {
        const gateway = new CodexAppServerGateway({
            codexBin: "codex",
            codexHome: "/tmp/copilot-sdk-missing-codex-home",
            isolateCodexHome: false,
        });

        expect(() => gateway.request("model/list")).toThrow(/not started/);
        expect(() => gateway.notify("initialized", {})).toThrow(/not started/);
        expect(() => gateway.respond(1, {})).toThrow(/not started/);
        expect(gateway.summary()).toEqual({
            codexHome: "/tmp/copilot-sdk-missing-codex-home",
            transcripts: [],
        });
    });
});
