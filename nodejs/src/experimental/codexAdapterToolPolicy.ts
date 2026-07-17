export type CodexAdapterProtocolVersion = 2 | 3;

export type DynamicToolCallRoutingInput = {
    protocolVersion: CodexAdapterProtocolVersion;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argumentsPayload: unknown;
};

export type DynamicToolCallRoutingPlan =
    | {
          mode: "protocol-v2-sdk-request";
          toolCallParams: {
              sessionId: string;
              toolCallId: string;
              toolName: string;
              arguments: unknown;
          };
      }
    | {
          mode: "protocol-v3-session-event";
          sdkRequestId: string;
          eventData: {
              requestId: string;
              sessionId: string;
              toolCallId: string;
              toolName: string;
              arguments: unknown;
          };
          ephemeral: true;
      };

export function planDynamicToolCallRouting(
    input: DynamicToolCallRoutingInput
): DynamicToolCallRoutingPlan {
    if (input.protocolVersion === 2) {
        return {
            mode: "protocol-v2-sdk-request",
            toolCallParams: {
                sessionId: input.sessionId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                arguments: input.argumentsPayload,
            },
        };
    }

    const sdkRequestId = `codex-dynamic-tool:${input.toolCallId}`;
    return {
        mode: "protocol-v3-session-event",
        sdkRequestId,
        eventData: {
            requestId: sdkRequestId,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            arguments: input.argumentsPayload,
        },
        ephemeral: true,
    };
}
