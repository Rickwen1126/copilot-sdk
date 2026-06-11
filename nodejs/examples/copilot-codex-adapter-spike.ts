import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { CopilotClient, approveAll } from "../dist/index.js";
import {
    approvalProbePathForBackend,
    approvalProbePrompt,
    denialProbePathForBackend,
    denialProbePrompt,
    fileApprovalProbePrompt,
    fileDenialProbePrompt,
    fileDenyProbeNameForBackend,
    fileProbeNameForBackend,
    fileProbePath,
    permissionRequestKinds,
    permissionRequestsWithKind,
    promptIntentPass,
    readApprovalProbeResult,
    validateShellPermissionRequest,
    validateWritePermissionRequest,
    type ApprovalProbeResult,
} from "../conformance/codexConformanceApprovalProbe.js";
import {
    collectAdapterLedger,
    collectCopilotLedger,
    countLedgerHops,
    hasLedgerHop,
    type NormalizedLedgerEntry,
} from "../conformance/codexConformanceLedger.js";
import {
    startClientWithRecorder,
    summarizeUnknownError,
} from "../conformance/codexConformanceProtocolRecorder.js";
import {
    buildConformanceReportArtifact,
    combineStatusTriplet,
    combineStatuses,
    makeCheck,
    statusFromBooleans,
    statusTripletFromOptionalProbe,
    type ConformanceCheck,
    type ConformanceReport,
} from "../conformance/codexConformanceReport.js";
import {
    createScenarioEventBuckets,
    recordScenarioEvent,
    summarizeScenarioEventTypes,
    type ObservedEvent,
} from "../conformance/codexConformanceScenarioState.js";
import {
    customToolProbeDataPass,
    customToolProbeFinalMessageUsesResult,
    customToolProbeHandlerCallSummary,
    customToolProbeIntentPass,
    toolFailureHandlerCallSummary,
    toolFailureProbeDataPass,
    toolFailureProbeIntentPass,
    type CustomToolProbeExpectation,
    type ToolFailureProbeExpectation,
} from "../conformance/codexConformanceToolProbe.js";
import {
    createDenyRuntimeFactTool,
    createFailRuntimeFactTool,
    createLookupRuntimeFactTool,
    toolDeniedPrompt,
    toolFailurePrompt,
    toolProbePrompt,
    type ToolHandlerCall,
    type ToolProbeToolConfig,
} from "../conformance/codexConformanceToolFactory.js";
import {
    CodexCopilotAdapterServer,
    type CodexAdapterSandboxMode,
} from "../src/experimental/codexAdapter.js";

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
const CUSTOM_TOOL_PROBE_EXPECTATION: CustomToolProbeExpectation = {
    topic: TOOL_PROBE_TOPIC,
    toolName: TOOL_PROBE_NAME,
    expectedResult: TOOL_PROBE_RESULT,
};
const TOOL_FAILURE_PROBE_EXPECTATION: ToolFailureProbeExpectation = {
    topic: TOOL_PROBE_TOPIC,
    failureToolName: TOOL_FAILURE_NAME,
    deniedToolName: TOOL_DENIED_NAME,
    expectedFailureError: TOOL_FAILURE_ERROR,
    expectedDeniedResult: TOOL_DENIED_RESULT,
};
const TOOL_PROBE_TOOL_CONFIG: ToolProbeToolConfig = {
    topic: TOOL_PROBE_TOPIC,
    lookupToolName: TOOL_PROBE_NAME,
    lookupResult: TOOL_PROBE_RESULT,
    failureToolName: TOOL_FAILURE_NAME,
    failureError: TOOL_FAILURE_ERROR,
    deniedToolName: TOOL_DENIED_NAME,
    deniedResult: TOOL_DENIED_RESULT,
};
const APPROVAL_PROBE_PATH_OPTIONS = {
    basePath: APPROVAL_PROBE_BASE_PATH,
    phase: SPIKE_PHASE,
};
const FILE_PROBE_NAME_OPTIONS = {
    enabled: RUN_FILE_PROBE,
    phase: SPIKE_PHASE,
    runId: RUN_ID,
};

mkdirSync(WORKDIR, { recursive: true });

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

