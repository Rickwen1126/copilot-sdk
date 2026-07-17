import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { approveAll, CopilotClient, defineTool, type PermissionHandler } from "../src/index.js";
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
    private requestHandlers = new Set<
        (request: FakeCodexMessage & { id: number | string }) => void
    >();
    private nextThreadNumber = 1;

    async start(): Promise<void> {}

    async stop(): Promise<void> {}

    async request(method: string, params?: unknown): Promise<FakeCodexResponse> {
        this.requests.push({ method, params });

        if (method === "thread/start") {
            const threadId = `fake-thread-${this.nextThreadNumber}`;
            this.nextThreadNumber += 1;
            return {
                id: this.requests.length,
                result: {
                    thread: {
                        id: threadId,
                    },
                },
            };
        }

        if (method === "thread/resume") {
            const threadId =
                isRecord(params) && typeof params.threadId === "string"
                    ? params.threadId
                    : "fake-thread-1";
            return {
                id: this.requests.length,
                result: {
                    thread: {
                        id: threadId,
                    },
                },
            };
        }

        if (method === "turn/start") {
            const threadId =
                isRecord(params) && typeof params.threadId === "string"
                    ? params.threadId
                    : "fake-thread-1";
            setTimeout(() => {
                this.emitNotification("item/completed", {
                    threadId,
                    item: {
                        type: "agentMessage",
                        id: "assistant-message-1",
                        text: "adapter characterization reply",
                    },
                });
                this.emitNotification("turn/completed", {
                    threadId,
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

    emitRequest(request: FakeCodexMessage & { id: number | string }): void {
        for (const handler of this.requestHandlers) {
            handler(request);
        }
    }

    summary() {
        return {
            codexHome: "fake-codex-home",
            transcripts: this.requests,
        };
    }

    emitNotification(method: string, params?: unknown): void {
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
                "session.abort",
                "session.destroy",
                "session.delete",
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
                approvalPolicy: "on-request",
                approvalsReviewer: "auto_review",
                sandbox: "workspace-write",
                ephemeral: false,
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
                approvalPolicy: "on-request",
                approvalsReviewer: "auto_review",
                sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [],
                    networkAccess: false,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false,
                },
            })
        );

        const events = await session.getEvents();
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
                "session.start",
                "user.message",
                "assistant.message",
                "session.idle",
            ])
        );
    });

    it("allows network access to be explicitly enabled inside the workspace sandbox", async () => {
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            sandboxMode: "workspaceWrite",
            networkAccess: true,
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
        });
        await session.sendAndWait(
            {
                prompt: "Use the explicitly network-enabled workspace sandbox.",
            },
            1_000
        );

        const turnStart = fakeCodex.requests.find((entry) => entry.method === "turn/start");
        expect(turnStart?.params).toEqual(
            expect.objectContaining({
                sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [],
                    networkAccess: true,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false,
                },
            })
        );
    });

    it("creates isolated fallback workspaces when the SDK omits workingDirectory", async () => {
        const fallbackWorkspaceParent = mkdtempSync(join(tmpdir(), "codex-adapter-workspaces-"));
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            fallbackWorkspaceParent,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fakeCodex;
        await adapter.start();
        onTestFinished(() => adapter.stop());

        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        onTestFinished(async () => {
            await client.stop();
        });

        const first = await client.createSession({
            onPermissionRequest: approveAll,
        });
        const second = await client.createSession({
            onPermissionRequest: approveAll,
        });

        const threadStarts = fakeCodex.requests.filter((entry) => entry.method === "thread/start");
        const firstCwd = isRecord(threadStarts[0]?.params) ? threadStarts[0].params.cwd : null;
        const secondCwd = isRecord(threadStarts[1]?.params) ? threadStarts[1].params.cwd : null;

        expect(first.sessionId).not.toBe(second.sessionId);
        expect(firstCwd).not.toBe(secondCwd);
        expect(dirname(String(firstCwd))).toBe(fallbackWorkspaceParent);
        expect(dirname(String(secondCwd))).toBe(fallbackWorkspaceParent);
        expect(readdirSync(fallbackWorkspaceParent)).toHaveLength(2);
    });

    it("preserves an explicit workingDirectory instead of creating a fallback workspace", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-adapter-explicit-"));
        const fallbackWorkspaceParent = join(root, "fallback-workspaces");
        const explicitWorkspace = join(root, "explicit-workspace");
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            fallbackWorkspaceParent,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fakeCodex;
        await adapter.start();
        onTestFinished(() => adapter.stop());

        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        onTestFinished(async () => {
            await client.stop();
        });

        await client.createSession({
            workingDirectory: explicitWorkspace,
            onPermissionRequest: approveAll,
        });

        const threadStart = fakeCodex.requests.find((entry) => entry.method === "thread/start");
        expect(threadStart?.params).toEqual(
            expect.objectContaining({
                cwd: explicitWorkspace,
            })
        );
        expect(() => readdirSync(fallbackWorkspaceParent)).toThrow();
    });

    it("logs but does not block concurrent threads in the same explicit workspace", async () => {
        const explicitWorkspace = mkdtempSync(join(tmpdir(), "codex-adapter-shared-workspace-"));
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

        const first = await client.createSession({
            workingDirectory: explicitWorkspace,
            onPermissionRequest: approveAll,
        });
        const second = await client.createSession({
            workingDirectory: explicitWorkspace,
            onPermissionRequest: approveAll,
        });

        expect(first.sessionId).not.toBe(second.sessionId);
        expect(fakeCodex.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(
            2
        );

        const summary = adapter.summary() as {
            transcripts: Array<{ direction?: string; message?: unknown }>;
        };
        const concurrentLog = summary.transcripts.find(
            (entry) => entry.direction === "adapter.workspace.concurrent_threads"
        );
        expect(concurrentLog?.message).toEqual(
            expect.objectContaining({
                operation: "create",
                cwd: explicitWorkspace,
                sessionId: second.sessionId,
                threadId: "fake-thread-2",
                overlappingSessions: [
                    expect.objectContaining({
                        sessionId: first.sessionId,
                        threadId: "fake-thread-1",
                    }),
                ],
            })
        );
    });

    it("maps SDK disconnect and delete to Codex thread lifecycle operations", async () => {
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
        });

        await session.disconnect();
        await session.disconnect();
        expect(fakeCodex.requests).toContainEqual({
            method: "thread/unsubscribe",
            params: {
                threadId: "fake-thread-1",
            },
        });
        expect(
            fakeCodex.requests.filter((entry) => entry.method === "thread/unsubscribe")
        ).toHaveLength(1);

        await client.resumeSession(session.sessionId, {
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        expect(fakeCodex.requests).toContainEqual({
            method: "thread/resume",
            params: expect.objectContaining({
                threadId: "fake-thread-1",
                approvalPolicy: "on-request",
                approvalsReviewer: "auto_review",
                sandbox: "workspace-write",
            }),
        });

        await client.deleteSession(session.sessionId);
        expect(fakeCodex.requests).toContainEqual({
            method: "thread/archive",
            params: {
                threadId: "fake-thread-1",
            },
        });

        await expect(
            client.resumeSession(session.sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
            })
        ).rejects.toThrow(/Unknown session/);
    });

    it("resumes from the persisted runtime session mapping after adapter restart", async () => {
        const storePath = join(
            mkdtempSync(join(tmpdir(), "codex-adapter-session-store-")),
            "sessions.json"
        );
        const firstCodex = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstCodex;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();

        const session = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        const sessionId = session.sessionId;
        await session.disconnect();
        await firstClient.stop();
        await firstAdapter.stop();

        const secondCodex = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondCodex;
        await secondAdapter.start();
        onTestFinished(() => secondAdapter.stop());
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        onTestFinished(async () => {
            await secondClient.stop();
        });

        const resumed = await secondClient.resumeSession(sessionId, {
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });

        expect(secondCodex.requests).not.toContainEqual(
            expect.objectContaining({ method: "thread/start" })
        );
        expect(secondCodex.requests).toContainEqual({
            method: "thread/resume",
            params: expect.objectContaining({
                threadId: "fake-thread-1",
            }),
        });

        const assistantMessage = await resumed.sendAndWait(
            {
                prompt: "Continue after adapter restart.",
            },
            1_000
        );
        expect(assistantMessage?.data.content).toBe("adapter characterization reply");
    });

    it("rejects in-memory resume when the requested tool set changes", async () => {
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
            tools: [
                defineTool("stable_tool", {
                    description: "Original tool shape",
                    handler: () => "stable",
                }),
            ],
        });

        await expect(
            client.resumeSession(session.sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
                tools: [
                    defineTool("changed_tool", {
                        description: "Changed tool shape",
                        handler: () => "changed",
                    }),
                ],
            })
        ).rejects.toThrow(/tool set is incompatible with the active runtime session/);

        expect(fakeCodex.requests.filter((entry) => entry.method === "thread/resume")).toHaveLength(
            0
        );
    });

    it("rejects adapter-restart resume when persisted tool mapping is not supplied", async () => {
        const storePath = join(
            mkdtempSync(join(tmpdir(), "codex-adapter-session-store-tools-")),
            "sessions.json"
        );
        const firstCodex = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstCodex;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();

        const session = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: [
                defineTool("restart_tool", {
                    description: "Tool that must be reattached after restart",
                    handler: () => "restart",
                }),
            ],
        });
        const sessionId = session.sessionId;
        await session.disconnect();
        await firstClient.stop();
        await firstAdapter.stop();

        const secondCodex = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondCodex;
        await secondAdapter.start();
        onTestFinished(() => secondAdapter.stop());
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        onTestFinished(async () => {
            await secondClient.stop();
        });

        await expect(
            secondClient.resumeSession(sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
            })
        ).rejects.toThrow(/matching tools are required after adapter restart/);

        expect(
            secondCodex.requests.filter((entry) => entry.method === "thread/resume")
        ).toHaveLength(0);
    });

    it("rejects adapter-restart resume when the supplied tool set does not match the persisted mapping", async () => {
        const storePath = join(
            mkdtempSync(join(tmpdir(), "codex-adapter-session-store-tool-mismatch-")),
            "sessions.json"
        );
        const firstCodex = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstCodex;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();

        const session = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: [
                defineTool("original_restart_tool", {
                    description: "Original persisted tool",
                    handler: () => "original",
                }),
            ],
        });
        const sessionId = session.sessionId;
        await session.disconnect();
        await firstClient.stop();
        await firstAdapter.stop();

        const secondCodex = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondCodex;
        await secondAdapter.start();
        onTestFinished(() => secondAdapter.stop());
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        onTestFinished(async () => {
            await secondClient.stop();
        });

        await expect(
            secondClient.resumeSession(sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
                tools: [
                    defineTool("changed_restart_tool", {
                        description: "Changed persisted tool",
                        handler: () => "changed",
                    }),
                ],
            })
        ).rejects.toThrow(/tool set is incompatible with the persisted runtime session/);

        expect(
            secondCodex.requests.filter((entry) => entry.method === "thread/resume")
        ).toHaveLength(0);
    });

    it("caps adapter transcripts for long-running server summaries", async () => {
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            transcriptLimit: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fakeCodex;
        await adapter.start();
        onTestFinished(() => adapter.stop());
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        onTestFinished(async () => {
            await client.stop();
        });

        await client.ping();
        await client.ping();
        await client.ping();
        await client.ping();

        const summary = adapter.summary() as { transcripts: unknown[] };
        expect(summary.transcripts).toHaveLength(3);
    });

    it("times out pending protocol-v3 dynamic tool calls and returns a failed Codex response", async () => {
        const fakeCodex = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            requestTimeoutMs: 10,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fakeCodex;
        await adapter.start();
        onTestFinished(() => adapter.stop());
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        onTestFinished(async () => {
            await client.stop();
        });

        await client.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: [
                defineTool("slow_tool", {
                    description: "Tool that never reports a result",
                    handler: () => new Promise(() => {}),
                }),
            ],
        });

        fakeCodex.emitRequest({
            id: "tool-timeout-1",
            method: "item/tool/call",
            params: {
                threadId: "fake-thread-1",
                tool: "slow_tool",
                callId: "slow-call-1",
                arguments: {},
            },
        });
        await delay(30);

        expect(fakeCodex.responses).toContainEqual({
            id: "tool-timeout-1",
            result: {
                contentItems: [
                    {
                        type: "inputText",
                        text: "Timed out waiting for SDK tool result: slow_tool",
                    },
                ],
                success: false,
            },
            error: undefined,
        });

        expect(fakeCodex.responses).toHaveLength(1);
    });
});

