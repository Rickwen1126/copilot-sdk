import { describe, expect, it } from "vitest";
import {
    customToolProbeDataPass,
    customToolProbeFinalMessageUsesResult,
    customToolProbeHandlerCallSummary,
    customToolProbeIntentPass,
    toolFailureHandlerCallSummary,
    toolFailureProbeDataPass,
    toolFailureProbeIntentPass,
} from "../conformance/codexConformanceToolProbe.js";

const customExpectation = {
    topic: "codex-adapter",
    toolName: "lookup_runtime_fact",
    expectedResult: "CUSTOM_TOOL_BRIDGE_OK_7F3A",
};

const failureExpectation = {
    topic: "codex-adapter",
    failureToolName: "fail_runtime_fact",
    deniedToolName: "deny_runtime_fact",
    expectedFailureError: "CUSTOM_TOOL_FAILURE_EXPECTED_8C2B",
    expectedDeniedResult: "CUSTOM_TOOL_DENIED_EXPECTED_4D91",
};

describe("Codex conformance tool probe helpers", () => {
    it("passes custom tool probes only when handler and assistant evidence match", () => {
        const probe = {
            expectedResult: customExpectation.expectedResult,
            assistantMessage: customExpectation.expectedResult,
            assertionFailures: [],
            handlerCalls: [
                {
                    args: { topic: customExpectation.topic },
                    invocation: {
                        toolName: customExpectation.toolName,
                        toolCallId: "tool-call-1",
                    },
                    result: customExpectation.expectedResult,
                },
            ],
        };

        expect(customToolProbeDataPass(probe, customExpectation)).toBe(true);
        expect(customToolProbeIntentPass(probe, customExpectation)).toBe(true);
        expect(customToolProbeFinalMessageUsesResult(probe, customExpectation)).toBe(true);
        expect(customToolProbeHandlerCallSummary(probe)).toContain("toolName=lookup_runtime_fact");
    });

    it("fails custom tool probes when handler evidence is missing or mutated", () => {
        expect(customToolProbeDataPass(undefined, customExpectation)).toBe(false);
        expect(
            customToolProbeDataPass(
                {
                    expectedResult: customExpectation.expectedResult,
                    assertionFailures: [],
                    handlerCalls: [
                        {
                            args: { topic: "wrong-topic" },
                            invocation: {
                                toolName: customExpectation.toolName,
                                toolCallId: "tool-call-1",
                            },
                            result: customExpectation.expectedResult,
                        },
                    ],
                },
                customExpectation
            )
        ).toBe(false);
        expect(
            customToolProbeIntentPass(
                {
                    expectedResult: customExpectation.expectedResult,
                    assistantMessage: "   ",
                    assertionFailures: [],
                    handlerCalls: [
                        {
                            args: { topic: customExpectation.topic },
                            invocation: {
                                toolName: customExpectation.toolName,
                                toolCallId: "tool-call-1",
                            },
                            result: customExpectation.expectedResult,
                        },
                    ],
                },
                customExpectation
            )
        ).toBe(false);
    });

    it("passes tool failure probes only when failure and denied calls both match", () => {
        const probe = {
            expectedFailureError: failureExpectation.expectedFailureError,
            expectedDeniedResult: failureExpectation.expectedDeniedResult,
            failureAssistantMessage: "The tool failed.",
            deniedAssistantMessage: "The tool was denied.",
            assertionFailures: [],
            failureHandlerCalls: [
                {
                    args: { topic: failureExpectation.topic },
                    invocation: {
                        toolName: failureExpectation.failureToolName,
                        toolCallId: "failure-call",
                    },
                    error: failureExpectation.expectedFailureError,
                },
            ],
            deniedHandlerCalls: [
                {
                    args: { topic: failureExpectation.topic },
                    invocation: {
                        toolName: failureExpectation.deniedToolName,
                        toolCallId: "denied-call",
                    },
                    result: failureExpectation.expectedDeniedResult,
                },
            ],
        };

        expect(toolFailureProbeDataPass(probe, failureExpectation)).toBe(true);
        expect(toolFailureProbeIntentPass(probe, failureExpectation)).toBe(true);
        expect(toolFailureHandlerCallSummary(probe, "failureHandlerCalls")).toContain(
            "toolName=fail_runtime_fact"
        );
        expect(toolFailureHandlerCallSummary(probe, "failureHandlerCalls")).toContain("errorHash=");
    });

    it("fails tool failure probes when one of the paired calls is absent or has failures", () => {
        expect(
            toolFailureProbeDataPass(
                {
                    expectedFailureError: failureExpectation.expectedFailureError,
                    expectedDeniedResult: failureExpectation.expectedDeniedResult,
                    failureAssistantMessage: "The tool failed.",
                    deniedAssistantMessage: "The tool was denied.",
                    assertionFailures: ["handler mismatch"],
                    failureHandlerCalls: [],
                    deniedHandlerCalls: [],
                },
                failureExpectation
            )
        ).toBe(false);
        expect(
            toolFailureProbeIntentPass(
                {
                    expectedFailureError: failureExpectation.expectedFailureError,
                    expectedDeniedResult: failureExpectation.expectedDeniedResult,
                    failureAssistantMessage: "The tool failed.",
                    deniedAssistantMessage: "",
                    assertionFailures: [],
                    failureHandlerCalls: [
                        {
                            args: { topic: failureExpectation.topic },
                            invocation: {
                                toolName: failureExpectation.failureToolName,
                                toolCallId: "failure-call",
                            },
                            error: failureExpectation.expectedFailureError,
                        },
                    ],
                    deniedHandlerCalls: [
                        {
                            args: { topic: failureExpectation.topic },
                            invocation: {
                                toolName: failureExpectation.deniedToolName,
                                toolCallId: "denied-call",
                            },
                            result: failureExpectation.expectedDeniedResult,
                        },
                    ],
                },
                failureExpectation
            )
        ).toBe(false);
    });
});
