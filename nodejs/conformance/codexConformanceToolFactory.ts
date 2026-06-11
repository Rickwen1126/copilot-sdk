import { defineTool } from "../dist/index.js";

export type ToolHandlerCall = {
    args: unknown;
    invocation: unknown;
    result?: string;
    error?: string;
};

export type ToolProbeToolConfig = {
    topic: string;
    lookupToolName: string;
    lookupResult: string;
    failureToolName: string;
    failureError: string;
    deniedToolName: string;
    deniedResult: string;
};

export function toolProbePrompt(config: ToolProbeToolConfig): string {
    return [
        `Call the custom tool ${config.lookupToolName} exactly once with topic "${config.topic}".`,
        "The tool returns a copy-sensitive token.",
        "After the tool returns, reply with the exact token and no extra prose.",
        "Do not transform casing, punctuation, spacing, or word order.",
    ].join("\n");
}

export function toolFailurePrompt(config: ToolProbeToolConfig): string {
    return [
        `Call the custom tool ${config.failureToolName} exactly once with topic "${config.topic}".`,
        "This tool is expected to fail.",
        "After the failure is reported, acknowledge that the tool failed.",
        "Do not retry and do not call any other tool.",
    ].join("\n");
}

export function toolDeniedPrompt(config: ToolProbeToolConfig): string {
    return [
        `Call the custom tool ${config.deniedToolName} exactly once with topic "${config.topic}".`,
        "This tool is expected to return a denied result.",
        "After the denial is reported, acknowledge that the tool was denied.",
        "Do not retry and do not call any other tool.",
    ].join("\n");
}

export function validateToolHandlerCall(
    args: unknown,
    invocation: unknown,
    config: ToolProbeToolConfig,
    expectedToolName = config.lookupToolName
): string[] {
    const failures: string[] = [];
    if (!isRecord(args)) {
        failures.push("tool args are not an object");
    } else if (args.topic !== config.topic) {
        failures.push(`tool args.topic is ${String(args.topic)}, expected ${config.topic}`);
    }

    if (!isRecord(invocation)) {
        failures.push("tool invocation metadata is not an object");
    } else {
        if (invocation.toolName !== expectedToolName) {
            failures.push(
                `tool invocation.toolName is ${String(invocation.toolName)}, expected ${expectedToolName}`
            );
        }
        if (typeof invocation.toolCallId !== "string" || invocation.toolCallId.length === 0) {
            failures.push("tool invocation.toolCallId is missing");
        }
        if (typeof invocation.sessionId !== "string" || invocation.sessionId.length === 0) {
            failures.push("tool invocation.sessionId is missing");
        }
    }

    return failures;
}

export function createLookupRuntimeFactTool(input: {
    config: ToolProbeToolConfig;
    handlerCalls: ToolHandlerCall[];
    assertionFailures: string[];
}) {
    return defineTool(input.config.lookupToolName, {
        description: "Returns a deterministic copy-sensitive token for conformance testing.",
        parameters: toolParameters(input.config.topic),
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(args, invocation, input.config);
            input.assertionFailures.push(...failures);
            const call: ToolHandlerCall = {
                args,
                invocation,
                result: failures.length === 0 ? input.config.lookupResult : undefined,
                error: failures.length > 0 ? failures.join("; ") : undefined,
            };
            input.handlerCalls.push(call);
            if (failures.length > 0) {
                throw new Error(failures.join("; "));
            }
            return input.config.lookupResult;
        },
    });
}

export function createFailRuntimeFactTool(input: {
    config: ToolProbeToolConfig;
    handlerCalls: ToolHandlerCall[];
    assertionFailures: string[];
}) {
    return defineTool(input.config.failureToolName, {
        description: "Always throws a deterministic error for conformance testing.",
        parameters: toolParameters(input.config.topic),
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(
                args,
                invocation,
                input.config,
                input.config.failureToolName
            );
            input.assertionFailures.push(...failures);
            const error = failures.length > 0 ? failures.join("; ") : input.config.failureError;
            input.handlerCalls.push({
                args,
                invocation,
                error,
            });
            throw new Error(error);
        },
    });
}

export function createDenyRuntimeFactTool(input: {
    config: ToolProbeToolConfig;
    handlerCalls: ToolHandlerCall[];
    assertionFailures: string[];
}) {
    return defineTool(input.config.deniedToolName, {
        description: "Returns a deterministic denied tool result for conformance testing.",
        parameters: toolParameters(input.config.topic),
        skipPermission: true,
        handler: (args: unknown, invocation: unknown) => {
            const failures = validateToolHandlerCall(
                args,
                invocation,
                input.config,
                input.config.deniedToolName
            );
            input.assertionFailures.push(...failures);
            const result = failures.length > 0 ? failures.join("; ") : input.config.deniedResult;
            input.handlerCalls.push({
                args,
                invocation,
                result,
                error: failures.length > 0 ? failures.join("; ") : undefined,
            });
            if (failures.length > 0) {
                throw new Error(failures.join("; "));
            }
            return {
                textResultForLlm: result,
                resultType: "denied",
                error: result,
            };
        },
    });
}

function toolParameters(topic: string): Record<string, unknown> {
    return {
        type: "object",
        properties: {
            topic: {
                type: "string",
                description: `Must be "${topic}".`,
            },
        },
        required: ["topic"],
        additionalProperties: false,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