describe("Codex app-server gateway internal boundary", () => {
    it("keeps pre-start gateway errors observable instead of silently succeeding", async () => {
        const gateway = new CodexAppServerGateway({
            codexBin: "codex",
            codexHome: "/tmp/copilot-sdk-missing-codex-home",
            isolateCodexHome: false,
        });

        await expect(gateway.request("model/list")).rejects.toThrow(/not started/);
        expect(() => gateway.notify("initialized", {})).toThrow(/not started/);
        expect(() => gateway.respond(1, {})).toThrow(/not started/);
        expect(gateway.summary()).toEqual({
            codexHome: "/tmp/copilot-sdk-missing-codex-home",
            transcripts: [],
        });
    });
});

describe("Codex adapter v1.0.7 permission flow", () => {
    async function startAdapterAndClient(onPermissionRequest: PermissionHandler) {
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

        await client.createSession({
            model: "gpt-test",
            onPermissionRequest,
        });
        return { fakeCodex, adapter };
    }

    async function waitForCodexResponse(
        fakeCodex: FakeCodexGateway,
        id: number | string,
        timeoutMs = 2_000
    ) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const response = fakeCodex.responses.find((entry) => entry.id === id);
            if (response) {
                return response;
            }
            await delay(10);
        }
        throw new Error(`Timed out waiting for codex response id=${String(id)}`);
    }

    it("delivers approvals via permission.requested events and maps approve-once to accept", async () => {
        const { fakeCodex, adapter } = await startAdapterAndClient(approveAll);

        fakeCodex.emitRequest({
            id: "approval-accept-1",
            method: "item/commandExecution/requestApproval",
            params: {
                threadId: "fake-thread-1",
                itemId: "cmd-1",
                command: "echo approved",
            },
        });

        const response = await waitForCodexResponse(fakeCodex, "approval-accept-1");
        expect(response.result).toEqual({ decision: "accept" });

        const transcripts = (
            adapter.summary() as { transcripts: Array<{ direction: string; message: unknown }> }
        ).transcripts;
        const eventDeliveries = transcripts.filter(
            (entry) =>
                entry.direction === "adapter->sdk.event" &&
                isRecord(entry.message) &&
                entry.message.method === "permission.requested"
        );
        expect(eventDeliveries).toHaveLength(1);
        const legacyRequests = transcripts.filter(
            (entry) =>
                entry.direction === "adapter->sdk.request" &&
                isRecord(entry.message) &&
                entry.message.method === "permission.request"
        );
        expect(legacyRequests).toHaveLength(0);
    });

    it("maps a rejecting permission handler to a codex decline", async () => {
        const { fakeCodex } = await startAdapterAndClient(() => ({ kind: "reject" as const }));

        fakeCodex.emitRequest({
            id: "approval-decline-1",
            method: "item/commandExecution/requestApproval",
            params: {
                threadId: "fake-thread-1",
                itemId: "cmd-2",
                command: "rm -rf /forbidden",
            },
        });

        const response = await waitForCodexResponse(fakeCodex, "approval-decline-1");
        expect(response.result).toEqual({ decision: "decline" });
    });

    it("refuses protocolVersion 2 loudly at construction", () => {
        expect(
            () =>
                new CodexCopilotAdapterServer({
                    protocolVersion: 2,
                })
        ).toThrow(/protocolVersion 2 is not supported on SDK v1\.0\.7/);
    });
});

