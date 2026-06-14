from copilot.experimental.codex_adapter import (
    codex_sandbox_policy,
    codex_thread_sandbox_mode,
    dynamic_tools_from_descriptors,
    extract_file_changes_from_params,
    map_codex_command_approval_to_permission_request,
    map_codex_file_change_approval_to_permission_request,
    map_codex_models,
    map_permission_result_to_codex_command_decision,
    map_permission_result_to_codex_file_change_decision,
    map_sdk_tool_result_to_codex_dynamic_tool_response,
    normalized_sandbox_mode,
    plan_dynamic_tool_call_routing,
    tool_descriptors_from_session_create_params,
)


def test_tool_descriptor_and_dynamic_tool_mapping_matches_node_shape():
    descriptors = tool_descriptors_from_session_create_params(
        {
            "tools": [
                {
                    "name": "lookup",
                    "description": "Look up source data.",
                    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
                    "skipPermission": True,
                },
                {"description": "Missing a name.", "parameters": {"type": "object"}},
                "not-a-tool",
            ]
        }
    )

    assert descriptors == [
        {
            "name": "lookup",
            "description": "Look up source data.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
            "skipPermission": True,
        },
        {
            "name": "unknown_tool",
            "description": "Missing a name.",
            "parameters": {"type": "object"},
            "skipPermission": False,
        },
    ]
    assert dynamic_tools_from_descriptors(descriptors) == [
        {
            "name": "lookup",
            "description": "Look up source data.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
            "deferLoading": False,
        }
    ]


def test_tool_result_mapper_keeps_safe_text_contract():
    assert map_sdk_tool_result_to_codex_dynamic_tool_response(None, "tool failed") == {
        "contentItems": [{"type": "inputText", "text": "tool failed"}],
        "success": False,
    }
    assert map_sdk_tool_result_to_codex_dynamic_tool_response("hello", None) == {
        "contentItems": [{"type": "inputText", "text": "hello"}],
        "success": True,
    }
    assert map_sdk_tool_result_to_codex_dynamic_tool_response(
        {"textResultForLlm": "not allowed", "resultType": "denied"}, None
    ) == {"contentItems": [{"type": "inputText", "text": "not allowed"}], "success": False}
    assert map_sdk_tool_result_to_codex_dynamic_tool_response({"resultType": "success"}, None) == {
        "contentItems": [{"type": "inputText", "text": "Tool completed without textResultForLlm."}],
        "success": True,
    }


def test_model_and_sandbox_mappers_match_selected_profile_shape():
    assert map_codex_models(
        {
            "data": [
                {
                    "id": "gpt-5.4",
                    "displayName": "GPT 5.4",
                    "inputModalities": ["text", "image"],
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "low"},
                        {"reasoningEffort": "high"},
                    ],
                    "defaultReasoningEffort": "high",
                }
            ]
        }
    ) == [
        {
            "id": "gpt-5.4",
            "name": "GPT 5.4",
            "capabilities": {
                "supports": {"vision": True, "reasoningEffort": True},
                "limits": {"max_context_window_tokens": 0},
            },
            "supportedReasoningEfforts": ["low", "high"],
            "defaultReasoningEffort": "high",
        }
    ]
    assert normalized_sandbox_mode("danger-full-access") == "dangerFullAccess"
    assert codex_thread_sandbox_mode("workspaceWrite") == "workspace-write"
    assert codex_sandbox_policy("readOnly", False) == {"type": "readOnly", "networkAccess": False}


def test_permission_mappers_match_command_and_file_decisions():
    request = map_codex_command_approval_to_permission_request(
        {
            "itemId": "item-1",
            "reason": "Need to write the approval probe.",
            "command": "zsh -lc 'echo hello > /tmp/probe'",
            "commandActions": [{"command": "zsh -lc 'echo hello > /tmp/probe'"}],
            "availableDecisions": ["accept", "acceptForSession"],
        }
    )
    assert request["kind"] == "shell"
    assert request["toolCallId"] == "item-1"
    assert request["canOfferSessionApproval"] is True
    assert request["hasWriteFileRedirection"] is True
    assert request["commands"] == [{"identifier": "zsh", "readOnly": False}]

    assert map_permission_result_to_codex_command_decision(
        {"kind": "approved"},
        {
            "availableDecisions": ["acceptWithExecpolicyAmendment"],
            "proposedExecpolicyAmendment": ["zsh", "-lc", "echo hello"],
        },
    ) == {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["zsh", "-lc", "echo hello"]}}
    assert map_permission_result_to_codex_command_decision({"kind": "denied"}, {}) == "decline"

    changes = [{"path": "/tmp/allowed.txt"}, {"kind": "metadata-without-path"}]
    assert extract_file_changes_from_params({"item": {"changes": changes}}) is changes
    assert map_codex_file_change_approval_to_permission_request({"itemId": "file-1"}, changes) == {
        "kind": "write",
        "toolCallId": "file-1",
        "intention": "Apply file changes outside the current approval boundary.",
        "grantRoot": None,
        "paths": ["/tmp/allowed.txt"],
        "possiblePaths": ["/tmp/allowed.txt"],
        "changes": changes,
    }
    assert map_permission_result_to_codex_file_change_decision({"kind": "approved"}) == "accept"
    assert map_permission_result_to_codex_file_change_decision({"kind": "denied"}) == "decline"


def test_protocol_tool_routing_policy_matches_node_shape():
    assert plan_dynamic_tool_call_routing(
        {
            "protocolVersion": 2,
            "sessionId": "sdk-session-1",
            "toolCallId": "call-1",
            "toolName": "lookup",
            "argumentsPayload": {"query": "phase 6"},
        }
    ) == {
        "mode": "protocol-v2-sdk-request",
        "toolCallParams": {
            "sessionId": "sdk-session-1",
            "toolCallId": "call-1",
            "toolName": "lookup",
            "arguments": {"query": "phase 6"},
        },
    }
    assert plan_dynamic_tool_call_routing(
        {
            "protocolVersion": 3,
            "sessionId": "sdk-session-1",
            "toolCallId": "call-1",
            "toolName": "lookup",
            "argumentsPayload": {"query": "phase 6"},
        }
    ) == {
        "mode": "protocol-v3-session-event",
        "sdkRequestId": "codex-dynamic-tool:call-1",
        "eventData": {
            "requestId": "codex-dynamic-tool:call-1",
            "sessionId": "sdk-session-1",
            "toolCallId": "call-1",
            "toolName": "lookup",
            "arguments": {"query": "phase 6"},
        },
        "ephemeral": True,
    }
