export type ProofStatus = "pass" | "fail" | "not-run";

export type ProofAssertion = {
    name: string;
    status: ProofStatus;
    evidence: string;
};

export type ToolDescriptorLike = {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
};

export type DynamicToolLike = {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
};

export type ToolSchemaRoundTripItem = {
    toolName: string;
    status: ProofStatus;
    expectedDescription: string;
    observedDescription?: string;
    expectedInputSchema: Record<string, unknown>;
    observedInputSchema?: unknown;
    issues: string[];
};

export type ToolSchemaRoundTripReport = {
    status: ProofStatus;
    expectedToolCount: number;
    observedToolCount: number;
    items: ToolSchemaRoundTripItem[];
    assertions: ProofAssertion[];
};

export type ToolCallComplianceObservation = {
    backend: string;
    promptId: string;
    expectedToolName: string;
    sdkToolCalls: string[];
    nativeToolCalls?: string[];
    resultStatus?: "ok" | "error" | "timeout" | "not-run";
    evidence?: string;
};

export type ToolCallComplianceItem = ToolCallComplianceObservation & {
    status: ProofStatus;
    issues: string[];
};

export type ToolCallComplianceReport = {
    status: ProofStatus;
    observations: ToolCallComplianceItem[];
    backendAccuracy: Record<string, { passed: number; total: number; accuracy: number }>;
    assertions: ProofAssertion[];
};

const DEFAULT_EMPTY_TOOL_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

export function buildToolSchemaRoundTripReport(input: {
    expectedTools: ToolDescriptorLike[];
    observedDynamicTools: DynamicToolLike[];
}): ToolSchemaRoundTripReport {
    const observedByName = new Map<string, DynamicToolLike>();
    for (const tool of input.observedDynamicTools) {
        if (typeof tool.name === "string" && tool.name.length > 0) {
            observedByName.set(tool.name, tool);
        }
    }

    const items = input.expectedTools.map((tool) => {
        const observed = observedByName.get(tool.name);
        const expectedDescription = tool.description ?? `SDK tool ${tool.name}`;
        const expectedInputSchema = tool.parameters ?? DEFAULT_EMPTY_TOOL_SCHEMA;
        const issues: string[] = [];

        if (!observed) {
            issues.push("dynamic tool is missing");
        } else {
            if (observed.description !== expectedDescription) {
                issues.push("description mismatch");
            }
            if (!deepEqualJson(observed.inputSchema, expectedInputSchema)) {
                issues.push("inputSchema mismatch");
            }
        }

        return {
            toolName: tool.name,
            status: issues.length === 0 ? "pass" : "fail",
            expectedDescription,
            observedDescription:
                typeof observed?.description === "string" ? observed.description : undefined,
            expectedInputSchema,
            observedInputSchema: observed?.inputSchema,
            issues,
        } satisfies ToolSchemaRoundTripItem;
    });

    const unexpectedTools = input.observedDynamicTools
        .map((tool) => (typeof tool.name === "string" ? tool.name : "unknown"))
        .filter((name) => !input.expectedTools.some((tool) => tool.name === name));
    const assertions = [
        assertion(
            "all expected SDK tools are exposed as Codex dynamic tools",
            items.every((item) => !item.issues.includes("dynamic tool is missing")),
            `expected=${input.expectedTools.length} observed=${observedByName.size}`
        ),
        assertion(
            "all dynamic tool schemas round-trip without mutation",
            items.every((item) => item.status === "pass"),
            failedItemEvidence(items)
        ),
        assertion(
            "no unexpected dynamic tools appear in the observed tool set",
            unexpectedTools.length === 0,
            `unexpected=${unexpectedTools.join(",") || "none"}`
        ),
    ];

    return {
        status: assertions.every((item) => item.status === "pass") ? "pass" : "fail",
        expectedToolCount: input.expectedTools.length,
        observedToolCount: observedByName.size,
        items,
        assertions,
    };
}

export function buildToolCallComplianceReport(
    observations: ToolCallComplianceObservation[]
): ToolCallComplianceReport {
    if (observations.length === 0) {
        return {
            status: "not-run",
            observations: [],
            backendAccuracy: {},
            assertions: [
                {
                    name: "tool-call compliance benchmark produced observations",
                    status: "not-run",
                    evidence: "observations=0",
                },
            ],
        };
    }

    const items = observations.map((observation) => {
        const issues: string[] = [];
        if (observation.resultStatus === "not-run") {
            issues.push("observation not run");
        }
        if (observation.resultStatus === "error" || observation.resultStatus === "timeout") {
            issues.push(`result status ${observation.resultStatus}`);
        }
        if (!observation.sdkToolCalls.includes(observation.expectedToolName)) {
            issues.push("expected SDK tool was not called");
        }
        if ((observation.nativeToolCalls ?? []).length > 0) {
            issues.push("native tool was called");
        }
        return {
            ...observation,
            status: issues.length === 0 ? "pass" : "fail",
            issues,
        } satisfies ToolCallComplianceItem;
    });

    const backendAccuracy: ToolCallComplianceReport["backendAccuracy"] = {};
    for (const item of items) {
        const current = backendAccuracy[item.backend] ?? { passed: 0, total: 0, accuracy: 0 };
        current.total += 1;
        if (item.status === "pass") {
            current.passed += 1;
        }
        current.accuracy = current.total === 0 ? 0 : current.passed / current.total;
        backendAccuracy[item.backend] = current;
    }

    const assertions = [
        assertion(
            "every benchmark prompt selected its expected SDK tool",
            items.every((item) => item.sdkToolCalls.includes(item.expectedToolName)),
            failedItemEvidence(items)
        ),
        assertion(
            "no benchmark prompt used a native Codex tool",
            items.every((item) => (item.nativeToolCalls ?? []).length === 0),
            items
                .filter((item) => (item.nativeToolCalls ?? []).length > 0)
                .map(
                    (item) => `${item.backend}/${item.promptId}:${item.nativeToolCalls?.join(",")}`
                )
                .join(";") || "nativeToolCalls=none"
        ),
        assertion(
            "all benchmark observations completed without runtime errors",
            items.every((item) => item.resultStatus === undefined || item.resultStatus === "ok"),
            items
                .filter((item) => item.resultStatus && item.resultStatus !== "ok")
                .map((item) => `${item.backend}/${item.promptId}:${item.resultStatus}`)
                .join(";") || "runtimeErrors=none"
        ),
    ];

    return {
        status: items.every((item) => item.status === "pass") ? "pass" : "fail",
        observations: items,
        backendAccuracy,
        assertions,
    };
}

function assertion(name: string, condition: boolean, evidence: string): ProofAssertion {
    return {
        name,
        status: condition ? "pass" : "fail",
        evidence,
    };
}

function failedItemEvidence(
    items: Array<{ toolName?: string; promptId?: string; issues: string[] }>
): string {
    const failures = items.filter((item) => item.issues.length > 0);
    if (failures.length === 0) {
        return "failures=none";
    }
    return failures
        .map((item) => `${item.toolName ?? item.promptId ?? "item"}:${item.issues.join("|")}`)
        .join(";");
}

function deepEqualJson(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => deepEqualJson(item, right[index]));
    }
    if (isRecord(left) || isRecord(right)) {
        if (!isRecord(left) || !isRecord(right)) {
            return false;
        }
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        if (!deepEqualJson(leftKeys, rightKeys)) {
            return false;
        }
        return leftKeys.every((key) => deepEqualJson(left[key], right[key]));
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
