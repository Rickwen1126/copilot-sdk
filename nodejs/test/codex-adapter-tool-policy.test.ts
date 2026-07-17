import { describe, expect, it } from "vitest";
import { planDynamicToolCallRouting } from "../src/experimental/codexAdapterToolPolicy.js";

describe("Codex adapter dynamic tool call routing policy", () => {
    it("routes protocol-v2 tool calls through SDK tool.call requests", () => {
        expect(
            planDynamicToolCallRouting({
                protocolVersion: 2,
                sessionId: "sdk-session-1",
                toolCallId: "call-1",
                toolName: "lookup",
                argumentsPayload: { query: "phase 6" },
            })
        ).toEqual({
            mode: "protocol-v2-sdk-request",
            toolCallParams: {
                sessionId: "sdk-session-1",
                toolCallId: "call-1",
                toolName: "lookup",
                arguments: { query: "phase 6" },
            },
        });
    });

    it("routes protocol-v3 tool calls through session events with stable request ids", () => {
        expect(
            planDynamicToolCallRouting({
                protocolVersion: 3,
                sessionId: "sdk-session-1",
                toolCallId: "call-1",
                toolName: "lookup",
                argumentsPayload: { query: "phase 6" },
            })
        ).toEqual({
            mode: "protocol-v3-session-event",
            sdkRequestId: "codex-dynamic-tool:call-1",
            eventData: {
                requestId: "codex-dynamic-tool:call-1",
                sessionId: "sdk-session-1",
                toolCallId: "call-1",
                toolName: "lookup",
                arguments: { query: "phase 6" },
            },
            ephemeral: true,
        });
    });
});
