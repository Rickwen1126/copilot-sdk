import { createHash } from "node:crypto";

export type CustomToolProbeExpectation = {
    topic: string;
    toolName: string;
    expectedResult: string;
};

export type ToolFailureProbeExpectation = {
    topic: string;
    failureToolName: string;
    deniedToolName: string;
    expectedFailureError: string;
    expectedDeniedResult: string;
};

export function customToolProbeDataPass(
    probe: Record<string, unknown> | undefined,
    expectation: CustomToolProbeExpectation
): boolean {
    if (!probe) {
        return false;
    }
    const handlerCalls = recordArray(probe.handlerCalls);
    const assertionFailures = stringArray(probe.assertionFailures);
    const firstHandlerCall = isRecord(handlerCalls[0]) ? handlerCalls[0] : undefined;
    const args = isRecord(firstHandlerCall?.args) ? firstHandlerCall.args : {};
    const invocation = isRecord(firstHandlerCall?.invocation) ? firstHandlerCall.invocation : {};

    return (
        handlerCalls.length === 1 &&
        assertionFailures.length === 0 &&
        stringField(probe, "expectedResult") === expectation.expectedResult &&
        args.topic === expectation.topic &&
        invocation.toolName === expectation.toolName &&
        typeof invocation.toolCallId === "string" &&
        invocation.toolCallId.length > 0 &&
        firstHandlerCall?.result === expectation.expectedResult
    );
}

export function customToolProbeIntentPass(
    probe: Record<string, unknown> | undefined,
    expectation: CustomToolProbeExpectation
): boolean {
    const assistantMessage = stringField(probe, "assistantMessage");
    return (
        customToolProbeDataPass(probe, expectation) &&
        !!assistantMessage &&
        assistantMessage.trim().length > 0
    );
}

export function customToolProbeFinalMessageUsesResult(
    probe: Record<string, unknown> | undefined,
    expectation: CustomToolProbeExpectation
): boolean {
    return (stringField(probe, "assistantMessage") ?? "").includes(expectation.expectedResult);
}

export function customToolProbeHandlerCallSummary(
    probe: Record<string, unknown> | undefined
): string {
    return handlerCallSummary(probe, "handlerCalls", "raw-error");
}

export function toolFailureProbeDataPass(
    probe: Record<string, unknown> | undefined,
    expectation: ToolFailureProbeExpectation
): boolean {
    if (!probe) {
        return false;
    }
    const failureHandlerCalls = recordArray(probe.failureHandlerCalls);
    const deniedHandlerCalls = recordArray(probe.deniedHandlerCalls);
    const assertionFailures = stringArray(probe.assertionFailures);

    return (
        failureHandlerCalls.length === 1 &&
        deniedHandlerCalls.length === 1 &&
        assertionFailures.length === 0 &&
        stringField(probe, "expectedFailureError") === expectation.expectedFailureError &&
        stringField(probe, "expectedDeniedResult") === expectation.expectedDeniedResult &&
        probeHandlerCallMatches(
            firstProbeHandlerCall(probe, "failureHandlerCalls"),
            expectation.topic,
            expectation.failureToolName,
            "error",
            expectation.expectedFailureError
        ) &&
        probeHandlerCallMatches(
            firstProbeHandlerCall(probe, "deniedHandlerCalls"),
            expectation.topic,
            expectation.deniedToolName,
            "result",
            expectation.expectedDeniedResult
        )
    );
}

export function toolFailureProbeIntentPass(
    probe: Record<string, unknown> | undefined,
    expectation: ToolFailureProbeExpectation
): boolean {
    const failureAssistantMessage = stringField(probe, "failureAssistantMessage");
    const deniedAssistantMessage = stringField(probe, "deniedAssistantMessage");
    return (
        toolFailureProbeDataPass(probe, expectation) &&
        !!failureAssistantMessage &&
        failureAssistantMessage.trim().length > 0 &&
        !!deniedAssistantMessage &&
        deniedAssistantMessage.trim().length > 0
    );
}

export function toolFailureHandlerCallSummary(
    probe: Record<string, unknown> | undefined,
    key: string
): string {
    return handlerCallSummary(probe, key, "hash-error");
}

function firstProbeHandlerCall(
    probe: Record<string, unknown> | undefined,
    key: string
): Record<string, unknown> | undefined {
    const first = recordArray(probe?.[key])[0];
    return isRecord(first) ? first : undefined;
}

function probeHandlerCallMatches(
    call: Record<string, unknown> | undefined,
    expectedTopic: string,
    expectedToolName: string,
    expectedField: "result" | "error",
    expectedValue: string
): boolean {
    if (!call) {
        return false;
    }
    const args = isRecord(call.args) ? call.args : {};
    const invocation = isRecord(call.invocation) ? call.invocation : {};
    return (
        args.topic === expectedTopic &&
        invocation.toolName === expectedToolName &&
        typeof invocation.toolCallId === "string" &&
        invocation.toolCallId.length > 0 &&
        call[expectedField] === expectedValue
    );
}

function handlerCallSummary(
    probe: Record<string, unknown> | undefined,
    key: string,
    errorMode: "raw-error" | "hash-error"
): string {
    return recordArray(probe?.[key])
        .map((call) => {
            if (!isRecord(call)) {
                return "invalid";
            }
            const args = isRecord(call.args) ? call.args : {};
            const invocation = isRecord(call.invocation) ? call.invocation : {};
            const error =
                typeof call.error === "string"
                    ? errorMode === "hash-error"
                        ? hashString(call.error)
                        : call.error
                    : "";
            const errorKey = errorMode === "hash-error" ? "errorHash" : "error";

            return [
                `topic=${String(args.topic ?? "")}`,
                `toolName=${String(invocation.toolName ?? "")}`,
                `toolCallId=${String(invocation.toolCallId ?? "")}`,
                `resultHash=${typeof call.result === "string" ? hashString(call.result) : ""}`,
                `${errorKey}=${error}`,
            ].join(";");
        })
        .join("|");
}

function recordArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
    if (!record) {
        return undefined;
    }
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