describe("Codex adapter unmapped-event observability", () => {
    type UnmappedSummary = Record<
        string,
        { count: number; firstSeenAt: string; paramsKeys: string[] }
    >;

    async function startObservedAdapter() {
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
        });
        return { fakeCodex, adapter, client, session };
    }

    function transcripts(adapter: CodexCopilotAdapterServer) {
        return (
            adapter.summary() as {
                transcripts: Array<{ direction: string; message: unknown }>;
            }
        ).transcripts;
    }

    it("counts and logs dropped notifications per method and item type", async () => {
        const { fakeCodex, adapter, client } = await startObservedAdapter();

        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: { type: "webSearch", id: "search-1", query: "adapter docs" },
        });
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: { type: "webSearch", id: "search-2", query: "more adapter docs" },
        });
        fakeCodex.emitNotification("item/started", {
            threadId: "fake-thread-1",
            item: { type: "todoList", id: "todo-1" },
        });

        const summary = adapter.unmappedEventsSummary();
        expect(summary["item/completed:webSearch"]).toEqual(
            expect.objectContaining({
                count: 2,
                paramsKeys: ["threadId", "item"],
            })
        );
        expect(summary["item/started:todoList"]).toEqual(
            expect.objectContaining({ count: 1 })
        );

        const unmappedLogs = transcripts(adapter).filter(
            (entry) => entry.direction === "adapter.unmapped"
        );
        const webSearchLogs = unmappedLogs.filter(
            (entry) =>
                isRecord(entry.message) && entry.message.itemType === "webSearch"
        );
        expect(webSearchLogs).toHaveLength(2);
        // First sighting carries payload top-level keys; repeats stay terse.
        expect(webSearchLogs[0].message).toEqual(
            expect.objectContaining({
                kind: "notification",
                method: "item/completed",
                itemType: "webSearch",
                threadId: "fake-thread-1",
                reason: "unmapped-item-type",
                paramsKeys: ["threadId", "item"],
            })
        );
        expect(webSearchLogs[1].message).not.toHaveProperty("paramsKeys");

        // Mapped paths stay unaffected: agentMessage still emits and is not counted.
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: { type: "agentMessage", id: "assistant-1", text: "hello" },
        });
        expect(adapter.unmappedEventsSummary()["item/completed:agentMessage"]).toBeUndefined();

        // Queryable through the real v1.0.7 client: additive status.get field.
        const status = (await client.getStatus()) as unknown as {
            unmappedEvents: UnmappedSummary;
        };
        expect(status.unmappedEvents["item/completed:webSearch"].count).toBe(2);
    });

    it("emits an unmapped summary on session destroy and counts unserved codex requests", async () => {
        const { fakeCodex, adapter, session } = await startObservedAdapter();

        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: { type: "todoList", id: "todo-1" },
        });
        fakeCodex.emitRequest({
            id: "unknown-req-1",
            method: "thread/compact/confirm",
            params: { threadId: "fake-thread-1" },
        });

        await session.disconnect();

        const summaries = transcripts(adapter).filter(
            (entry) => entry.direction === "adapter.unmapped.summary"
        );
        expect(summaries).toHaveLength(1);
        expect(summaries[0].message).toEqual(
            expect.objectContaining({
                scope: "session.destroy",
                sessionId: session.sessionId,
            })
        );
        const summaryCounts = (
            summaries[0].message as { unmappedEvents: UnmappedSummary }
        ).unmappedEvents;
        expect(summaryCounts["item/completed:todoList"].count).toBe(1);
        expect(summaryCounts["thread/compact/confirm"]).toEqual(
            expect.objectContaining({ count: 1 })
        );

        const requestLog = transcripts(adapter).find(
            (entry) =>
                isRecord(entry.message) &&
                entry.message.reason === "unmapped-request-method"
        );
        expect(requestLog?.message).toEqual(
            expect.objectContaining({
                kind: "request",
                method: "thread/compact/confirm",
                threadId: "fake-thread-1",
            })
        );
    });
});

