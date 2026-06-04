function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

export type ToolDescriptor = {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    skipPermission?: boolean;
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

export function mapPermissionResultToCodexCommandDecision(
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
    const kind =
        isRecord(permissionResult) && typeof permissionResult.kind === "string"
            ? permissionResult.kind
            : null;
    if (kind !== "approved") {
        return "decline";
    }
    return "accept";
}
