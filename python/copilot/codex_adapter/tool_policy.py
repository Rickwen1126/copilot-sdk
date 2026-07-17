"""Protocol-version-specific dynamic tool routing policy."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


class DynamicToolCallRoutingInput(TypedDict):
    protocolVersion: Literal[2, 3]
    sessionId: str
    toolCallId: str
    toolName: str
    argumentsPayload: Any


def plan_dynamic_tool_call_routing(input: DynamicToolCallRoutingInput) -> dict[str, Any]:
    if input["protocolVersion"] == 2:
        return {
            "mode": "protocol-v2-sdk-request",
            "toolCallParams": {
                "sessionId": input["sessionId"],
                "toolCallId": input["toolCallId"],
                "toolName": input["toolName"],
                "arguments": input["argumentsPayload"],
            },
        }

    sdk_request_id = f"codex-dynamic-tool:{input['toolCallId']}"
    return {
        "mode": "protocol-v3-session-event",
        "sdkRequestId": sdk_request_id,
        "eventData": {
            "requestId": sdk_request_id,
            "sessionId": input["sessionId"],
            "toolCallId": input["toolCallId"],
            "toolName": input["toolName"],
            "arguments": input["argumentsPayload"],
        },
        "ephemeral": True,
    }