describe("Codex adapter v1.0.7 event mapping expansion", () => {
    type CollectedEvent = { type: string; data: Record<string, unknown> };

    async function startMappedAdapter() {
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

        const events: CollectedEvent[] = [];
        const session = await client.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        session.on((event) => {
            events.push({ type: event.type, data: event.data as Record<string, unknown> });
        });
        return { fakeCodex, adapter, client, session, events };
    }

    async function waitForEvent(
        events: CollectedEvent[],
        type: string,
        count = 1,
        timeoutMs = 2_000
    ) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const matching = events.filter((event) => event.type === type);
            if (matching.length >= count) {
                return matching;
            }
            await delay(10);
        }
        throw new Error(`Timed out waiting for ${count}x ${type}`);
    }

    it("streams agentMessage deltas as assistant.message_start/delta/message", async () => {
        const { fakeCodex, events } = await startMappedAdapter();

        fakeCodex.emitNotification("item/started", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "msg-1", text: "", phase: "commentary" },
        });
        fakeCodex.emitNotification("item/agentMessage/delta", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            itemId: "msg-1",
            delta: "Hel",
        });
        fakeCodex.emitNotification("item/agentMessage/delta", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            itemId: "msg-1",
            delta: "lo",
        });
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "msg-1", text: "Hello", phase: "commentary" },
        });

        const [start] = await waitForEvent(events, "assistant.message_start");
        expect(start.data).toEqual({ messageId: "msg-1", phase: "commentary" });

        const deltas = await waitForEvent(events, "assistant.message_delta", 2);
        expect(deltas.map((event) => event.data.deltaContent)).toEqual(["Hel", "lo"]);
        expect(new Set(deltas.map((event) => event.data.messageId))).toEqual(new Set(["msg-1"]));

        const [message] = await waitForEvent(events, "assistant.message");
        expect(message.data).toEqual(
            expect.objectContaining({ content: "Hello", messageId: "msg-1" })
        );
    });

    it("maps completed reasoning items to assistant.reasoning", async () => {
        const { fakeCodex, events, session } = await startMappedAdapter();

        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: {
                type: "reasoning",
                id: "rs-1",
                summary: [{ type: "text", text: "planning the change" }],
                content: [],
            },
        });

        const [reasoning] = await waitForEvent(events, "assistant.reasoning");
        expect(reasoning.data).toEqual({
            content: "planning the change",
            reasoningId: "rs-1",
        });

        // Non-ephemeral: replayable through getEvents.
        const stored = await session.getEvents();
        expect(stored.some((event) => event.type === "assistant.reasoning")).toBe(true);
    });

    it("maps turn/started to assistant.turn_start with the session model", async () => {
        const { fakeCodex, events } = await startMappedAdapter();

        fakeCodex.emitNotification("turn/started", {
            threadId: "fake-thread-1",
            turn: { id: "turn-42", status: "inProgress" },
        });

        const [turnStart] = await waitForEvent(events, "assistant.turn_start");
        expect(turnStart.data).toEqual({ turnId: "turn-42", model: "gpt-test" });
    });

    it("maps commandExecution items to tool.execution_start/complete", async () => {
        const { fakeCodex, events } = await startMappedAdapter();

        fakeCodex.emitNotification("item/started", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: {
                type: "commandExecution",
                id: "call-cmd-1",
                command: "/bin/zsh -lc 'echo hi > out.txt'",
                cwd: "/tmp/workspace",
                status: "inProgress",
            },
        });
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: {
                type: "commandExecution",
                id: "call-cmd-1",
                command: "/bin/zsh -lc 'echo hi > out.txt'",
                cwd: "/tmp/workspace",
                status: "completed",
                aggregatedOutput: "hi",
                exitCode: 0,
            },
        });

        const [start] = await waitForEvent(events, "tool.execution_start");
        expect(start.data).toEqual(
            expect.objectContaining({
                toolCallId: "call-cmd-1",
                toolName: "shell",
                arguments: expect.objectContaining({
                    command: "/bin/zsh -lc 'echo hi > out.txt'",
                    cwd: "/tmp/workspace",
                }),
                shellToolInfo: { hasWriteFileRedirection: true, possiblePaths: [] },
                turnId: "turn-1",
            })
        );

        const [complete] = await waitForEvent(events, "tool.execution_complete");
        expect(complete.data).toEqual(
            expect.objectContaining({
                toolCallId: "call-cmd-1",
                success: true,
                result: { content: "hi" },
            })
        );
    });

    it("maps fileChange items to tool.execution events plus workspace_file_changed", async () => {
        const { fakeCodex, events } = await startMappedAdapter();

        const changes = [
            {
                path: "/tmp/workspace/new-file.txt",
                kind: { type: "add" },
                diff: "new content\n",
            },
            {
                path: "/tmp/workspace/existing.txt",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-a\n+b\n",
            },
        ];
        fakeCodex.emitNotification("item/started", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: { type: "fileChange", id: "call-fc-1", changes, status: "inProgress" },
        });
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            item: { type: "fileChange", id: "call-fc-1", changes, status: "completed" },
        });

        const [start] = await waitForEvent(events, "tool.execution_start");
        expect(start.data).toEqual(
            expect.objectContaining({
                toolCallId: "call-fc-1",
                toolName: "apply_patch",
                arguments: {
                    paths: ["/tmp/workspace/new-file.txt", "/tmp/workspace/existing.txt"],
                },
            })
        );

        const [complete] = await waitForEvent(events, "tool.execution_complete");
        expect(complete.data).toEqual(
            expect.objectContaining({
                toolCallId: "call-fc-1",
                success: true,
            })
        );

        const fileChanges = await waitForEvent(events, "session.workspace_file_changed", 2);
        expect(fileChanges.map((event) => event.data)).toEqual([
            { operation: "create", path: "/tmp/workspace/new-file.txt" },
            { operation: "update", path: "/tmp/workspace/existing.txt" },
        ]);
    });

    it("maps thread/tokenUsage/updated to assistant.usage", async () => {
        const { fakeCodex, events } = await startMappedAdapter();

        fakeCodex.emitNotification("thread/tokenUsage/updated", {
            threadId: "fake-thread-1",
            turnId: "turn-1",
            tokenUsage: {
                total: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
                last: {
                    totalTokens: 100,
                    inputTokens: 80,
                    cachedInputTokens: 30,
                    outputTokens: 20,
                    reasoningOutputTokens: 5,
                },
                modelContextWindow: 380000,
            },
        });

        const [usage] = await waitForEvent(events, "assistant.usage");
        expect(usage.data).toEqual({
            model: "gpt-test",
            inputTokens: 80,
            outputTokens: 20,
            cacheReadTokens: 30,
            reasoningTokens: 5,
        });
    });

    it("counts deliberately unmapped events separately without emitting", async () => {
        const { fakeCodex, adapter, events, client } = await startMappedAdapter();
        const baselineEventCount = events.length;

        fakeCodex.emitNotification("thread/status/changed", {
            threadId: "fake-thread-1",
            status: { type: "active", activeFlags: [] },
        });
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: { type: "userMessage", id: "um-1", content: [{ type: "text", text: "hi" }] },
        });
        fakeCodex.emitNotification("account/rateLimits/updated", {
            rateLimits: {},
        });

        await delay(50);
        expect(events.length).toBe(baselineEventCount);

        const deliberate = adapter.deliberatelyUnmappedSummary();
        expect(deliberate["thread/status/changed"]).toEqual(
            expect.objectContaining({ count: 1 })
        );
        expect(deliberate["item/completed:userMessage"].reason).toMatch(/mapped-ack/);
        expect(deliberate["account/rateLimits/updated"]).toEqual(
            expect.objectContaining({ count: 1 })
        );
        expect(adapter.unmappedEventsSummary()["thread/status/changed"]).toBeUndefined();
        expect(adapter.unmappedEventsSummary()["account/rateLimits/updated"]).toBeUndefined();

        const status = (await client.getStatus()) as unknown as {
            deliberatelyUnmapped: Record<string, { count: number; reason: string }>;
        };
        expect(status.deliberatelyUnmapped["thread/status/changed"].count).toBe(1);
    });

    it("responds method-not-found to unserved codex requests instead of hanging", async () => {
        const { fakeCodex } = await startMappedAdapter();

        fakeCodex.emitRequest({
            id: "unserved-1",
            method: "thread/compact/confirm",
            params: { threadId: "fake-thread-1" },
        });

        const deadline = Date.now() + 2_000;
        let response: { id: number | string; result?: unknown; error?: unknown } | undefined;
        while (Date.now() < deadline && !response) {
            response = fakeCodex.responses.find((entry) => entry.id === "unserved-1");
            if (!response) {
                await delay(10);
            }
        }
        expect(response?.result).toBeUndefined();
        expect(response?.error).toEqual(
            expect.objectContaining({
                code: -32601,
                message: expect.stringContaining("thread/compact/confirm"),
            })
        );
    });
});

