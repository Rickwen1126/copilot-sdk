import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type JsonRpcId = number | string;

type JsonRpcResponse = {
    id: JsonRpcId;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
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

type CapabilityVerdict = {
    status: "supported" | "unsupported" | "partial" | "unknown-blocked";
    evidence: string[];
    implication: string;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_CAPABILITY_SPIKE_TIMEOUT_MS ?? 45_000);
const LIVE_TURN_TIMEOUT_MS = Number(process.env.CODEX_CAPABILITY_SPIKE_LIVE_TURN_TIMEOUT_MS ?? 180_000);
const RUN_LIVE_TURN = process.env.CODEX_CAPABILITY_SPIKE_RUN_LIVE_TURN === "1";
const LIVE_TURN_PROMPT =
    process.env.CODEX_CAPABILITY_SPIKE_LIVE_TURN_PROMPT ??
    "Reply with exactly CODEX_CAPABILITY_SPIKE_OK. Do not run tools.";
const LIVE_TURN_MODEL = process.env.CODEX_CAPABILITY_SPIKE_MODEL;
const OUTPUT_PATH =
    process.env.CODEX_CAPABILITY_SPIKE_OUT ??
    join(tmpdir(), `codex-app-server-capability-spike-${Date.now()}.json`);
const SOURCE_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const WORKDIR = process.env.CODEX_CAPABILITY_SPIKE_WORKDIR ?? mkdtempSync(join(tmpdir(), "codex-capability-work-"));
const CODEX_BIN = process.env.CODEX_BIN ?? resolveBinary("codex");

function nowIso(): string {
    return new Date().toISOString();
}

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

function codexVersion(): string {
    try {
        return execFileSync(CODEX_BIN, ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch (error) {
        return `unavailable: ${String(error)}`;
    }
}

function prepareCodexHome(): string {
    const home = mkdtempSync(join(tmpdir(), "codex-capability-home-"));
    mkdirSync(join(home, "sessions"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    mkdirSync(join(home, "tmp"), { recursive: true });

    for (const fileName of ["auth.json", "config.toml", "installation_id", "models_cache.json"]) {
        const source = join(SOURCE_CODEX_HOME, fileName);
        if (existsSync(source)) {
            cpSync(source, join(home, fileName));
        }
    }

    return home;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function sanitize(value: unknown, keyHint = ""): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === "string") {
        if (/token|secret|authorization|credential|auth|email|login/i.test(keyHint)) {
            return "<redacted>";
        }
        if (/^eyJ[A-Za-z0-9_-]+\./.test(value) || value.length > 220) {
            return "<redacted-long-string>";
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item, keyHint));
    }
    if (isRecord(value)) {
        const output: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) {
            output[key] = sanitize(nested, key);
        }
        return output;
    }
    return value;
}

function extractThreadId(response: JsonRpcResponse | undefined): string | null {
    const result = response?.result;
    if (!isRecord(result) || !isRecord(result.thread)) {
        return null;
    }
    return typeof result.thread.id === "string" ? result.thread.id : null;
}

function extractThreadPath(response: JsonRpcResponse | undefined): string | null {
    const result = response?.result;
    if (!isRecord(result) || !isRecord(result.thread)) {
        return null;
    }
    return typeof result.thread.path === "string" ? result.thread.path : null;
}

function responseOk(response: JsonRpcResponse | undefined): boolean {
    return Boolean(response && !response.error);
}

function asPhaseRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function asJsonRpcResponse(value: unknown): JsonRpcResponse | undefined {
    return isRecord(value) && "id" in value ? (value as JsonRpcResponse) : undefined;
}

function asJsonRpcResponseMap(value: unknown): Record<string, JsonRpcResponse | undefined> {
    if (!isRecord(value)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, asJsonRpcResponse(nested)])
    );
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return true;
        }
        await delay(100);
    }
    return existsSync(path);
}

class RawAppServerClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<JsonRpcId, (response: JsonRpcResponse) => void>();
    private transcript: TranscriptEntry[] = [];
    private notifications: JsonRpcNotification[] = [];

    constructor(private readonly codexHome: string) {}

    async start() {
        const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.codexHome };
        delete env.OPENAI_API_KEY;

        this.child = spawn(CODEX_BIN, ["app-server"], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const stdout = readline.createInterface({ input: this.child.stdout });
        stdout.on("line", (line) => this.handleLine("codex->client", line));

        const stderr = readline.createInterface({ input: this.child.stderr });
        stderr.on("line", (line) => {
            this.transcript.push({
                at: nowIso(),
                direction: "codex-stderr",
                message: sanitize(line),
            });
        });

        await this.request("initialize", {
            clientInfo: {
                name: "copilot_sdk_codex_capability_spike",
                title: "Copilot SDK Codex Capability Spike",
                version: "0.0.0",
            },
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
                optOutNotificationMethods: null,
            },
        });
        this.notify("initialized", {});
    }

    private handleLine(direction: string, line: string) {
        let parsed: unknown = line;
        try {
            parsed = JSON.parse(line);
        } catch {
            // Keep raw line in sanitized transcript.
        }

        this.transcript.push({
            at: nowIso(),
            direction,
            message: sanitize(parsed),
        });

        if (!isRecord(parsed)) {
            return;
        }

        if (typeof parsed.method === "string" && !("id" in parsed)) {
            this.notifications.push(parsed as JsonRpcNotification);
            return;
        }

        if ("id" in parsed && !("method" in parsed)) {
            const id = parsed.id as JsonRpcId;
            const resolve = this.pending.get(id);
            if (resolve) {
                this.pending.delete(id);
                resolve(parsed as JsonRpcResponse);
            }
        }
    }

    request(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsonRpcResponse> {
        if (!this.child?.stdin.writable) {
            throw new Error("codex app-server is not started");
        }

        const id = this.nextId++;
        const message = { jsonrpc: "2.0", id, method, params };
        this.transcript.push({
            at: nowIso(),
            direction: "client->codex",
            message: sanitize(message),
        });

        this.child.stdin.write(`${JSON.stringify(message)}\n`);

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({
                    id,
                    error: {
                        code: -32000,
                        message: `request timed out after ${timeoutMs}ms`,
                    },
                });
            }, timeoutMs);

            this.pending.set(id, (response) => {
                clearTimeout(timer);
                resolve(response);
            });
        });
    }

    notify(method: string, params: unknown = {}) {
        if (!this.child?.stdin.writable) {
            throw new Error("codex app-server is not started");
        }
        const message = { jsonrpc: "2.0", method, params };
        this.transcript.push({
            at: nowIso(),
            direction: "client->codex",
            message: sanitize(message),
        });
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    notificationCount(): number {
        return this.notifications.length;
    }

    async waitForNotification(
        method: string,
        timeoutMs = 2_000,
        fromIndex = 0,
        predicate: (notification: JsonRpcNotification) => boolean = () => true
    ): Promise<JsonRpcNotification | null> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const notification = this.notifications
                .slice(fromIndex)
                .find((entry) => entry.method === method && predicate(entry));
            if (notification) {
                return notification;
            }
            await delay(50);
        }
        return null;
    }

    async shutdown() {
        if (!this.child) {
            return;
        }
        this.child.kill("SIGTERM");
        await delay(200);
        if (this.child.exitCode === null) {
            this.child.kill("SIGKILL");
        }
    }

    summary() {
        return {
            notifications: this.notifications.map((notification) => sanitize(notification)),
            transcript: this.transcript,
        };
    }
}

async function safeRequest(
    client: RawAppServerClient,
    method: string,
    params: unknown = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
) {
    try {
        return await client.request(method, params, timeoutMs);
    } catch (error) {
        return {
            id: "thrown",
            error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
            },
        } satisfies JsonRpcResponse;
    }
}

