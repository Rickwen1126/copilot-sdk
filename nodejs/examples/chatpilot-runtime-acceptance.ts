import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
    buildToolCallComplianceReport,
    buildToolSchemaRoundTripReport,
    type DynamicToolLike,
    type ToolCallComplianceObservation,
    type ToolCallComplianceReport,
    type ToolDescriptorLike,
    type ToolSchemaRoundTripReport,
} from "../conformance/codexConformanceProof.js";

type BackendName = "copilot-cli" | "codex-adapter";
type AssertionStatus = "pass" | "fail";
type AcceptanceToolset = "phase6" | "all-chatbot";

type Assertion = {
    name: string;
    status: AssertionStatus;
    evidence: string;
};

type MemoRow = {
    id: string;
    route_id: string;
    text: string;
    tags: string;
};

type ManagedProcess = {
    name: string;
    proc: ChildProcess;
    stdout: string[];
    stderr: string[];
};

type ChatpilotSessionReport = {
    userId: string;
    routeId: string;
    sdkSessionId: string;
    marker: string;
    responses: {
        save: unknown;
        list: unknown;
    };
    dbRows: MemoRow[];
    logEvidence: ChatpilotRunReport["logEvidence"];
    toolCallCompliance: ToolCallComplianceReport;
    toolSchemaRoundTrip: ToolSchemaRoundTripReport;
    assertions: Assertion[];
};

type ChatpilotRunReport = {
    backend: BackendName;
    status: AssertionStatus;
    runId: string;
    userId: string;
    routeId: string;
    sdkSessionId: string;
    marker: string;
    chatpilotUrl: string;
    chatpilotPort: number;
    adapterPort?: number;
    paths: {
        runDir: string;
        routeSettings: string;
        routeBindings: string;
        memoryDb: string;
        taskDb: string;
        filesDb: string;
        logFile: string;
        adapterSummary?: string;
    };
    responses: {
        save: unknown;
        list: unknown;
    };
    dbRows: MemoRow[];
    logEvidence: {
        sessionSetupCount: number;
        createdOrResumedCount: number;
        reuseCount: number;
        saveToolCallCount: number;
        saveToolResultCount: number;
        listToolCallCount: number;
        listToolResultCount: number;
        sdkSendCount: number;
        sdkResponseCount: number;
    };
    toolCallCompliance: ToolCallComplianceReport;
    toolSchemaRoundTrip: ToolSchemaRoundTripReport;
    assertions: Assertion[];
    sessions: ChatpilotSessionReport[];
    logs: {
        chatpilotPreview: string;
        adapterPreview?: string;
    };
};

type AcceptanceReport = {
    runId: string;
    generatedAt: string;
    status: AssertionStatus;
    chatpilotRepo: string;
    model: string;
    toolset: AcceptanceToolset;
    toolNames: string[];
    backends: BackendName[];
    reports: ChatpilotRunReport[];
    crossBackendAssertions: Assertion[];
    toolCallCompliance: ToolCallComplianceReport;
    toolSchemaRoundTrip: ToolSchemaRoundTripReport;
};

const CHATPILOT_REPO = process.env.CHATPILOT_REPO ?? "/Users/rickwen/code/chatpilot";
const MODEL = process.env.CHATPILOT_ACCEPTANCE_MODEL ?? "gpt-5.4";
const BACKENDS = parseBackends(process.env.CHATPILOT_ACCEPTANCE_BACKENDS ?? "codex-adapter");
const TOOLSET = parseToolset(process.env.CHATPILOT_ACCEPTANCE_TOOLSET ?? "phase6");
const TOOL_NAMES = toolNamesForToolset(TOOLSET);
const RUN_ID = process.env.CHATPILOT_ACCEPTANCE_RUN_ID ?? randomUUID();
const OUTPUT_PATH = process.env.CHATPILOT_ACCEPTANCE_OUT;
const REQUEST_TIMEOUT_MS = Number(process.env.CHATPILOT_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? 300_000);
const READY_TIMEOUT_MS = Number(process.env.CHATPILOT_ACCEPTANCE_READY_TIMEOUT_MS ?? 120_000);
const CONCURRENT_SESSIONS = positiveIntegerEnv(
    process.env.CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS,
    1
);
const NODEJS_ROOT = process.cwd();

type ChatpilotSessionInput = {
    userId: string;
    routeId: string;
    sdkSessionId: string;
    marker: string;
};

type ChatpilotConversationResult = ChatpilotSessionInput & {
    responses: {
        save: unknown;
        list: unknown;
    };
};