describe("Codex adapter v1.0.7 new carriers", () => {
    it("counts reasoning extraction misses loudly instead of shipping empty content", async () => {
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
        const events: Array<{ type: string; data: Record<string, unknown> }> = [];
        const session = await client.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        session.on((event) => {
            events.push({ type: event.type, data: event.data as Record<string, unknown> });
        });

        // Known shape: {text} entries extract fine and do not count as a miss.
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: {
                type: "reasoning",
                id: "rs-ok",
                summary: [{ type: "text", text: "readable" }],
                content: [],
            },
        });
        // Unknown shape: non-empty arrays but nothing extractable.
        fakeCodex.emitNotification("item/completed", {
            threadId: "fake-thread-1",
            item: {
                type: "reasoning",
                id: "rs-miss",
                summary: [{ encrypted_blob: "abc123" }],
                content: [],
            },
        });

        const deadline = Date.now() + 2_000;
        while (
            Date.now() < deadline &&
            events.filter((event) => event.type === "assistant.reasoning").length < 2
        ) {
            await delay(10);
        }

        const summary = adapter.unmappedEventsSummary();
        expect(summary["item/completed:reasoning"]).toEqual(
            expect.objectContaining({
                count: 1,
                // First sighting logs the item's top-level shape for diagnosis.
                paramsKeys: ["type", "id", "summary", "content"],
            })
        );
        const missLog = (
            adapter.summary() as {
                transcripts: Array<{ direction: string; message: unknown }>;
            }
        ).transcripts.find(
            (entry) =>
                entry.direction === "adapter.unmapped" &&
                isRecord(entry.message) &&
                entry.message.reason === "extraction-miss"
        );
        expect(missLog?.message).toEqual(
            expect.objectContaining({ itemType: "reasoning", reason: "extraction-miss" })
        );

        // Both events still delivered; the ok one carries its text.
        const reasoningEvents = events.filter((event) => event.type === "assistant.reasoning");
        expect(reasoningEvents.map((event) => event.data)).toEqual([
            { content: "readable", reasoningId: "rs-ok" },
            { content: "", reasoningId: "rs-miss" },
        ]);
    });

    it("round-trips tool metadata bags through the session store across adapter restart", async () => {
        const storePath = join(
            mkdtempSync(join(tmpdir(), "codex-adapter-metadata-store-")),
            "sessions.json"
        );
        const metadataBag = { "tekric:topic": "codex-adapter-v107", "tekric:window": "w1" };
        const toolsWithMetadata = [
            defineTool("lookup", {
                description: "Lookup source data",
                handler: ({ query }: { query: string }) => `lookup:${query}`,
                metadata: metadataBag,
            }),
        ];

        const firstCodex = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstCodex;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();

        const session = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: toolsWithMetadata,
        });
        const sessionId = session.sessionId;

        // Live outlet: summary() exposes the bag untouched.
        const liveSummary = firstAdapter.summary() as {
            sessions: Array<{ sessionId: string; tools: Array<Record<string, unknown>> }>;
        };
        expect(liveSummary.sessions).toContainEqual(
            expect.objectContaining({
                sessionId,
                tools: [{ name: "lookup", metadata: metadataBag }],
            })
        );

        await session.disconnect();
        await firstClient.stop();
        await firstAdapter.stop();

        // Persistence: the store file carries the bag under toolMetadata.
        const storeRaw = JSON.parse(readFileSync(storePath, "utf8")) as {
            records: Array<Record<string, unknown>>;
        };
        expect(storeRaw.records).toContainEqual(
            expect.objectContaining({
                sdkSessionId: sessionId,
                toolMetadata: { lookup: metadataBag },
            })
        );

        // Restart-resume: metadata still present and unchanged (and excluded
        // from the tool fingerprint, so the resume is accepted).
        const secondCodex = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondCodex;
        await secondAdapter.start();
        onTestFinished(() => secondAdapter.stop());
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        onTestFinished(async () => {
            await secondClient.stop();
        });

        await secondClient.resumeSession(sessionId, {
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: toolsWithMetadata,
        });

        const resumedSummary = secondAdapter.summary() as {
            sessions: Array<{ sessionId: string; tools: Array<Record<string, unknown>> }>;
        };
        expect(resumedSummary.sessions).toContainEqual(
            expect.objectContaining({
                sessionId,
                tools: [{ name: "lookup", metadata: metadataBag }],
            })
        );
    });
});

