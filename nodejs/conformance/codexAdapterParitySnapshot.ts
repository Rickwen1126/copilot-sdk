import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { approveAll, CopilotClient, defineTool } from "../src/index.js";
import {
    CODEX_ADAPTER_CAPABILITIES,
    CodexCopilotAdapterServer,
} from "../src/experimental/codexAdapter.js";

type FakeCodexRequest = {
    method: string;
    params?: unknown;
};

type FakeCodexResponse = {
    id: number | string;
    result?: unknown;
    error?: unknown;
};

const THREAD_ID = "fake-thread-1";

class FakeCodexGateway {
    readonly requests: FakeCodexRequest[] = [];
    readonly responses: FakeCodexResponse[] = [];
    private notificationHandlers = new Set<(notification: FakeCodexRequest) => void>();
    private requestHandlers = new Set<
        (request: FakeCodexRequest & { id: number | string }) => void | Promise<void>
    >();
    private pending = new Map<
        number | string,
        { resolve: (value: FakeCodexResponse) => void; reject: (error: Error) => void }
    >();

    async start(): Promise<void> {}

    async stop(): Promise<void> {}

    async request(method: string, params?: unknown): Promise<FakeCodexResponse> {
        this.requests.push({ method, params });

        if (method === "thread/start") {
            return {
                id: this.requests.length,
                result: { thread: { id: THREAD_ID } },
            };
        }

        if (method === "thread/resume") {
            return {
                id: this.requests.length,
                result: { thread: { id: THREAD_ID } },
            };
        }

        if (method === "turn/start") {
            setTimeout(() => {
                this.emitNotification("item/completed", {
                    threadId: THREAD_ID,
                    item: {
                        id: "assistant-message-1",
                        type: "agentMessage",
                        text: "adapter characterization reply",
                    },
                });
                this.emitNotification("turn/completed", {
                    threadId: THREAD_ID,
                    turn: { status: "completed" },
                });
            }, 0);
            return {
                id: this.requests.length,
                result: { turn: { id: "turn-1" } },
            };
        }

        if (method === "model/list") {
            return {
                id: this.requests.length,
                result: {
                    data: [{ id: "gpt-5.4", displayName: "GPT 5.4" }],
                },
            };
        }

        if (method === "account/read") {
            return {
                id: this.requests.length,
                result: { account: { type: "apiKey", planType: "test" } },
            };
        }

        if (
            method === "thread/unsubscribe" ||
            method === "thread/archive" ||
            method === "initialized"
        ) {
            return {
                id: this.requests.length,
                result: {},
            };
        }

        return {
            id: this.requests.length,
            result: {},
        };
    }

    notify(method: string, params?: unknown): void {
        this.requests.push({ method, params });
    }

    respond(id: number | string, result?: unknown, error?: unknown): void {
        const response = { id, result, error };
        this.responses.push(response);
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        this.pending.delete(id);
        pending.resolve(response);
    }

    onNotification(handler: (notification: FakeCodexRequest) => void): () => void {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }

    onRequest(
        handler: (request: FakeCodexRequest & { id: number | string }) => void | Promise<void>
    ): () => void {
        this.requestHandlers.add(handler);
        return () => this.requestHandlers.delete(handler);
    }

    async emitRequest(method: string, params?: unknown): Promise<FakeCodexResponse> {
        const id = `codex-${this.pending.size + 1}`;
        const result = new Promise<FakeCodexResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        const request = { id, method, params };
        for (const handler of this.requestHandlers) {
            await handler(request);
        }
        return result;
    }

    emitNotification(method: string, params?: unknown): void {
        const notification = { method, params };
        for (const handler of this.notificationHandlers) {
            handler(notification);
        }
    }