async function main(): Promise<void> {
    const reports: ChatpilotRunReport[] = [];
    for (const backend of BACKENDS) {
        reports.push(await runBackend(backend));
    }

    const crossBackendAssertions = buildCrossBackendAssertions(reports);
    const toolCallCompliance = buildToolCallComplianceReport(
        reports.flatMap((report) =>
            report.toolCallCompliance.observations.map(({ status, issues, ...observation }) => ({
                ...observation,
            }))
        )
    );
    const toolSchemaRoundTrip = buildAggregateToolSchemaRoundTripReport(reports);
    const status = [
        ...reports.flatMap((report) => report.assertions),
        ...crossBackendAssertions,
        ...toolCallCompliance.assertions,
        ...toolSchemaRoundTrip.assertions,
    ].every((assertion) => assertion.status === "pass")
        ? "pass"
        : "fail";

    const report: AcceptanceReport = {
        runId: RUN_ID,
        generatedAt: new Date().toISOString(),
        status,
        chatpilotRepo: CHATPILOT_REPO,
        model: MODEL,
        toolset: TOOLSET,
        toolNames: TOOL_NAMES,
        backends: BACKENDS,
        reports,
        crossBackendAssertions,
        toolCallCompliance,
        toolSchemaRoundTrip,
    };

    const outputPath = OUTPUT_PATH ?? join(tmpdir(), `chatpilot-codex-phase6-${RUN_ID}.json`);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ event: "chatpilot.phase6.report", outputPath, status }));
    if (status !== "pass") {
        process.exitCode = 1;
    }
}

