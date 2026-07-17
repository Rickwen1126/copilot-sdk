import { describe, expect, it } from "vitest";
import {
    createDenyRuntimeFactTool,
    createFailRuntimeFactTool,
    createLookupRuntimeFactTool,
    toolDeniedPrompt,
    toolFailurePrompt,
    toolProbePrompt,
    validateToolHandlerCall,
    type ToolHandlerCall,
    type ToolProbeToolConfig,
} from "../conformance/codexConformanceToolFactory.js";

const config: ToolProbeToolConfig = {
    topic: "codex-adapter",
    lookupToolName: "lookup_runtime_fact",
    lookupResult: "CUSTOM_TOOL_BRIDGE_OK_7F3A",
    failureToolName: "fail_runtime_fact",
    failureError: "CUSTOM_TOOL_FAILURE_EXPECTED_8C2B",
    deniedToolName: "deny_runtime_fact",
    deniedResult: "CUSTOM_TOOL_DENIED_EXPECTED_4D91",
};

const lookupInvocation = {
    toolName: config.lookupToolName,
    toolCallId: "tool-call-1",
    sessionId: "session-1",
    arguments: { topic: config.topic },
};

describe("Codex conformance tool factory helpers", () => {
    it("renders deterministic custom tool prompts", () => {
        expect(toolProbePrompt(config)).toContain(config.lookupToolName);
        expect(toolProbePrompt(config)).toContain(config.topic);
        expect(toolFailurePrompt(config)).toContain(config.failureToolName);
        expect(toolDeniedPrompt(config)).toContain(config.deniedToolName);
    });

    it("validates tool handler invocation metadata", () => {
        expect(validateToolHandlerCall({ topic: config.topic }, lookupInvocation, config)).toEqual(
            []
        );
        expect(validateToolHandlerCall({ topic: "wrong" }, lookupInvocation, config)).toContain(
            "tool args.topic is wrong, expected codex-adapter"
        );
        expect(
            validateToolHandlerCall(
                { topic: config.topic },
                { ...lookupInvocation, toolCallId: "" },
                config
            )
        ).toContain("tool invocation.toolCallId is missing");
    });

    it("creates a lookup tool that records successful handler calls", async () => {
        const handlerCalls: ToolHandlerCall[] = [];
        const assertionFailures: string[] = [];
        const tool = createLookupRuntimeFactTool({ config, handlerCalls, assertionFailures });

        expect(tool.handler({ topic: config.topic }, lookupInvocation)).toBe(config.lookupResult);
        expect(tool).toMatchObject({
            name: config.lookupToolName,
            skipPermission: true,
        });
        expect(handlerCalls).toEqual([
            {
                args: { topic: config.topic },
                invocation: lookupInvocation,
                result: config.lookupResult,
                error: undefined,
            },
        ]);
        expect(assertionFailures).toEqual([]);
    });

    it("records assertion failures and throws when lookup invocation is malformed", async () => {
        const handlerCalls: ToolHandlerCall[] = [];
        const assertionFailures: string[] = [];
        const tool = createLookupRuntimeFactTool({ config, handlerCalls, assertionFailures });

        expect(() => tool.handler({ topic: "wrong" }, lookupInvocation)).toThrow(
            "tool args.topic is wrong"
        );
        expect(handlerCalls[0]?.error).toContain("tool args.topic is wrong");
        expect(assertionFailures).toEqual(["tool args.topic is wrong, expected codex-adapter"]);
    });

    it("creates failure and denied tools with deterministic outcomes", async () => {
        const failureCalls: ToolHandlerCall[] = [];
        const deniedCalls: ToolHandlerCall[] = [];
        const assertionFailures: string[] = [];
        const failureTool = createFailRuntimeFactTool({
            config,
            handlerCalls: failureCalls,
            assertionFailures,
        });
        const deniedTool = createDenyRuntimeFactTool({
            config,
            handlerCalls: deniedCalls,
            assertionFailures,
        });

        expect(() =>
            failureTool.handler(
                { topic: config.topic },
                {
                    ...lookupInvocation,
                    toolName: config.failureToolName,
                }
            )
        ).toThrow(config.failureError);
        expect(
            deniedTool.handler(
                { topic: config.topic },
                {
                    ...lookupInvocation,
                    toolName: config.deniedToolName,
                }
            )
        ).toMatchObject({
            textResultForLlm: config.deniedResult,
            resultType: "denied",
            error: config.deniedResult,
        });
        expect(failureCalls[0]?.error).toBe(config.failureError);
        expect(deniedCalls[0]?.result).toBe(config.deniedResult);
        expect(assertionFailures).toEqual([]);
    });
});
