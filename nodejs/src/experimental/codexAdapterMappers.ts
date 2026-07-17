function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

export type ToolDescriptor = {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    skipPermission?: boolean;
    /**
     * Opaque host-defined metadata bag from the v1.0.7 tool definition
     * (`Tool.metadata`, sent on session.create/resume). Preserved and
     * round-tripped untouched; deliberately excluded from the tool
     * fingerprint so metadata-only changes do not reject a resume.
     */
    metadata?: Record<string, unknown>;
};

export type CodexAdapterSandboxMode =
    | "dangerFullAccess"
    | "danger-full-access"
    | "readOnly"
    | "read-only"
    | "workspaceWrite"
    | "workspace-write";

export function toolDescriptorsFromSessionCreateParams(params: unknown): ToolDescriptor[] {
    if (!isRecord(params) || !Array.isArray(params.tools)) {
        return [];
    }

    return params.tools.filter(isRecord).map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : "unknown_tool",
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isRecord(tool.parameters) ? tool.parameters : undefined,
        skipPermission: tool.skipPermission === true,
        metadata: isRecord(tool.metadata) ? tool.metadata : undefined,
    }));
}

export function dynamicToolsFromDescriptors(tools: ToolDescriptor[]): Record<string, unknown>[] {
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

export function mapSdkToolResultToCodexDynamicToolResponse(
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
                : "Tool completed without textResultForLlm.";
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

export function mapCodexModels(result: unknown) {
    const data =
        isRecord(result) && "data" in result && Array.isArray(result.data) ? result.data : [];

    return data.filter(isRecord).map((entry) => {
        const inputModalities = Array.isArray(entry.inputModalities)
            ? entry.inputModalities.filter((item): item is string => typeof item === "string")
            : [];
        const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
            ? entry.supportedReasoningEfforts
                  .map((item) =>
                      isRecord(item) && typeof item.reasoningEffort === "string"
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

export function normalizedSandboxMode(
    mode: CodexAdapterSandboxMode
): "dangerFullAccess" | "readOnly" | "workspaceWrite" {
    if (mode === "danger-full-access" || mode === "dangerFullAccess") {
        return "dangerFullAccess";
    }
    if (mode === "workspace-write" || mode === "workspaceWrite") {
        return "workspaceWrite";
    }
    return "readOnly";
}

export function codexThreadSandboxMode(
    mode: CodexAdapterSandboxMode
): "danger-full-access" | "read-only" | "workspace-write" {
    const normalized = normalizedSandboxMode(mode);
    if (normalized === "dangerFullAccess") {
        return "danger-full-access";
    }
    if (normalized === "workspaceWrite") {
        return "workspace-write";
    }
    return "read-only";
}

export function codexSandboxPolicy(
    mode: CodexAdapterSandboxMode,
    networkAccess: boolean
): Record<string, unknown> {
    const normalized = normalizedSandboxMode(mode);
    if (normalized === "dangerFullAccess") {
        return {
            type: "dangerFullAccess",
        };
    }

    if (normalized === "workspaceWrite") {
        return {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        };
    }

    return {
        type: "readOnly",
        networkAccess,
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

export function mapCodexCommandApprovalToPermissionRequest(
    params: unknown
): Record<string, unknown> {
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

/**
 * Approve-family `PermissionDecision.kind` literals from the v1.0.7 generated
 * RPC schema (`PermissionDecisionApprove*` / legacy `PermissionDecisionApproved*`).
 * Every other kind (reject / cancelled / user-not-available / denied-*) maps
 * to a Codex decline.
 */
const APPROVED_PERMISSION_KINDS = new Set([
    "approve-once",
    "approve-for-session",
    "approve-for-location",
    "approve-permanently",
    "approved",
    "approved-for-session",
    "approved-for-location",
]);

function isApprovedPermissionKind(permissionResult: unknown): boolean {
    return (
        isRecord(permissionResult) &&
        typeof permissionResult.kind === "string" &&
        APPROVED_PERMISSION_KINDS.has(permissionResult.kind)
    );
}

export function mapPermissionResultToCodexCommandDecision(
    permissionResult: unknown,
    requestParams: unknown
): unknown {
    if (!isApprovedPermissionKind(permissionResult)) {
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

export function extractFileChangesFromParams(params: unknown): unknown[] {
    if (!isRecord(params)) {
        return [];
    }
    if (Array.isArray(params.changes)) {
        return params.changes;
    }
    const item = isRecord(params.item) ? params.item : undefined;
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

export function mapCodexFileChangeApprovalToPermissionRequest(
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

export function mapPermissionResultToCodexFileChangeDecision(permissionResult: unknown): unknown {
    if (!isApprovedPermissionKind(permissionResult)) {
        return "decline";
    }
    return "accept";
}

// ---------------------------------------------------------------------------
// Codex notification -> SDK session-event mappers (v1.0.7 coverage expansion).
// Field mappings are anchored to captured codex app-server payloads
// (codex-cli 0.144.5) on one side and nodejs/src/generated/session-events.ts
// on the other; see the per-mapper notes.
// ---------------------------------------------------------------------------

/**
 * `item/agentMessage/delta` {threadId, turnId, itemId, delta} ->
 * `assistant.message_delta` data. Captured deltas carry the same `itemId` as
 * the eventual `item/completed` agentMessage `item.id`, so `messageId`
 * correlates with the adapter's assistant.message event.
 */
export function mapCodexAgentMessageDelta(
    params: Record<string, unknown>
): { deltaContent: string; messageId: string } | null {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") {
        return null;
    }
    return { deltaContent: params.delta, messageId: params.itemId };
}

/** `item/started` agentMessage item -> `assistant.message_start` data. */
export function mapCodexAgentMessageStart(
    item: Record<string, unknown>
): { messageId: string; phase?: string } {
    return {
        messageId: typeof item.id === "string" ? item.id : `assistant-${item.id ?? "unknown"}`,
        phase: typeof item.phase === "string" ? item.phase : undefined,
    };
}

function collectTextEntries(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const texts: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            if (entry.length > 0) {
                texts.push(entry);
            }
        } else if (isRecord(entry) && typeof entry.text === "string" && entry.text.length > 0) {
            texts.push(entry.text);
        }
    }
    return texts;
}

/**
 * `item/completed` reasoning item {id, summary: [], content: []} ->
 * `assistant.reasoning` data {content, reasoningId}. Captured reasoning items
 * had empty summary/content arrays; entry extraction tolerates both raw
 * strings and `{text}` records (the shape codex uses for userMessage content).
 *
 * `extractionMiss` is true when the source arrays are non-empty but no text
 * could be extracted — the payload uses a shape this extractor does not
 * understand. Callers must surface that loudly instead of shipping a silently
 * empty reasoning event.
 */
export function mapCodexReasoningItem(item: Record<string, unknown>): {
    content: string;
    reasoningId: string;
    extractionMiss: boolean;
} {
    const texts = [...collectTextEntries(item.summary), ...collectTextEntries(item.content)];
    const sourceEntryCount =
        (Array.isArray(item.summary) ? item.summary.length : 0) +
        (Array.isArray(item.content) ? item.content.length : 0);
    return {
        content: texts.join("\n\n"),
        reasoningId: typeof item.id === "string" ? item.id : "reasoning-unknown",
        extractionMiss: sourceEntryCount > 0 && texts.length === 0,
    };
}

/**
 * `item/started` commandExecution item -> `tool.execution_start` data.
 * Captured item shape: {type, id, command, cwd, processId, source, status,
 * commandActions, aggregatedOutput, exitCode, durationMs}. `toolName` is an
 * adapter-chosen label ("shell"): codex does not carry an SDK tool name.
 */
export function mapCodexCommandExecutionStart(
    item: Record<string, unknown>,
    turnId: string | undefined
): Record<string, unknown> {
    const command = typeof item.command === "string" ? item.command : "";
    return {
        toolCallId: typeof item.id === "string" ? item.id : "command-unknown",
        toolName: "shell",
        arguments: {
            command,
            cwd: typeof item.cwd === "string" ? item.cwd : undefined,
        },
        shellToolInfo: {
            hasWriteFileRedirection: />{1,2}/.test(command),
            possiblePaths: [],
        },
        turnId,
    };
}

/** `item/completed` commandExecution item -> `tool.execution_complete` data. */
export function mapCodexCommandExecutionComplete(
    item: Record<string, unknown>
): Record<string, unknown> {
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    const status = typeof item.status === "string" ? item.status : "completed";
    const success = status === "completed" && (exitCode === null || exitCode === 0);
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    return {
        toolCallId: typeof item.id === "string" ? item.id : "command-unknown",
        success,
        ...(success
            ? { result: { content: output } }
            : {
                  error: {
                      message:
                          output.length > 0
                              ? output
                              : `command ${status}${exitCode !== null ? ` (exit ${exitCode})` : ""}`,
                  },
              }),
    };
}

type CodexFileChange = {
    path: string;
    kindType: string | undefined;
    diff: string | undefined;
};

function parseCodexFileChanges(item: Record<string, unknown>): CodexFileChange[] {
    if (!Array.isArray(item.changes)) {
        return [];
    }
    return item.changes.filter(isRecord).flatMap((change) => {
        if (typeof change.path !== "string") {
            return [];
        }
        return [
            {
                path: change.path,
                kindType:
                    isRecord(change.kind) && typeof change.kind.type === "string"
                        ? change.kind.type
                        : undefined,
                diff: typeof change.diff === "string" ? change.diff : undefined,
            },
        ];
    });
}

/**
 * `item/started` fileChange item -> `tool.execution_start` data.
 * Captured change shape: {path, kind: {type: "add"|"update", move_path?}, diff}.
 */
export function mapCodexFileChangeStart(
    item: Record<string, unknown>,
    turnId: string | undefined
): Record<string, unknown> {
    const changes = parseCodexFileChanges(item);
    return {
        toolCallId: typeof item.id === "string" ? item.id : "filechange-unknown",
        toolName: "apply_patch",
        arguments: {
            paths: changes.map((change) => change.path),
        },
        turnId,
    };
}

/**
 * `item/completed` fileChange item -> `tool.execution_complete` data plus one
 * `session.workspace_file_changed` payload per add/update change (the
 * generated WorkspaceFileChangedOperation enum only has create|update; other
 * kinds are reported through the tool result only).
 */
export function mapCodexFileChangeComplete(item: Record<string, unknown>): {
    toolExecution: Record<string, unknown>;
    workspaceChanges: Array<{ operation: "create" | "update"; path: string }>;
} {
    const changes = parseCodexFileChanges(item);
    const status = typeof item.status === "string" ? item.status : "completed";
    const success = status === "completed";
    const diffText = changes
        .map((change) => change.diff)
        .filter((diff): diff is string => !!diff)
        .join("\n");
    const summary = changes
        .map((change) => `${change.kindType ?? "update"} ${change.path}`)
        .join("\n");
    return {
        toolExecution: {
            toolCallId: typeof item.id === "string" ? item.id : "filechange-unknown",
            success,
            ...(success
                ? {
                      result: {
                          content: summary,
                          ...(diffText.length > 0 ? { detailedContent: diffText } : {}),
                      },
                  }
                : { error: { message: `file change ${status}` } }),
        },
        workspaceChanges: success
            ? changes
                  .filter((change) => change.kindType === "add" || change.kindType === "update")
                  .map((change) => ({
                      operation: change.kindType === "add" ? ("create" as const) : ("update" as const),
                      path: change.path,
                  }))
            : [],
    };
}

/**
 * `thread/tokenUsage/updated` {tokenUsage: {last: {...}}} -> `assistant.usage`
 * data. Uses the `last` bucket (per-API-call semantics, matching
 * assistant.usage) and maps cachedInputTokens -> cacheReadTokens,
 * reasoningOutputTokens -> reasoningTokens. `model` is required by
 * AssistantUsageData and must be supplied by the adapter session.
 */
export function mapCodexTokenUsage(
    params: Record<string, unknown>,
    model: string
): Record<string, unknown> | null {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
    const last = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : undefined;
    if (!last) {
        return null;
    }
    const num = (value: unknown) => (typeof value === "number" ? value : undefined);
    return {
        model,
        inputTokens: num(last.inputTokens),
        outputTokens: num(last.outputTokens),
        cacheReadTokens: num(last.cachedInputTokens),
        reasoningTokens: num(last.reasoningOutputTokens),
    };
}