async function runBackend(backend: BackendName): Promise<ChatpilotRunReport> {
    const runId = `${RUN_ID}-${backend}`;
    const runDir = mkdtempSync(join(tmpdir(), `chatpilot-${backend}-`));
    const logDir = join(runDir, "logs");
    const workdir = join(runDir, "workspace");
    const fileAssetsDir = join(runDir, "file-assets");
    mkdirSync(logDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(fileAssetsDir, { recursive: true });

    const routeSettingsPath = join(runDir, "route_settings.yaml");
    const routeBindingsPath = join(runDir, "route_bindings.yaml");
    const memoryDb = join(runDir, "chatpilot.db");
    const taskDb = join(runDir, "tasks.db");
    const filesDb = join(runDir, "files.db");
    const logFile = join(logDir, "chatpilot.log");

    writeFileSync(
        routeSettingsPath,
        buildRouteSettingsYaml({ logDir, model: MODEL, workdir, toolNames: TOOL_NAMES }),
        "utf8"
    );
    writeFileSync(routeBindingsPath, buildRouteBindingsYaml(), "utf8");

    const sessionInputs = Array.from({ length: CONCURRENT_SESSIONS }, (_, index) =>
        createSessionInput(backend, index)
    );

    let adapter: ManagedProcess | undefined;
    let chatpilot: ManagedProcess | undefined;
    let adapterPort: number | undefined;
    let adapterSummary: string | undefined;

    try {
        if (backend === "codex-adapter") {
            adapterPort = await getFreePort();
            adapterSummary = join(runDir, "codex-adapter-summary.json");
            adapter = startAdapter(adapterPort, adapterSummary);
            await waitForProcessLog(adapter, /codex-adapter\.listening/, READY_TIMEOUT_MS);
        }

        const chatpilotPort = await getFreePort();
        const chatpilotUrl = `http://127.0.0.1:${chatpilotPort}`;
        chatpilot = startChatpilot({
            backend,
            port: chatpilotPort,
            routeSettingsPath,
            routeBindingsPath,
            memoryDb,
            taskDb,
            filesDb,
            fileAssetsDir,
            adapterPort,
        });
        await waitForHealth(chatpilotUrl, chatpilot, READY_TIMEOUT_MS);

        const conversations = await Promise.all(
            sessionInputs.map((input) => runChatpilotConversation(chatpilotUrl, input))
        );

        await delay(1_000);
        if (chatpilot) {
            await stopProcess(chatpilot);
            chatpilot = undefined;
        }
        if (adapter) {
            await stopProcess(adapter);
            adapter = undefined;
        }

        const chatpilotLog = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        const adapterTrace =
            adapterSummary && existsSync(adapterSummary)
                ? readFileSync(adapterSummary, "utf8")
                : undefined;

        const sessions = conversations.map((conversation) => {
            const dbRows = readMemoRows(memoryDb, conversation.routeId);
            const logEvidence = collectLogEvidence(chatpilotLog, {
                routeId: conversation.routeId,
                sdkSessionId: conversation.sdkSessionId,
                marker: conversation.marker,
            });
            const toolCallCompliance = buildAcceptanceToolCallCompliance({
                backend,
                logEvidence,
                adapterTrace,
                marker: conversation.marker,
            });
            const toolSchemaRoundTrip = buildBackendToolSchemaRoundTripReport({
                backend,
                adapterTrace,
            });
            const assertions = buildAssertions({
                backend,
                routeId: conversation.routeId,
                sdkSessionId: conversation.sdkSessionId,
                marker: conversation.marker,
                saveResponse: conversation.responses.save,
                listResponse: conversation.responses.list,
                dbRows,
                chatpilotLog,
                logEvidence,
                adapterTrace,
                toolSchemaRoundTrip,
            });
            return {
                userId: conversation.userId,
                routeId: conversation.routeId,
                sdkSessionId: conversation.sdkSessionId,
                marker: conversation.marker,
                responses: conversation.responses,
                dbRows,
                logEvidence,
                toolCallCompliance,
                toolSchemaRoundTrip,
                assertions,
            };
        });
        const primary = sessions[0];
        const toolCallCompliance = buildToolCallComplianceReport(
            sessions.flatMap((session) =>
                session.toolCallCompliance.observations.map(
                    ({ status, issues, ...observation }) => ({
                        ...observation,
                    })
                )
            )
        );
        const toolSchemaRoundTrip = buildBackendToolSchemaRoundTripReport({
            backend,
            adapterTrace,
        });
        const assertions = [
            ...sessions.flatMap((session) => session.assertions),
            ...(backend === "codex-adapter"
                ? toolSchemaRoundTrip.assertions.map(
                      (item) =>
                          ({
                              name: `tool schema round-trip: ${item.name}`,
                              status: item.status === "pass" ? "pass" : "fail",
                              evidence: item.evidence,
                          }) satisfies Assertion
                  )
                : []),
            assertion(
                "requested concurrent session count completed",
                sessions.length === CONCURRENT_SESSIONS,
                `requested=${CONCURRENT_SESSIONS} completed=${sessions.length}`
            ),
            assertion(
                "concurrent sessions kept distinct SDK session ids",
                new Set(sessions.map((session) => session.sdkSessionId)).size === sessions.length,
                `sdk_session_ids=${sessions.map((session) => session.sdkSessionId).join(",")}`
            ),
            assertion(
                "concurrent sessions persisted distinct route markers",
                sessions.every((session) =>
                    session.dbRows.some((row) => row.text.includes(session.marker))
                ),
                `markers=${sessions.map((session) => session.marker).join(",")}`
            ),
        ];

        const status = [...assertions, ...toolCallCompliance.assertions].every(
            (assertion) => assertion.status === "pass"
        )
            ? "pass"
            : "fail";

        return {
            backend,
            status,
            runId,
            userId: primary.userId,
            routeId: primary.routeId,
            sdkSessionId: primary.sdkSessionId,
            marker: primary.marker,
            chatpilotUrl,
            chatpilotPort,
            adapterPort,
            paths: {
                runDir,
                routeSettings: routeSettingsPath,
                routeBindings: routeBindingsPath,
                memoryDb,
                taskDb,
                filesDb,
                logFile,
                adapterSummary,
            },
            responses: primary.responses,
            dbRows: primary.dbRows,
            logEvidence: primary.logEvidence,
            toolCallCompliance,
            toolSchemaRoundTrip,
            assertions,
            sessions,
            logs: {
                chatpilotPreview: tail(chatpilotLog, 12_000),
                adapterPreview: adapterTrace ? tail(adapterTrace, 12_000) : undefined,
            },
        };
    } finally {
        if (chatpilot) {
            await stopProcess(chatpilot);
        }
        if (adapter) {
            await stopProcess(adapter);
        }
    }
}

function createSessionInput(backend: BackendName, index: number): ChatpilotSessionInput {
    const userId = `phase6-${backend}-${index}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return {
        userId,
        routeId: `cli:${userId}`,
        sdkSessionId: `cli-${userId}__phase6`,
        marker: `PHASE6_${backend.replace("-", "_")}_${index}_${randomUUID().slice(0, 8)}`,
    };
}

async function runChatpilotConversation(
    chatpilotUrl: string,
    input: ChatpilotSessionInput
): Promise<ChatpilotConversationResult> {
    const savePrompt = [
        `記住：${input.marker}`,
        "這是 Phase 6 runtime acceptance marker。",
        "你必須呼叫 save_memo 工具保存完整 marker。",
        "工具成功後只回覆 SAVED。",
    ].join(" ");
    const listPrompt = [
        "列出我的備忘錄。",
        "你必須呼叫 list_memos 工具。",
        `回覆必須包含 marker ${input.marker}。`,
    ].join(" ");

    const saveResponse = await postCliChat(chatpilotUrl, {
        message: savePrompt,
        user_id: input.userId,
    });
    const listResponse = await postCliChat(chatpilotUrl, {
        message: listPrompt,
        user_id: input.userId,
    });

    return {
        ...input,
        responses: {
            save: saveResponse,
            list: listResponse,
        },
    };
}

function parseBackends(value: string): BackendName[] {
    const raw = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const expanded = raw.includes("all") ? ["copilot-cli", "codex-adapter"] : raw;
    const backends = expanded.map((item) => {
        if (item !== "copilot-cli" && item !== "codex-adapter") {
            throw new Error(`Unsupported backend '${item}'`);
        }
        return item;
    });
    return Array.from(new Set(backends)) as BackendName[];
}

function parseToolset(value: string): AcceptanceToolset {
    if (value === "phase6" || value === "all-chatbot") {
        return value;
    }
    throw new Error(`Unsupported CHATPILOT_ACCEPTANCE_TOOLSET '${value}'`);
}

function toolNamesForToolset(toolset: AcceptanceToolset): string[] {
    if (toolset === "phase6") {
        return ["save_memo", "list_memos"];
    }
    return [
        "warehouse",
        "quote_search",
        "submit_task",
        "task_history",
        "browse_task",
        "batch_image_analyze",
        "get_calendar",
        "web_search",
        "workproof_attendance_push",
        "download_media",
        "browser_navigate",
        "browser_eval",
        "browser_tabs",
        "document_edit",
        "show_image",
        "save_memo",
        "list_memos",
        "delete_memo",
        "save_custom_prompt",
        "list_custom_prompts",
        "delete_custom_prompt",
        "add_reminder",
        "schedule_task_cron",
        "list_schedules",
        "cancel_schedule",
        "manage_trigger_keywords",
    ];
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return fallback;
    }
    return parsed;
}

function buildRouteSettingsYaml({
    logDir,
    model,
    workdir,
    toolNames,
}: {
    logDir: string;
    model: string;
    workdir: string;
    toolNames: string[];
}): string {
    return `timezone: "Asia/Taipei"

logging:
  enabled: true
  dir: "${escapeYamlString(logDir)}"
  level: INFO
  max_bytes: 20971520
  backup_count: 3

adapters: {}
trigger_keywords: []

match_weights:
  group_id: 10
  user_id: 8
  platform: 5

chatbots:
  phase6:
    model: "${escapeYamlString(model)}"
    system_message: |
      You are Chatpilot Phase 6 runtime acceptance agent.
      You are testing whether a runtime backend behaves like Copilot SDK + Copilot CLI at the app boundary.
      If the user says 記住, remember, save, or asks to persist a marker, you must call save_memo with the exact marker text.
      If the user asks to list or recall memos, you must call list_memos and answer from the tool result.
      Never claim memory changed unless the tool succeeds.
      Keep final replies concise.
    tools: [${toolNames.join(", ")}]
    context_window: 10
    timeout: 300
    workdir: "${escapeYamlString(workdir)}"
    auto_trigger_keywords: []

agents: {}

scheduler:
  concurrent_runners: 1
  max_queue_size: 10
  task_timeout: 300

cron_scheduler:
  tick_interval: 999999
  available_tools: []
`;
}

function buildRouteBindingsYaml(): string {
    return `route_bindings_manual: {}
route_bindings_auto: {}
fallback_bindings:
  - match: {}
    chatbot: phase6
    reply_policy: addressed
    processing_policy: interactive
    observation: null
`;
}

function escapeYamlString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function startAdapter(port: number, summaryPath: string): ManagedProcess {
    return startProcess(
        "codex-adapter",
        process.execPath,
        ["dist/experimental/codexAdapterServer.js"],
        {
            cwd: NODEJS_ROOT,
            env: {
                ...process.env,
                CODEX_ADAPTER_HOST: "127.0.0.1",
                CODEX_ADAPTER_PORT: String(port),
                CODEX_ADAPTER_PROTOCOL_VERSION: "2",
                CODEX_ADAPTER_MODEL: MODEL,
                CODEX_ADAPTER_APPROVAL_POLICY: "on-request",
                CODEX_ADAPTER_APPROVALS_REVIEWER: "auto_review",
                CODEX_ADAPTER_SANDBOX_MODE: "workspaceWrite",
                CODEX_ADAPTER_REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS),
                CODEX_ADAPTER_CLIENT_NAME: "chatpilot-phase6",
                CODEX_ADAPTER_CLIENT_TITLE: "Chatpilot Phase 6 Acceptance",
                CODEX_ADAPTER_SUMMARY_PATH: summaryPath,
            },
        }
    );
}

function startChatpilot({
    backend,
    port,
    routeSettingsPath,
    routeBindingsPath,
    memoryDb,
    taskDb,
    filesDb,
    fileAssetsDir,
    adapterPort,
}: {
    backend: BackendName;
    port: number;
    routeSettingsPath: string;
    routeBindingsPath: string;
    memoryDb: string;
    taskDb: string;
    filesDb: string;
    fileAssetsDir: string;
    adapterPort?: number;
}): ManagedProcess {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ROUTE_SETTINGS_PATH: routeSettingsPath,
        ROUTE_BINDINGS_PATH: routeBindingsPath,
        CHATPILOT_DB: memoryDb,
        CHATPILOT_TASK_DB: taskDb,
        CHATPILOT_FILES_DB: filesDb,
        CHATPILOT_FILE_ASSETS_DIR: fileAssetsDir,
        CHATPILOT_FILE_CLEANUP_INTERVAL_SECONDS: "0",
        CHATPILOT_TICK_INTERVAL: "999999",
        PYTHONUNBUFFERED: "1",
        R2_ENDPOINT: "",
    };

    delete env.CHATPILOT_RUNTIME_BACKEND;
    delete env.CHATPILOT_COPILOT_CLI_URL;

    if (backend === "codex-adapter") {
        if (adapterPort === undefined) {
            throw new Error("adapterPort is required for codex-adapter backend");
        }
        env.CHATPILOT_RUNTIME_BACKEND = "codex-adapter";
        env.CHATPILOT_COPILOT_CLI_URL = `127.0.0.1:${adapterPort}`;
    }

    return startProcess(
        "chatpilot",
        "uv",
        [
            "run",
            "uvicorn",
            "chatpilot.server:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
        ],
        {
            cwd: CHATPILOT_REPO,
            env,
        }
    );
}

function startProcess(
    name: string,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
): ManagedProcess {
    const proc = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
        name,
        proc,
        stdout: [],
        stderr: [],
    };
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => managed.stdout.push(chunk));
    proc.stderr?.on("data", (chunk: string) => managed.stderr.push(chunk));
    proc.on("error", (error) => {
        managed.stderr.push(`${error.stack ?? String(error)}\n`);
    });
    return managed;
}

async function stopProcess(managed: ManagedProcess): Promise<void> {
    if (managed.proc.exitCode !== null || managed.proc.signalCode !== null) {
        return;
    }
    managed.proc.kill("SIGTERM");
    const exited = await waitForExit(managed, 10_000);
    if (!exited) {
        managed.proc.kill("SIGKILL");
        await waitForExit(managed, 5_000);
    }
}

async function waitForExit(managed: ManagedProcess, timeoutMs: number): Promise<boolean> {
    if (managed.proc.exitCode !== null || managed.proc.signalCode !== null) {
        return true;
    }
    return await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
            cleanup();
            resolve(true);
        };
        const cleanup = (): void => {
            clearTimeout(timeout);
            managed.proc.off("exit", onExit);
        };
        managed.proc.once("exit", onExit);
    });
}

async function waitForProcessLog(
    managed: ManagedProcess,
    pattern: RegExp,
    timeoutMs: number
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pattern.test([...managed.stdout, ...managed.stderr].join(""))) {
            return;
        }
        assertProcessAlive(managed);
        await delay(250);
    }
    throw new Error(
        `${managed.name} did not emit ${pattern} within ${timeoutMs}ms\n${processPreview(managed)}`
    );
}

async function waitForHealth(
    baseUrl: string,
    managed: ManagedProcess,
    timeoutMs: number
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                return;
            }
        } catch {
            // Server not ready yet.
        }
        assertProcessAlive(managed);
        await delay(500);
    }
    throw new Error(
        `Chatpilot health did not pass within ${timeoutMs}ms\n${processPreview(managed)}`
    );
}

function assertProcessAlive(managed: ManagedProcess): void {
    if (managed.proc.exitCode !== null || managed.proc.signalCode !== null) {
        throw new Error(
            `${managed.name} exited early code=${managed.proc.exitCode} signal=${managed.proc.signalCode}\n${processPreview(
                managed
            )}`
        );
    }
}

function processPreview(managed: ManagedProcess): string {
    return tail(
        [
            `--- ${managed.name} stdout ---`,
            managed.stdout.join(""),
            `--- ${managed.name} stderr ---`,
            managed.stderr.join(""),
        ].join("\n"),
        12_000
    );
}

async function postCliChat(
    baseUrl: string,
    body: { message: string; user_id: string }
): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}/cli/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            // Keep raw response body.
        }
        if (!response.ok) {
            throw new Error(`/cli/chat failed status=${response.status} body=${text}`);
        }
        return parsed;
    } finally {
        clearTimeout(timeout);
    }
}

function readMemoRows(dbPath: string, routeId: string): MemoRow[] {
    if (!existsSync(dbPath)) {
        return [];
    }
    const script = [
        "import json, sqlite3, sys",
        "db_path, route_id = sys.argv[1], sys.argv[2]",
        "con = sqlite3.connect(db_path)",
        "rows = con.execute(",
        "    'SELECT id, route_id, text, tags FROM memory_memos WHERE route_id = ? ORDER BY created_at',",
        "    (route_id,),",
        ").fetchall()",
        "print(json.dumps([dict(id=r[0], route_id=r[1], text=r[2], tags=r[3]) for r in rows], ensure_ascii=False))",
    ].join("\n");
    const output = execFileSync(resolvePython(), ["-c", script, dbPath, routeId], {
        encoding: "utf8",
    });
    return JSON.parse(output) as MemoRow[];
}

function resolvePython(): string {
    for (const candidate of ["/usr/bin/python3", "python3", "python"]) {
        try {
            execFileSync(candidate, ["-c", "import sqlite3"], {
                stdio: "ignore",
            });
            return candidate;
        } catch {
            // Try next candidate.
        }
    }
    throw new Error("No Python interpreter with sqlite3 available");
}

function collectLogEvidence(
    log: string,
    { routeId, sdkSessionId, marker }: { routeId: string; sdkSessionId: string; marker: string }
): ChatpilotRunReport["logEvidence"] {
    return {
        sessionSetupCount: countMatches(
            log,
            new RegExp(
                `Session setup route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}`,
                "g"
            )
        ),
        createdOrResumedCount:
            countMatches(
                log,
                new RegExp(
                    `Created route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}`,
                    "g"
                )
            ) +
            countMatches(
                log,
                new RegExp(
                    `Resumed route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}`,
                    "g"
                )
            ),
        reuseCount: countMatches(
            log,
            new RegExp(
                `Reuse route=${escapeRegExp(routeId)}.*session=${escapeRegExp(sdkSessionId)}`,
                "g"
            )
        ),
        saveToolCallCount: countMatches(
            log,
            new RegExp(
                `\\[tool_call\\] tool=save_memo.*route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}.*${escapeRegExp(marker)}`,
                "g"
            )
        ),
        saveToolResultCount: countMatches(
            log,
            new RegExp(
                `\\[tool_result\\] tool=save_memo.*route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}.*status=success`,
                "g"
            )
        ),
        listToolCallCount: countMatches(
            log,
            new RegExp(
                `\\[tool_call\\] tool=list_memos.*route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}`,
                "g"
            )
        ),
        listToolResultCount: countMatches(
            log,
            new RegExp(
                `\\[tool_result\\] tool=list_memos.*route_id=${escapeRegExp(routeId)}.*sdk_session_id=${escapeRegExp(sdkSessionId)}.*status=success[\\s\\S]*?${escapeRegExp(marker)}`,
                "g"
            )
        ),
        sdkSendCount: countMatches(
            log,
            new RegExp(`\\[SDK\\] ${escapeRegExp(sdkSessionId)} sending`, "g")
        ),
        sdkResponseCount: countMatches(
            log,
            new RegExp(`\\[SDK\\] ${escapeRegExp(sdkSessionId)} response`, "g")
        ),
    };
}

function buildAcceptanceToolCallCompliance({
    backend,
    logEvidence,
    adapterTrace,
    marker,
}: {
    backend: BackendName;
    logEvidence: ChatpilotRunReport["logEvidence"];
    adapterTrace?: string;
    marker: string;
}): ToolCallComplianceReport {
    const nativeToolCalls =
        backend === "codex-adapter" ? extractKnownNativeToolCalls(adapterTrace ?? "", marker) : [];
    const observations: ToolCallComplianceObservation[] = [
        {
            backend,
            promptId: "save-marker",
            expectedToolName: "save_memo",
            sdkToolCalls: observedToolCalls("save_memo", logEvidence.saveToolCallCount),
            nativeToolCalls,
            resultStatus: logEvidence.saveToolResultCount >= 1 ? "ok" : "error",
            evidence: `save_call_count=${logEvidence.saveToolCallCount} save_result_count=${logEvidence.saveToolResultCount}`,
        },
        {
            backend,
            promptId: "list-marker",
            expectedToolName: "list_memos",
            sdkToolCalls: observedToolCalls("list_memos", logEvidence.listToolCallCount),
            nativeToolCalls,
            resultStatus: logEvidence.listToolResultCount >= 1 ? "ok" : "error",
            evidence: `list_call_count=${logEvidence.listToolCallCount} list_result_count=${logEvidence.listToolResultCount}`,
        },
    ];

    return buildToolCallComplianceReport(observations);
}

function buildAggregateToolSchemaRoundTripReport(
    reports: ChatpilotRunReport[]
): ToolSchemaRoundTripReport {
    const expectedTools: ToolDescriptorLike[] = [];
    const observedDynamicTools: DynamicToolLike[] = [];
    for (const report of reports) {
        expectedTools.push(
            ...report.toolSchemaRoundTrip.items.map((item) => ({
                name: item.toolName,
                description: item.expectedDescription,
                parameters: item.expectedInputSchema,
            }))
        );
        observedDynamicTools.push(
            ...report.toolSchemaRoundTrip.items
                .filter(
                    (item) =>
                        item.observedDescription !== undefined ||
                        item.observedInputSchema !== undefined
                )
                .map((item) => ({
                    name: item.toolName,
                    description: item.observedDescription,
                    inputSchema: item.observedInputSchema,
                }))
        );
    }
    return buildToolSchemaRoundTripReport({
        expectedTools: uniqueToolsByName(expectedTools),
        observedDynamicTools: uniqueDynamicToolsByName(observedDynamicTools),
    });
}

function buildBackendToolSchemaRoundTripReport({
    backend,
    adapterTrace,
}: {
    backend: BackendName;
    adapterTrace?: string;
}): ToolSchemaRoundTripReport {
    if (backend !== "codex-adapter") {
        return {
            status: "not-run",
            expectedToolCount: 0,
            observedToolCount: 0,
            items: [],
            assertions: [
                {
                    name: "tool schema round-trip requires Codex adapter trace",
                    status: "not-run",
                    evidence: `backend=${backend}`,
                },
            ],
        };
    }
    const trace = parseAdapterSummary(adapterTrace);
    const expectedTools = uniqueToolsByName(extractSdkTools(trace));
    const observedDynamicTools = uniqueDynamicToolsByName(extractCodexDynamicTools(trace));
    return buildToolSchemaRoundTripReport({ expectedTools, observedDynamicTools });
}

function parseAdapterSummary(adapterTrace: string | undefined): unknown {
    if (!adapterTrace) {
        return undefined;
    }
    try {
        return JSON.parse(adapterTrace);
    } catch {
        return undefined;
    }
}

function extractSdkTools(summary: unknown): ToolDescriptorLike[] {
    return transcriptEntries(summary, "transcripts")
        .filter((entry) => entry.direction === "sdk->adapter.request")
        .flatMap((entry) => {
            const message = asRecord(entry.message);
            if (message?.method !== "session.create") {
                return [];
            }
            const params = asRecord(message.params);
            const tools = Array.isArray(params?.tools) ? params.tools : [];
            return tools.filter(isRecord).map((tool) => ({
                name: typeof tool.name === "string" ? tool.name : "unknown_tool",
                description: typeof tool.description === "string" ? tool.description : undefined,
                parameters: asRecord(tool.parameters) ?? undefined,
            }));
        })
        .filter((tool) => tool.name !== "unknown_tool");
}

function extractCodexDynamicTools(summary: unknown): DynamicToolLike[] {
    return transcriptEntries(asRecord(summary)?.codex, "transcripts")
        .filter((entry) => entry.direction === "adapter->codex")
        .flatMap((entry) => {
            const message = asRecord(entry.message);
            if (message?.method !== "thread/start") {
                return [];
            }
            const params = asRecord(message.params);
            const dynamicTools = Array.isArray(params?.dynamicTools) ? params.dynamicTools : [];
            return dynamicTools.filter(isRecord).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            }));
        });
}

function transcriptEntries(
    source: unknown,
    key: string
): Array<{ direction?: unknown; message?: unknown }> {
    const record = asRecord(source);
    const entries = record && Array.isArray(record[key]) ? record[key] : [];
    return entries.filter(isRecord) as Array<{ direction?: unknown; message?: unknown }>;
}

function uniqueToolsByName(tools: ToolDescriptorLike[]): ToolDescriptorLike[] {
    return [...new Map(tools.map((tool) => [tool.name, tool])).values()];
}

function uniqueDynamicToolsByName(tools: DynamicToolLike[]): DynamicToolLike[] {
    return [
        ...new Map(
            tools
                .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
                .map((tool) => [String(tool.name), tool])
        ).values(),
    ];
}

function observedToolCalls(toolName: string, count: number): string[] {
    return Array.from({ length: count }, () => toolName);
}

function extractKnownNativeToolCalls(adapterTrace: string, marker: string): string[] {
    const nativeToolNames = [
        "apply_patch",
        "local_shell",
        "read_file",
        "shell",
        "update_plan",
        "write_file",
    ];
    const parsed = parseAdapterSummary(adapterTrace);
    const markerScopedText = transcriptEntries(parsed, "transcripts")
        .filter((entry) => JSON.stringify(entry.message).includes(marker))
        .map((entry) => JSON.stringify(entry.message))
        .join("\n");
    const searchText = [markerScopedText, adapterTrace].filter(Boolean).join("\n");
    return nativeToolNames.filter((toolName) =>
        new RegExp(
            `"name"\\s*:\\s*"${escapeRegExp(toolName)}"|toolName=${escapeRegExp(toolName)}`
        ).test(searchText)
    );
}

function buildAssertions({
    backend,
    routeId,
    sdkSessionId,
    marker,
    saveResponse,
    listResponse,
    dbRows,
    logEvidence,
    adapterTrace,
    toolSchemaRoundTrip,
}: {
    backend: BackendName;
    routeId: string;
    sdkSessionId: string;
    marker: string;
    saveResponse: unknown;
    listResponse: unknown;
    dbRows: MemoRow[];
    chatpilotLog: string;
    logEvidence: ChatpilotRunReport["logEvidence"];
    adapterTrace?: string;
    toolSchemaRoundTrip: ToolSchemaRoundTripReport;
}): Assertion[] {
    const matchingRows = dbRows.filter((row) => row.text.includes(marker));
    const listText = responseText(listResponse);
    const assertions: Assertion[] = [
        assertion(
            "cli chat save request returned response",
            responseText(saveResponse).length > 0,
            `response=${JSON.stringify(saveResponse).slice(0, 300)}`
        ),
        assertion(
            "new session setup logged with stable sdk_session_id",
            logEvidence.sessionSetupCount >= 1,
            `route_id=${routeId} sdk_session_id=${sdkSessionId} count=${logEvidence.sessionSetupCount}`
        ),
        assertion(
            "new session created or resumed through SDK",
            logEvidence.createdOrResumedCount >= 1,
            `created_or_resumed_count=${logEvidence.createdOrResumedCount}`
        ),
        assertion(
            "save_memo tool call reached Chatpilot tool handler",
            logEvidence.saveToolCallCount >= 1,
            `save_tool_call_count=${logEvidence.saveToolCallCount}`
        ),
        assertion(
            "save_memo tool result succeeded",
            logEvidence.saveToolResultCount >= 1,
            `save_tool_result_count=${logEvidence.saveToolResultCount}`
        ),
        assertion(
            "memory side effect persisted exact marker",
            matchingRows.length >= 1,
            `matching_rows=${matchingRows.length} route_id=${routeId}`
        ),
        assertion(
            "second request reused same app-level runtime session",
            logEvidence.reuseCount >= 1,
            `reuse_count=${logEvidence.reuseCount} sdk_session_id=${sdkSessionId}`
        ),
        assertion(
            "list_memos tool call reached Chatpilot tool handler",
            logEvidence.listToolCallCount >= 1,
            `list_tool_call_count=${logEvidence.listToolCallCount}`
        ),
        assertion(
            "list_memos tool result returned persisted marker",
            logEvidence.listToolResultCount >= 1,
            `list_tool_result_count=${logEvidence.listToolResultCount}`
        ),
        assertion(
            "run-session final response includes persisted marker",
            listText.includes(marker),
            `response=${listText.slice(0, 300)}`
        ),
        assertion(
            "SDK send/response completed both turns",
            logEvidence.sdkSendCount >= 2 && logEvidence.sdkResponseCount >= 2,
            `send=${logEvidence.sdkSendCount} response=${logEvidence.sdkResponseCount}`
        ),
    ];

    if (backend === "codex-adapter") {
        assertions.push(
            assertion(
                "adapter emitted protocol v2 SDK-visible tool flow",
                Boolean(
                    adapterTrace?.includes("tool.call") && adapterTrace.includes("item/tool/call")
                ),
                "expected adapter log to include Codex item/tool/call and SDK tool.call"
            )
        );
        assertions.push(
            assertion(
                "all Chatpilot SDK tool schemas round-trip to Codex dynamic tools",
                toolSchemaRoundTrip.status === "pass",
                `expected=${toolSchemaRoundTrip.expectedToolCount} observed=${toolSchemaRoundTrip.observedToolCount}`
            )
        );
    }

    return assertions;
}

function buildCrossBackendAssertions(reports: ChatpilotRunReport[]): Assertion[] {
    const assertions: Assertion[] = [];
    if (reports.length < 2) {
        return assertions;
    }
    const byBackend = new Map(reports.map((report) => [report.backend, report]));
    const baseline = byBackend.get("copilot-cli");
    const adapter = byBackend.get("codex-adapter");
    if (!baseline || !adapter) {
        return assertions;
    }
    assertions.push(
        assertion(
            "both backends pass the same Chatpilot app-level acceptance flow",
            baseline.status === "pass" && adapter.status === "pass",
            `copilot-cli=${baseline.status} codex-adapter=${adapter.status}`
        ),
        assertion(
            "both backends persist one or more memo rows for their route",
            baseline.dbRows.length > 0 && adapter.dbRows.length > 0,
            `copilot-cli_rows=${baseline.dbRows.length} codex-adapter_rows=${adapter.dbRows.length}`
        ),
        assertion(
            "both backends use the same Chatpilot SDK-visible tool intents",
            baseline.logEvidence.saveToolCallCount >= 1 &&
                adapter.logEvidence.saveToolCallCount >= 1 &&
                baseline.logEvidence.listToolCallCount >= 1 &&
                adapter.logEvidence.listToolCallCount >= 1,
            `copilot-cli save/list=${baseline.logEvidence.saveToolCallCount}/${baseline.logEvidence.listToolCallCount}; codex-adapter save/list=${adapter.logEvidence.saveToolCallCount}/${adapter.logEvidence.listToolCallCount}`
        )
    );
    return assertions;
}

function assertion(name: string, condition: boolean, evidence: string): Assertion {
    return {
        name,
        status: condition ? "pass" : "fail",
        evidence,
    };
}

function responseText(response: unknown): string {
    if (
        response &&
        typeof response === "object" &&
        "response" in response &&
        typeof response.response === "string"
    ) {
        return response.response;
    }
    return typeof response === "string" ? response : JSON.stringify(response);
}

function countMatches(value: string, pattern: RegExp): number {
    return Array.from(value.matchAll(pattern)).length;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tail(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("Unable to allocate TCP port"));
                return;
            }
            const port = address.port;
            server.close(() => {
                if ([4800, 4801, 4811].includes(port)) {
                    getFreePort().then(resolve, reject);
                    return;
                }
                resolve(port);
            });
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