    summary() {
        return {
            codexHome: "fake-codex-home",
            transcripts: this.requests,
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function summarizeCapabilities() {
    return {
        supported: CODEX_ADAPTER_CAPABILITIES.flags
            .filter((flag) => flag.status === "supported")
            .map((flag) => flag.id)
            .sort(),
        deferred: CODEX_ADAPTER_CAPABILITIES.flags
            .filter((flag) => flag.status === "deferred")
            .map((flag) => flag.id)
            .sort(),
    };
}

function transcriptMethods(
    transcript: unknown,
    direction: string,
    method: string
): string[] {
    if (!Array.isArray(transcript)) {
        return [];
    }
    return transcript
        .filter((entry) => isRecord(entry) && entry.direction === direction)
        .map((entry) => (isRecord(entry.message) ? entry.message.method : undefined))
        .filter((value): value is string => value === method);
}

function timeoutTranscriptEntries(transcript: unknown): string[] {
    if (!Array.isArray(transcript)) {
        return [];
    }
    return transcript
        .filter((entry) => isRecord(entry) && entry.direction === "adapter.tool.timeout")
        .map((entry) =>
            isRecord(entry.message) && typeof entry.message.toolName === "string"
                ? entry.message.toolName
                : ""
        )
        .filter(Boolean);
}

async function buildSnapshot() {
    const snapshot: Record<string, unknown> = {
        capabilities: summarizeCapabilities(),
    };

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            const session = await client.createSession({
                model: "gpt-test",
                onPermissionRequest: approveAll,
                systemMessage: {
                    mode: "replace",
                    content: "You are the adapter characterization test assistant.",
                },
            });
            const assistant = await session.sendAndWait(
                { prompt: "Reply through the fake Codex gateway." },
                1_000
            );
            const events = await session.getEvents();
            const threadStart = fake.requests.find((entry) => entry.method === "thread/start");
            const turnStart = fake.requests.find((entry) => entry.method === "turn/start");

            await session.disconnect();
            await session.disconnect();
            const resumed = await client.resumeSession(session.sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
            });
            await client.deleteSession(session.sessionId);
            let deleteResumeError = "";
            try {
                await client.resumeSession(resumed.sessionId, {
                    model: "gpt-test",
                    onPermissionRequest: approveAll,
                });
            } catch (error) {
                deleteResumeError = error instanceof Error ? error.message : String(error);
            }

            snapshot.createSendLifecycle = {
                threadStart: {
                    model: isRecord(threadStart?.params) ? threadStart.params.model : undefined,
                    baseInstructions: isRecord(threadStart?.params)
                        ? threadStart.params.baseInstructions
                        : undefined,
                    ephemeral: isRecord(threadStart?.params) ? threadStart.params.ephemeral : undefined,
                },
                turnStart: {
                    model: isRecord(turnStart?.params) ? turnStart.params.model : undefined,
                    threadIdMatches: isRecord(turnStart?.params)
                        ? turnStart.params.threadId === THREAD_ID
                        : false,
                },
                assistantMessage: assistant?.data.content,
                eventTypes: events.map((event) => event.type).sort(),
                unsubscribeCount: fake.requests.filter((entry) => entry.method === "thread/unsubscribe")
                    .length,
                resumeCount: fake.requests.filter((entry) => entry.method === "thread/resume").length,
                archiveCount: fake.requests.filter((entry) => entry.method === "thread/archive").length,
                deleteResumeError,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const storePath = join(mkdtempSync(join(tmpdir(), "codex-adapter-node-restart-")), "store.json");
        const firstFake = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstFake;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();
        const firstSession = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
        });
        const sessionId = firstSession.sessionId;
        await firstSession.disconnect();
        await firstClient.forceStop();
        await firstAdapter.stop();

        const secondFake = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondFake;
        await secondAdapter.start();
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        try {
            const resumed = await secondClient.resumeSession(sessionId, {
                model: "gpt-test",
                onPermissionRequest: approveAll,
            });
            const assistant = await resumed.sendAndWait(
                { prompt: "Continue after adapter restart." },
                1_000
            );
            snapshot.restartResume = {
                threadStartCount: secondFake.requests.filter((entry) => entry.method === "thread/start")
                    .length,
                threadResumeCount: secondFake.requests.filter(
                    (entry) => entry.method === "thread/resume"
                ).length,
                assistantMessage: assistant?.data.content,
            };
        } finally {
            await secondClient.forceStop();
            await secondAdapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
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

            let errorMessage = "";
            try {
                await client.resumeSession(session.sessionId, {
                    model: "gpt-test",
                    onPermissionRequest: approveAll,
                    tools: [
                        defineTool("changed_tool", {
                            description: "Changed tool shape",
                            handler: () => "changed",
                        }),
                    ],
                });
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            }

            snapshot.activeToolMismatch = {
                error: errorMessage,
                threadResumeCount: fake.requests.filter((entry) => entry.method === "thread/resume")
                    .length,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const storePath = join(
            mkdtempSync(join(tmpdir(), "codex-adapter-node-missing-tools-")),
            "store.json"
        );
        const firstFake = new FakeCodexGateway();
        const firstAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (firstAdapter as unknown as { codex: FakeCodexGateway }).codex = firstFake;
        await firstAdapter.start();
        const firstClient = new CopilotClient(firstAdapter.clientOptions());
        await firstClient.start();
        const firstSession = await firstClient.createSession({
            model: "gpt-test",
            onPermissionRequest: approveAll,
            tools: [
                defineTool("restart_tool", {
                    description: "Tool that must be reattached after restart",
                    handler: () => "restart",
                }),
            ],
        });
        const sessionId = firstSession.sessionId;
        await firstSession.disconnect();
        await firstClient.forceStop();
        await firstAdapter.stop();

        const secondFake = new FakeCodexGateway();
        const secondAdapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            runtimeSessionStorePath: storePath,
        });
        (secondAdapter as unknown as { codex: FakeCodexGateway }).codex = secondFake;
        await secondAdapter.start();
        const secondClient = new CopilotClient(secondAdapter.clientOptions());
        await secondClient.start();
        try {
            let missingToolsError = "";
            try {
                await secondClient.resumeSession(sessionId, {
                    model: "gpt-test",
                    onPermissionRequest: approveAll,
                });
            } catch (error) {
                missingToolsError = error instanceof Error ? error.message : String(error);
            }

            let incompatibleToolsError = "";
            try {
                await secondClient.resumeSession(sessionId, {
                    model: "gpt-test",
                    onPermissionRequest: approveAll,
                    tools: [
                        defineTool("changed_restart_tool", {
                            description: "Changed persisted tool",
                            handler: () => "changed",
                        }),
                    ],
                });
            } catch (error) {
                incompatibleToolsError = error instanceof Error ? error.message : String(error);
            }

            snapshot.restartToolChecks = {
                missingToolsError,
                incompatibleToolsError,
                threadResumeCount: secondFake.requests.filter(
                    (entry) => entry.method === "thread/resume"
                ).length,
            };
        } finally {
            await secondClient.forceStop();
            await secondAdapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const seenRequests: unknown[] = [];
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: (request) => {
                    seenRequests.push(request);
                    return { kind: "approved" as const };
                },
            });
            const approved = await fake.emitRequest("item/commandExecution/requestApproval", {
                threadId: THREAD_ID,
                itemId: "command-1",
                reason: "Need to write the approval probe.",
                command: "zsh -lc 'echo hello > /tmp/probe'",
                commandActions: [{ command: "zsh -lc 'echo hello > /tmp/probe'" }],
                availableDecisions: ["accept", "acceptForSession"],
            });