describe("Codex adapter session.abort", () => {
    it("invalidates the session, restarts the gateway, and emits session.aborted", async () => {
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

        const lifecycleTypes: string[] = [];
        client.onLifecycle((event) => {
            lifecycleTypes.push(event.type);
        });

        const session = await client.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        const sessionId = session.sessionId;
        await session.abort();

        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && !lifecycleTypes.includes("session.aborted")) {
            await delay(10);
        }
        expect(lifecycleTypes).toContain("session.aborted");

        const restartMarkers = (
            adapter.summary() as {
                transcripts: Array<{ direction: string; message: unknown }>;
            }
        ).transcripts.filter(
            (entry) => entry.direction === "adapter.session.abort.gateway_restart"
        );
        expect(restartMarkers).toHaveLength(1);
        expect(restartMarkers[0].message).toEqual(
            expect.objectContaining({ sessionId, threadId: "fake-thread-1" })
        );

        // The session is gone: a follow-up abort reports the unknown session.
        const secondAbort = (await (
            adapter as unknown as {
                handleSessionAbort: (params: unknown) => Promise<Record<string, unknown>>;
            }
        ).handleSessionAbort({ sessionId })) as { success: boolean; error?: string };
        expect(secondAbort.success).toBe(false);
        expect(secondAbort.error).toContain("Unknown session");
    });
});