async function runSpike() {
    mkdirSync(WORKDIR, { recursive: true });
    const codexHome = prepareCodexHome();
    const runId = cryptoRandomId();
    const report: Record<string, unknown> = {
        runId,
        createdAt: nowIso(),
        codexBin: CODEX_BIN,
        codexVersion: codexVersion(),
        sourceCodexHome: SOURCE_CODEX_HOME,
        probeCodexHome: codexHome,
        workdir: WORKDIR,
        outputPath: OUTPUT_PATH,
        runLiveTurn: RUN_LIVE_TURN,
        phases: {},
        conclusions: {},
    };

    const first = new RawAppServerClient(codexHome);
    let threadId: string | null = null;
    try {
        await first.start();
        const account = await safeRequest(first, "account/read", { refreshToken: false });
        const permissionProfiles = await safeRequest(first, "permissionProfile/list", {
            cwd: WORKDIR,
        });

        const unsupportedMethodProbes = Object.fromEntries(
            await Promise.all(
                ["thread/end", "thread/close", "thread/stop", "thread/tools/update"].map(
                    async (method) => [
                        method,
                        await safeRequest(first, method, {
                            threadId: "00000000-0000-0000-0000-000000000000",
                        }),
                    ]
                )
            )
        );

        const threadStartParams = {
            cwd: WORKDIR,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            ephemeral: false,
            experimentalRawEvents: false,
            dynamicTools: [
                {
                    name: "capability_probe",
                    description: "Return probe information for Codex app-server capability testing.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            message: { type: "string" },
                        },
                        required: ["message"],
                        additionalProperties: false,
                    },
                },
            ],
        };
        const threadStart = await safeRequest(first, "thread/start", threadStartParams);
        threadId = extractThreadId(threadStart);
        const threadStarted = await first.waitForNotification("thread/started");
        const threadPath = extractThreadPath(threadStart);
        const threadRead = threadId
            ? await safeRequest(first, "thread/read", { threadId, includeTurns: true })
            : null;
        const liveTurnNotificationStart = first.notificationCount();
        const liveTurnStartParams =
            RUN_LIVE_TURN && threadId
                ? {
                      threadId,
                      input: [
                          {
                              type: "text",
                              text: LIVE_TURN_PROMPT,
                              text_elements: [],
                          },
                      ],
                      cwd: WORKDIR,
                      approvalPolicy: "never",
                      approvalsReviewer: "user",
                      sandboxPolicy: {
                          type: "readOnly",
                          networkAccess: false,
                      },
                      ...(LIVE_TURN_MODEL ? { model: LIVE_TURN_MODEL } : {}),
                  }
                : null;
        const liveTurnStart = liveTurnStartParams
            ? await safeRequest(first, "turn/start", liveTurnStartParams, LIVE_TURN_TIMEOUT_MS)
            : null;
        const liveTurnCompleted =
            RUN_LIVE_TURN && threadId
                ? await first.waitForNotification(
                      "turn/completed",
                      LIVE_TURN_TIMEOUT_MS,
                      liveTurnNotificationStart,
                      (notification) =>
                          isRecord(notification.params) && notification.params.threadId === threadId
                  )
                : null;
        const threadReadAfterLiveTurn = threadId
            ? await safeRequest(first, "thread/read", { threadId, includeTurns: true })
            : null;
        if (threadPath) {
            await waitForFile(threadPath, RUN_LIVE_TURN ? 10_000 : 2_000);
        }
        const threadResumeSameProcess = threadId
            ? await safeRequest(first, "thread/resume", {
                  threadId,
                  cwd: WORKDIR,
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandbox: "read-only",
                  initialTurnsPage: {
                      limit: 5,
                      sortDirection: "desc",
                      itemsView: "summary",
                  },
              })
            : null;
        const threadReadAfterSameProcessResume = threadId
            ? await safeRequest(first, "thread/read", { threadId, includeTurns: false })
            : null;
        const teardownThreadStart = await safeRequest(first, "thread/start", {
            cwd: WORKDIR,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            ephemeral: false,
            experimentalRawEvents: false,
        });
        const teardownThreadId = extractThreadId(teardownThreadStart);
        const teardownThreadArchive = teardownThreadId
            ? await safeRequest(first, "thread/archive", { threadId: teardownThreadId })
            : null;
        const threadUnsubscribeBeforeRestart =
            RUN_LIVE_TURN && threadId
                ? await safeRequest(first, "thread/unsubscribe", { threadId })
                : null;
        await delay(750);

        report.phases = {
            ...(report.phases as Record<string, unknown>),
            firstProcess: {
                account,
                permissionProfiles,
                unsupportedMethodProbes,
                threadStartParams,
                threadStart,
                threadStarted,
                threadPath,
                threadPathExistsBeforeRestart: threadPath ? existsSync(threadPath) : false,
                threadRead,
                liveTurnStartParams,
                liveTurnStart,
                liveTurnCompleted,
                threadReadAfterLiveTurn,
                threadResumeSameProcess,
                threadReadAfterSameProcessResume,
                teardownThreadStart,
                teardownThreadArchive,
                threadUnsubscribeBeforeRestart,
                transport: first.summary(),
            },
        };
    } finally {
        await first.shutdown();
    }

    const second = new RawAppServerClient(codexHome);
    try {
        await second.start();
        const resumeWithDynamicToolsParams = threadId
            ? {
                  threadId,
                  cwd: WORKDIR,
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandbox: "read-only",
                  initialTurnsPage: {
                      limit: 5,
                      sortDirection: "desc",
                      itemsView: "summary",
                  },
                  dynamicTools: [
                      {
                          name: "capability_probe_after_resume",
                          description:
                              "This field is intentionally sent on resume to check whether Codex rejects, accepts, or ignores it.",
                          inputSchema: {
                              type: "object",
                              properties: {
                                  message: { type: "string" },
                              },
                              required: ["message"],
                              additionalProperties: false,
                          },
                      },
                  ],
              }
            : null;
        const threadResume = resumeWithDynamicToolsParams
            ? await safeRequest(second, "thread/resume", resumeWithDynamicToolsParams)
            : null;
        const threadStartedAfterResume = await second.waitForNotification("thread/started");
        const threadReadAfterRestart = threadId
            ? await safeRequest(second, "thread/read", { threadId, includeTurns: true })
            : null;
        const threadArchive = threadId
            ? await safeRequest(second, "thread/archive", { threadId })
            : null;
        const threadUnsubscribe = threadId
            ? await safeRequest(second, "thread/unsubscribe", { threadId })
            : null;

        report.phases = {
            ...(report.phases as Record<string, unknown>),
            secondProcess: {
                resumeWithDynamicToolsParams,
                threadResume,
                threadStartedAfterResume,
                threadReadAfterRestart,
                threadUnsubscribe,
                threadArchive,
                transport: second.summary(),
            },
        };
    } finally {
        await second.shutdown();
    }

    const phases = asPhaseRecord(report.phases);
    const firstProcess = asPhaseRecord(phases.firstProcess);
    const secondProcess = asPhaseRecord(phases.secondProcess);
    const unsupported = asJsonRpcResponseMap(firstProcess.unsupportedMethodProbes);
    const sameProcessResumeOk = responseOk(asJsonRpcResponse(firstProcess.threadResumeSameProcess));
    const restartResumeOk = responseOk(asJsonRpcResponse(secondProcess.threadResume));
    const unsubscribeOk =
        responseOk(asJsonRpcResponse(firstProcess.threadUnsubscribeBeforeRestart)) ||
        responseOk(asJsonRpcResponse(secondProcess.threadUnsubscribe));
    const archiveOk =
        responseOk(asJsonRpcResponse(firstProcess.teardownThreadArchive)) ||
        responseOk(asJsonRpcResponse(secondProcess.threadArchive));
    const authOk = responseOk(asJsonRpcResponse(firstProcess.account));
    const threadPathExists = firstProcess.threadPathExistsBeforeRestart === true;
    const liveTurnOk = Boolean(firstProcess.liveTurnCompleted);

    report.conclusions = {
        A1: {
            status: unsubscribeOk || archiveOk ? "partial" : "unknown-blocked",
            evidence: [
                "Generated protocol and live probes expose thread/unsubscribe and thread/archive, not thread/end or thread/close.",
                `thread/unsubscribe ok=${String(unsubscribeOk)}`,
                `thread/archive ok=${String(archiveOk)}`,
                `live turn persisted rollout before teardown=${String(threadPathExists)}`,
                `thread/end error=${String(unsupported["thread/end"]?.error?.message ?? "")}`,
                `thread/close error=${String(unsupported["thread/close"]?.error?.message ?? "")}`,
            ],
            implication:
                "Use thread/unsubscribe for connection detach and thread/archive for active-thread teardown if production wants persisted cleanup; do not design around thread/end or thread/close.",
        } satisfies CapabilityVerdict,
        A4: {
            status: restartResumeOk ? "supported" : sameProcessResumeOk ? "partial" : "unknown-blocked",
            evidence: [
                `thread/start id=${threadId ?? "<missing>"}`,
                `live turn completed=${String(liveTurnOk)}`,
                `thread path exists before restart=${String(threadPathExists)}`,
                `thread/resume in same app-server process ok=${String(sameProcessResumeOk)}`,
                `thread/resume after app-server restart ok=${String(restartResumeOk)}`,
            ],
            implication:
                restartResumeOk
                    ? "Codex can resume a non-ephemeral thread by id across app-server restart; current adapter uses ephemeral threads, so production resume requires non-ephemeral threads or adapter-owned replay."
                    : "Codex resume exists, but this probe did not prove restart resume by id. Treat adapter restart continuity as blocked until a rollout-store probe with a persisted turn succeeds or choose adapter-owned replay.",
        } satisfies CapabilityVerdict,
        B1_C1: {
            status: "partial",
            evidence: [
                "ThreadStartParams supports sandbox/permissions/config and dynamicTools, but no SDK-shaped available_tools/excluded_tools field.",
                "Permission profiles are discoverable through permissionProfile/list.",
                "Native-tool suppression still needs an implementation decision around permissions/sandbox and follow-up behavior benchmark.",
            ],
            implication:
                "Do not map SDK available_tools/excluded_tools directly unless a concrete Codex permission/profile/config path is chosen; force read-only/no-network style lockdown for Chatpilot lane until benchmarked.",
        } satisfies CapabilityVerdict,
        B2: {
            status: "unsupported",
            evidence: [
                "Upstream ThreadStartParams has experimental dynamic_tools.",
                "Upstream ThreadResumeParams has no dynamic_tools field.",
                `thread/resume with dynamicTools request ok=${String(restartResumeOk)}; this only proves unknown-field tolerance, not tool refresh.`,
            ],
            implication:
                "Tool-set changes on SDK session.resume must not be implemented as Codex dynamicTools hot-update. Recreate/fork a Codex thread or reject incompatible resume.",
        } satisfies CapabilityVerdict,
        D2: {
            status: authOk ? "supported" : "unknown-blocked",
            evidence: [
                `account/read from isolated CODEX_HOME ok=${String(authOk)}`,
                `source auth.json exists=${String(existsSync(join(SOURCE_CODEX_HOME, "auth.json")))}`,
            ],
            implication:
                "Basic auth inheritance from copied CODEX_HOME works for app-server startup; token refresh still needs a longer production-like validation when turns hit 401/refresh paths.",
        } satisfies CapabilityVerdict,
    };

    writeFileSync(OUTPUT_PATH, `${JSON.stringify(sanitize(report), null, 2)}\n`);
    console.log(JSON.stringify({ outputPath: OUTPUT_PATH, conclusions: report.conclusions }, null, 2));
}

function cryptoRandomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

runSpike().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