            snapshot.commandApproval = {
                approvedDecision: approved.result,
                request: seenRequests[0],
                transcriptMethods: {
                    request: transcriptMethods(adapter.summary().transcripts, "adapter->sdk.request", "permission.request"),
                    response: transcriptMethods(adapter.summary().transcripts, "sdk->adapter.response", "permission.request"),
                },
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: () => ({
                    kind: "denied-by-rules" as const,
                }),
            });
            const denied = await fake.emitRequest("item/commandExecution/requestApproval", {
                threadId: THREAD_ID,
                itemId: "command-2",
                command: "zsh -lc 'echo denied'",
                availableDecisions: ["accept", "acceptForSession"],
            });

            snapshot.commandApproval = {
                ...((snapshot.commandApproval as Record<string, unknown>) ?? {}),
                deniedDecision: denied.result,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const seenRequests: unknown[] = [];
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: (request) => {
                    seenRequests.push(request);
                    return { kind: "approved" as const };
                },
            });
            fake.emitNotification("item/updated", {
                threadId: THREAD_ID,
                itemId: "file-1",
                changes: [{ path: "/tmp/allowed.txt" }, { kind: "metadata-without-path" }],
            });
            const approved = await fake.emitRequest("item/fileChange/requestApproval", {
                threadId: THREAD_ID,
                itemId: "file-1",
            });

            snapshot.fileApproval = {
                approvedDecision: approved.result,
                request: seenRequests[0],
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: () => ({
                    kind: "denied-interactively-by-user" as const,
                }),
            });
            fake.emitNotification("item/updated", {
                threadId: THREAD_ID,
                itemId: "file-2",
                changes: [{ path: "/tmp/denied.txt" }],
            });
            const denied = await fake.emitRequest("item/fileChange/requestApproval", {
                threadId: THREAD_ID,
                itemId: "file-2",
            });

            snapshot.fileApproval = {
                ...((snapshot.fileApproval as Record<string, unknown>) ?? {}),
                deniedDecision: denied.result,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        // protocolVersion 2 is refused loudly on SDK v1.0.7 (legacy direct
        // tool.call flow was removed from the SDK client). Record the refusal
        // instead of exercising the removed path.
        let refusal: string | undefined;
        try {
            new CodexCopilotAdapterServer({
                model: "gpt-test",
                protocolVersion: 2,
            });
        } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
        }
        snapshot.toolV2 = {
            refused: refusal !== undefined,
            refusal,
        };
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: approveAll,
                tools: [
                    defineTool("lookup", {
                        description: "Lookup source data",
                        handler: ({ query }: { query: string }) => `lookup:${query}`,
                    }),
                    defineTool("deny_tool", {
                        description: "Deliberately deny a tool call",
                        handler: () => ({
                            textResultForLlm: "tool denied",
                            resultType: "denied" as const,
                        }),
                    }),
                    defineTool("fail_tool", {
                        description: "Raise a deterministic error",
                        handler: () => {
                            throw new Error("tool failed hard");
                        },
                    }),
                ],
            });
            const success = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "lookup",
                callId: "call-v3",
                arguments: { query: "v3" },
            });
            const denied = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "deny_tool",
                callId: "deny-v3",
                arguments: {},
            });
            const failed = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "fail_tool",
                callId: "fail-v3",
                arguments: {},
            });

            snapshot.toolV3 = {
                success: success.result,
                denied: denied.result,
                failed: failed.result,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
            requestTimeoutMs: 10,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
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
            fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "slow_tool",
                callId: "slow-call-1",
                arguments: {},
            });
            await delay(30);

            snapshot.toolTimeout = {
                response: fake.responses.at(-1)?.result,
                transcriptToolNames: timeoutTranscriptEntries(adapter.summary().transcripts),
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    {
        const fake = new FakeCodexGateway();
        const adapter = new CodexCopilotAdapterServer({
            model: "gpt-test",
            protocolVersion: 3,
        });
        (adapter as unknown as { codex: FakeCodexGateway }).codex = fake;
        await adapter.start();
        const client = new CopilotClient(adapter.clientOptions());
        await client.start();
        try {
            await client.createSession({
                model: "gpt-test",
                onPermissionRequest: approveAll,
                tools: [
                    defineTool("lookup", {
                        description: "Lookup source data",
                        handler: () => "lookup",
                    }),
                ],
            });
            const missingThread = await fake.emitRequest("item/tool/call", {
                tool: "lookup",
                callId: "missing-thread",
                arguments: {},
            });
            const missingName = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                callId: "missing-name",
                arguments: {},
            });
            const unknownTool = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "not_registered",
                callId: "unknown-tool",
                arguments: {},
            });
            (
                adapter as unknown as {
                    connections: Map<string, unknown>;
                }
            ).connections.clear();
            const noConnection = await fake.emitRequest("item/tool/call", {
                threadId: THREAD_ID,
                tool: "lookup",
                callId: "no-connection",
                arguments: {},
            });

            snapshot.dynamicToolErrors = {
                missingThread:
                    isRecord(missingThread.result) && Array.isArray(missingThread.result.contentItems)
                        ? isRecord(missingThread.result.contentItems[0])
                            ? missingThread.result.contentItems[0].text
                            : undefined
                        : undefined,
                missingName:
                    isRecord(missingName.result) && Array.isArray(missingName.result.contentItems)
                        ? isRecord(missingName.result.contentItems[0])
                            ? missingName.result.contentItems[0].text
                            : undefined
                        : undefined,
                unknownTool:
                    isRecord(unknownTool.result) && Array.isArray(unknownTool.result.contentItems)
                        ? isRecord(unknownTool.result.contentItems[0])
                            ? unknownTool.result.contentItems[0].text
                            : undefined
                        : undefined,
                noConnection:
                    isRecord(noConnection.result) && Array.isArray(noConnection.result.contentItems)
                        ? isRecord(noConnection.result.contentItems[0])
                            ? noConnection.result.contentItems[0].text
                            : undefined
                        : undefined,
            };
        } finally {
            await client.forceStop();
            await adapter.stop();
        }
    }

    return snapshot;
}

buildSnapshot()
    .then((snapshot) => {
        process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    })
    .catch((error) => {
        process.stderr.write(
            `${JSON.stringify({
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            })}\n`
        );
        process.exitCode = 1;
    });