function nowIso(): string {
    return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function nestedRecord(
    record: Record<string, unknown>,
    key: string
): Record<string, unknown> | undefined {
    const value = record[key];
    return isRecord(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
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

    const baselineStatuses = statusTripletFromOptionalProbe({
        probePresent: !!baselineApprovalProbe,
        configured: scenarioConfigured,
        backendRecorded: !!protocol,
        tracePassed: baselineTrace,
        dataPassed: baselineData,
        intentPassed: baselineIntent,
    });
    const adapterStatuses = statusTripletFromOptionalProbe({
        probePresent: !!adapterApprovalProbe,
        configured: scenarioConfigured,
        backendRecorded: !!adapter,
        tracePassed: adapterTrace,
        dataPassed: adapterData,
        intentPassed: adapterIntent,
    });

    return makeCheck({
        capability: "command approval approve",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatusTriplet(baselineStatuses),
            codexAdapter: combineStatusTriplet(adapterStatuses),
        },
        traceParity: combineStatuses(baselineStatuses.trace, adapterStatuses.trace),
        dataAssertion: combineStatuses(baselineStatuses.data, adapterStatuses.data),
        intentAssertion: combineStatuses(baselineStatuses.intent, adapterStatuses.intent),
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

    const baselineStatuses = statusTripletFromOptionalProbe({
        probePresent: !!baselineDenialProbe,
        configured: scenarioConfigured,
        backendRecorded: !!protocol,
        tracePassed: baselineTrace,
        dataPassed: baselineData,
        intentPassed: baselineIntent,
    });
    const adapterStatuses = statusTripletFromOptionalProbe({
        probePresent: !!adapterDenialProbe,
        configured: scenarioConfigured,
        backendRecorded: !!adapter,
        tracePassed: adapterTrace,
        dataPassed: adapterData,
        intentPassed: adapterIntent,
    });

    return makeCheck({
        capability: "command approval deny",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatusTriplet(baselineStatuses),
            codexAdapter: combineStatusTriplet(adapterStatuses),
        },
        traceParity: combineStatuses(baselineStatuses.trace, adapterStatuses.trace),
        dataAssertion: combineStatuses(baselineStatuses.data, adapterStatuses.data),
        intentAssertion: combineStatuses(baselineStatuses.intent, adapterStatuses.intent),
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

    const baselineStatuses = statusTripletFromOptionalProbe({
        probePresent: !!baselineApprovalProbe && !!baselineDenialProbe,
        configured: RUN_FILE_PROBE,
        backendRecorded: !!protocol,
        tracePassed: baselineTrace,
        dataPassed: baselineData,
        intentPassed: baselineIntent,
    });
    const adapterStatuses = statusTripletFromOptionalProbe({
        probePresent: !!adapterApprovalProbe && !!adapterDenialProbe,
        configured: RUN_FILE_PROBE,
        backendRecorded: !!adapter,
        tracePassed: adapterTrace,
        dataPassed: adapterData,
        intentPassed: adapterIntent,
    });

    return makeCheck({
        capability: "file approval approve/deny",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatusTriplet(baselineStatuses),
            codexAdapter: combineStatusTriplet(adapterStatuses),
        },
        traceParity: combineStatuses(baselineStatuses.trace, adapterStatuses.trace),
        dataAssertion: combineStatuses(baselineStatuses.data, adapterStatuses.data),
        intentAssertion: combineStatuses(baselineStatuses.intent, adapterStatuses.intent),
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

    const baselineData = customToolProbeDataPass(baselineToolProbe, CUSTOM_TOOL_PROBE_EXPECTATION);
    const adapterData = customToolProbeDataPass(adapterToolProbe, CUSTOM_TOOL_PROBE_EXPECTATION);
    const baselineIntent = customToolProbeIntentPass(
        baselineToolProbe,
        CUSTOM_TOOL_PROBE_EXPECTATION
    );
    const adapterIntent = customToolProbeIntentPass(
        adapterToolProbe,
        CUSTOM_TOOL_PROBE_EXPECTATION
    );

    const baselineStatuses = statusTripletFromOptionalProbe({
        probePresent: !!baselineToolProbe,
        configured: RUN_TOOL_PROBE,
        backendRecorded: !!protocol,
        tracePassed: baselineTrace,
        dataPassed: baselineData,
        intentPassed: baselineIntent,
    });
    const adapterStatuses = statusTripletFromOptionalProbe({
        probePresent: !!adapterToolProbe,
        configured: RUN_TOOL_PROBE,
        backendRecorded: !!adapter,
        tracePassed: adapterTrace,
        dataPassed: adapterData,
        intentPassed: adapterIntent,
    });

    return makeCheck({
        capability: "custom tool call",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatusTriplet(baselineStatuses),
            codexAdapter: combineStatusTriplet(adapterStatuses),
        },
        traceParity: combineStatuses(baselineStatuses.trace, adapterStatuses.trace),
        dataAssertion: combineStatuses(baselineStatuses.data, adapterStatuses.data),
        intentAssertion: combineStatuses(baselineStatuses.intent, adapterStatuses.intent),
        evidence: [
            `baselineToolProbe.toolName=${getNestedString(baselineToolProbe, "toolName") ?? ""}`,
            `baselineToolProbe.handlerCalls=${customToolProbeHandlerCallSummary(baselineToolProbe)}`,
            `baselineToolProbe.assertionFailures=${baselineFailures.join("|")}`,
            `baselineToolProbe.assistantHash=${hashString(getNestedString(baselineToolProbe, "assistantMessage") ?? "")}`,
            `baselineToolProbe.finalUsesResult=${String(customToolProbeFinalMessageUsesResult(baselineToolProbe, CUSTOM_TOOL_PROBE_EXPECTATION))}`,
            `adapterToolProbe.toolName=${getNestedString(adapterToolProbe, "toolName") ?? ""}`,
            `adapterToolProbe.handlerCalls=${customToolProbeHandlerCallSummary(adapterToolProbe)}`,
            `adapterToolProbe.assertionFailures=${adapterFailures.join("|")}`,
            `adapterToolProbe.assistantHash=${hashString(getNestedString(adapterToolProbe, "assistantMessage") ?? "")}`,
            `adapterToolProbe.finalUsesResult=${String(customToolProbeFinalMessageUsesResult(adapterToolProbe, CUSTOM_TOOL_PROBE_EXPECTATION))}`,
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

    const baselineData = toolFailureProbeDataPass(
        baselineToolFailureProbe,
        TOOL_FAILURE_PROBE_EXPECTATION
    );
    const adapterData = toolFailureProbeDataPass(
        adapterToolFailureProbe,
        TOOL_FAILURE_PROBE_EXPECTATION
    );
    const baselineIntent = toolFailureProbeIntentPass(
        baselineToolFailureProbe,
        TOOL_FAILURE_PROBE_EXPECTATION
    );
    const adapterIntent = toolFailureProbeIntentPass(
        adapterToolFailureProbe,
        TOOL_FAILURE_PROBE_EXPECTATION
    );

    const baselineStatuses = statusTripletFromOptionalProbe({
        probePresent: !!baselineToolFailureProbe,
        configured: RUN_TOOL_FAILURE_PROBE,
        backendRecorded: !!protocol,
        tracePassed: baselineTrace,
        dataPassed: baselineData,
        intentPassed: baselineIntent,
    });
    const adapterStatuses = statusTripletFromOptionalProbe({
        probePresent: !!adapterToolFailureProbe,
        configured: RUN_TOOL_FAILURE_PROBE,
        backendRecorded: !!adapter,
        tracePassed: adapterTrace,
        dataPassed: adapterData,
        intentPassed: adapterIntent,
    });

    return makeCheck({
        capability: "tool deny or failure",
        profile: "Coding Agent Profile",
        backendStatus: {
            copilotCli: combineStatusTriplet(baselineStatuses),
            codexAdapter: combineStatusTriplet(adapterStatuses),
        },
        traceParity: combineStatuses(baselineStatuses.trace, adapterStatuses.trace),
        dataAssertion: combineStatuses(baselineStatuses.data, adapterStatuses.data),
        intentAssertion: combineStatuses(baselineStatuses.intent, adapterStatuses.intent),
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
    return buildConformanceReportArtifact({
        runId,
        generatedAt: nowIso(),
        checks,
        copilotLedger,
        adapterLedger,
    });
}

async function runToolProbeWithClient(
    client: CopilotClient,
    observedEvents: ObservedEvent[],
    stepTrace: string[],
    tracePrefix: string
): Promise<ToolProbeResult> {
    const prompt = toolProbePrompt(TOOL_PROBE_TOOL_CONFIG);
    const handlerCalls: ToolHandlerCall[] = [];
    const assertionFailures: string[] = [];
    const session = await client.createSession({
        onPermissionRequest: approveAll,
        tools: [
            createLookupRuntimeFactTool({
                config: TOOL_PROBE_TOOL_CONFIG,
                handlerCalls,
                assertionFailures,
            }),
        ],
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
    observedEvents: ObservedEvent[],
    stepTrace: string[],
    tracePrefix: string
): Promise<ToolFailureProbeResult> {
    const failurePrompt = toolFailurePrompt(TOOL_PROBE_TOOL_CONFIG);
    const deniedPrompt = toolDeniedPrompt(TOOL_PROBE_TOOL_CONFIG);
    const failureHandlerCalls: ToolHandlerCall[] = [];
    const deniedHandlerCalls: ToolHandlerCall[] = [];
    const assertionFailures: string[] = [];

    const failureSession = await client.createSession({
        onPermissionRequest: approveAll,
        tools: [
            createFailRuntimeFactTool({
                config: TOOL_PROBE_TOOL_CONFIG,
                handlerCalls: failureHandlerCalls,
                assertionFailures,
            }),
        ],
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
        tools: [
            createDenyRuntimeFactTool({
                config: TOOL_PROBE_TOOL_CONFIG,
                handlerCalls: deniedHandlerCalls,
                assertionFailures,
            }),
        ],
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

    const observedEvents = createScenarioEventBuckets();
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
            onEvent: recordScenarioEvent(observedEvents, "client1"),
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
            onEvent: recordScenarioEvent(observedEvents, "client2"),
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

        const approvalProbePath = approvalProbePathForBackend(
            "copilot-cli",
            APPROVAL_PROBE_PATH_OPTIONS
        );
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
                onEvent: recordScenarioEvent(observedEvents, "approvalProbe"),
            });
            stepTrace.push("approvalProbe.session_created");
            const approvalAssistantMessage = await approvalSession.sendAndWait(
                { prompt: approvalProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("approvalProbe.turn_completed");
            await approvalSession.disconnect();
            stepTrace.push("approvalProbe.disconnected");
            approvalProbe = readApprovalProbeResult({
                path: approvalProbePath,
                prompt: approvalProbePromptText,
                assistantMessage: approvalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const denialProbePath = denialProbePathForBackend(
            "copilot-cli",
            APPROVAL_PROBE_PATH_OPTIONS
        );
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
                onEvent: recordScenarioEvent(observedEvents, "denialProbe"),
            });
            stepTrace.push("denialProbe.session_created");
            const denialAssistantMessage = await denialSession.sendAndWait(
                { prompt: denialProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("denialProbe.turn_completed");
            await denialSession.disconnect();
            stepTrace.push("denialProbe.disconnected");
            denialProbe = readApprovalProbeResult({
                path: denialProbePath,
                prompt: denialProbePromptText,
                assistantMessage: denialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const fileApprovalName = fileProbeNameForBackend("copilot-cli", FILE_PROBE_NAME_OPTIONS);
        const fileApprovalPath = fileProbePath(fileApprovalName, WORKDIR);
        if (fileApprovalName && fileApprovalPath) {
            const fileApprovalPromptText = fileApprovalProbePrompt(
                fileApprovalName,
                FILE_APPROVE_CONTENT
            );
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
                onEvent: recordScenarioEvent(observedEvents, "fileApprovalProbe"),
            });
            stepTrace.push("fileApprovalProbe.session_created");
            const fileApprovalAssistantMessage = await fileApprovalSession.sendAndWait(
                { prompt: fileApprovalPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileApprovalProbe.turn_completed");
            await fileApprovalSession.disconnect();
            stepTrace.push("fileApprovalProbe.disconnected");
            fileApprovalProbe = readApprovalProbeResult({
                path: fileApprovalPath,
                prompt: fileApprovalPromptText,
                assistantMessage: fileApprovalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const fileDenialName = fileDenyProbeNameForBackend("copilot-cli", FILE_PROBE_NAME_OPTIONS);
        const fileDenialPath = fileProbePath(fileDenialName, WORKDIR);
        if (fileDenialName && fileDenialPath) {
            const fileDenialPromptText = fileDenialProbePrompt(fileDenialName, FILE_DENY_CONTENT);
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
                onEvent: recordScenarioEvent(observedEvents, "fileDenialProbe"),
            });
            stepTrace.push("fileDenialProbe.session_created");
            const fileDenialAssistantMessage = await fileDenialSession.sendAndWait(
                { prompt: fileDenialPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileDenialProbe.turn_completed");
            await fileDenialSession.disconnect();
            stepTrace.push("fileDenialProbe.disconnected");
            fileDenialProbe = readApprovalProbeResult({
                path: fileDenialPath,
                prompt: fileDenialPromptText,
                assistantMessage: fileDenialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        if (RUN_TOOL_PROBE) {
            toolProbe = await runToolProbeWithClient(
                client2,
                observedEvents.toolProbe,
                stepTrace,
                "toolProbe"
            );
        }

        if (RUN_TOOL_FAILURE_PROBE) {
            toolFailureProbe = await runToolFailureProbeWithClient(
                client2,
                observedEvents.toolFailureProbe,
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
            observedEventTypes: summarizeScenarioEventTypes(observedEvents, history),
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
            observedEventTypes: summarizeScenarioEventTypes(observedEvents),
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
    const observedEvents = createScenarioEventBuckets();
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
            onEvent: recordScenarioEvent(observedEvents, "client1"),
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
            onEvent: recordScenarioEvent(observedEvents, "client2"),
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

        const approvalProbePath = approvalProbePathForBackend(
            "codex-adapter",
            APPROVAL_PROBE_PATH_OPTIONS
        );
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
                onEvent: recordScenarioEvent(observedEvents, "approvalProbe"),
            });
            stepTrace.push("approvalProbe.session_created");
            const approvalAssistantMessage = await approvalSession.sendAndWait(
                { prompt: approvalProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("approvalProbe.turn_completed");
            await approvalSession.disconnect();
            stepTrace.push("approvalProbe.disconnected");
            approvalProbe = readApprovalProbeResult({
                path: approvalProbePath,
                prompt: approvalProbePromptText,
                assistantMessage: approvalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const denialProbePath = denialProbePathForBackend(
            "codex-adapter",
            APPROVAL_PROBE_PATH_OPTIONS
        );
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
                onEvent: recordScenarioEvent(observedEvents, "denialProbe"),
            });
            stepTrace.push("denialProbe.session_created");
            const denialAssistantMessage = await denialSession.sendAndWait(
                { prompt: denialProbePromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("denialProbe.turn_completed");
            await denialSession.disconnect();
            stepTrace.push("denialProbe.disconnected");
            denialProbe = readApprovalProbeResult({
                path: denialProbePath,
                prompt: denialProbePromptText,
                assistantMessage: denialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const fileApprovalName = fileProbeNameForBackend("codex-adapter", FILE_PROBE_NAME_OPTIONS);
        const fileApprovalPath = fileProbePath(fileApprovalName, WORKDIR);
        if (fileApprovalName && fileApprovalPath) {
            const fileApprovalPromptText = fileApprovalProbePrompt(
                fileApprovalName,
                FILE_APPROVE_CONTENT
            );
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
                onEvent: recordScenarioEvent(observedEvents, "fileApprovalProbe"),
            });
            stepTrace.push("fileApprovalProbe.session_created");
            const fileApprovalAssistantMessage = await fileApprovalSession.sendAndWait(
                { prompt: fileApprovalPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileApprovalProbe.turn_completed");
            await fileApprovalSession.disconnect();
            stepTrace.push("fileApprovalProbe.disconnected");
            fileApprovalProbe = readApprovalProbeResult({
                path: fileApprovalPath,
                prompt: fileApprovalPromptText,
                assistantMessage: fileApprovalAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        const fileDenialName = fileDenyProbeNameForBackend(
            "codex-adapter",
            FILE_PROBE_NAME_OPTIONS
        );
        const fileDenialPath = fileProbePath(fileDenialName, WORKDIR);
        if (fileDenialName && fileDenialPath) {
            const fileDenialPromptText = fileDenialProbePrompt(fileDenialName, FILE_DENY_CONTENT);
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
                onEvent: recordScenarioEvent(observedEvents, "fileDenialProbe"),
            });
            stepTrace.push("fileDenialProbe.session_created");
            const fileDenialAssistantMessage = await fileDenialSession.sendAndWait(
                { prompt: fileDenialPromptText },
                PROTOCOL_TIMEOUT_MS
            );
            stepTrace.push("fileDenialProbe.turn_completed");
            await fileDenialSession.disconnect();
            stepTrace.push("fileDenialProbe.disconnected");
            fileDenialProbe = readApprovalProbeResult({
                path: fileDenialPath,
                prompt: fileDenialPromptText,
                assistantMessage: fileDenialAssistantMessage?.data.content,
                permissionRequests,
                permissionAssertionFailures,
                preExisting,
            });
        }

        if (RUN_TOOL_PROBE) {
            toolProbe = await runToolProbeWithClient(
                client2,
                observedEvents.toolProbe,
                stepTrace,
                "toolProbe"
            );
        }

        if (RUN_TOOL_FAILURE_PROBE) {
            toolFailureProbe = await runToolFailureProbeWithClient(
                client2,
                observedEvents.toolFailureProbe,
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
            observedEventTypes: summarizeScenarioEventTypes(observedEvents, history),
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
            observedEventTypes: summarizeScenarioEventTypes(observedEvents),
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
