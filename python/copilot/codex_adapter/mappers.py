"""Shape mappers shared by the Python-native Codex adapter spike."""

from __future__ import annotations

import json
import os
from typing import Any, Literal, TypedDict


class ToolDescriptor(TypedDict, total=False):
    name: str
    description: str
    parameters: dict[str, Any]
    skipPermission: bool
    metadata: dict[str, Any]


SandboxMode = Literal[
    "dangerFullAccess",
    "danger-full-access",
    "readOnly",
    "read-only",
    "workspaceWrite",
    "workspace-write",
]

DEFAULT_DYNAMIC_TOOL_TEXT_CHAR_LIMIT = 60_000
DYNAMIC_TOOL_TEXT_CHAR_LIMIT_ENV = "CODEX_ADAPTER_DYNAMIC_TOOL_TEXT_CHAR_LIMIT"


def _dynamic_tool_text_char_limit() -> int:
    raw = os.environ.get(DYNAMIC_TOOL_TEXT_CHAR_LIMIT_ENV)
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = DEFAULT_DYNAMIC_TOOL_TEXT_CHAR_LIMIT
        return max(1_000, value)
    return DEFAULT_DYNAMIC_TOOL_TEXT_CHAR_LIMIT


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def tool_descriptors_from_session_create_params(params: Any) -> list[ToolDescriptor]:
    if not _is_record(params) or not isinstance(params.get("tools"), list):
        return []

    descriptors: list[ToolDescriptor] = []
    for tool in params["tools"]:
        if not _is_record(tool):
            continue
        descriptor: ToolDescriptor = {
            "name": tool["name"] if isinstance(tool.get("name"), str) else "unknown_tool",
            "skipPermission": tool.get("skipPermission") is True,
        }
        if isinstance(tool.get("description"), str):
            descriptor["description"] = tool["description"]
        if _is_record(tool.get("parameters")):
            descriptor["parameters"] = tool["parameters"]
        if _is_record(tool.get("metadata")):
            # Opaque host-defined bag (v1.0.7 Tool.metadata): preserved and
            # round-tripped untouched; excluded from the tool fingerprint.
            descriptor["metadata"] = tool["metadata"]
        descriptors.append(descriptor)
    return descriptors


def tool_metadata_from_descriptors(
    tools: list[ToolDescriptor],
) -> dict[str, dict[str, Any]] | None:
    """Collect the opaque per-tool metadata bags keyed by tool name.

    Returns None when no tool carries one so existing store records stay
    byte-identical.
    """
    entries = {
        tool["name"]: tool["metadata"]
        for tool in tools
        if isinstance(tool.get("name"), str) and _is_record(tool.get("metadata"))
    }
    return entries or None


def dynamic_tools_from_descriptors(tools: list[ToolDescriptor]) -> list[dict[str, Any]]:
    dynamic_tools: list[dict[str, Any]] = []
    for tool in tools:
        name = tool.get("name")
        if name == "unknown_tool" or not name:
            continue
        dynamic_tools.append(
            {
                "name": name,
                "description": tool.get("description") or f"SDK tool {name}",
                "inputSchema": tool.get("parameters")
                or {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                "deferLoading": False,
            }
        )
    return dynamic_tools


def map_sdk_tool_result_to_codex_dynamic_tool_response(result: Any, error: Any) -> dict[str, Any]:
    if isinstance(error, str) and error:
        return {"contentItems": [{"type": "inputText", "text": error}], "success": False}

    if isinstance(result, str):
        oversized = _oversized_dynamic_tool_text(result)
        if oversized:
            return oversized
        return {"contentItems": [{"type": "inputText", "text": result}], "success": True}

    if _is_record(result):
        text = result.get("textResultForLlm")
        result_type = result.get("resultType")
        if isinstance(text, str):
            oversized = _oversized_dynamic_tool_text(text)
            if oversized:
                return oversized
        return {
            "contentItems": [
                {
                    "type": "inputText",
                    "text": text
                    if isinstance(text, str)
                    else "Tool completed without textResultForLlm.",
                }
            ],
            "success": result_type not in {"failure", "rejected", "denied", "timeout"},
        }

    return {
        "contentItems": [
            {
                "type": "inputText",
                "text": "" if result is None else json.dumps(result, separators=(",", ":")),
            }
        ],
        "success": True,
    }


def _oversized_dynamic_tool_text(text: str) -> dict[str, Any] | None:
    limit = _dynamic_tool_text_char_limit()
    if len(text) <= limit:
        return None
    return {
        "contentItems": [
            {
                "type": "inputText",
                "text": (
                    "Tool result was too large for the Codex dynamic tool transport "
                    f"({len(text)} chars; safe limit {limit}). The result was not sent "
                    "to avoid a silent adapter turn stall. Retry with a narrower query, "
                    "pagination, or a tool-specific summary/compaction mode."
                ),
            }
        ],
        "success": False,
    }


def map_codex_models(result: Any) -> list[dict[str, Any]]:
    data = result.get("data") if _is_record(result) and isinstance(result.get("data"), list) else []
    models: list[dict[str, Any]] = []
    for entry in data:
        if not _is_record(entry):
            continue
        input_modalities = [
            item for item in entry.get("inputModalities", []) if isinstance(item, str)
        ]
        reasoning_efforts = [
            item["reasoningEffort"]
            for item in entry.get("supportedReasoningEfforts", [])
            if _is_record(item) and isinstance(item.get("reasoningEffort"), str)
        ]
        model: dict[str, Any] = {
            "id": entry["id"] if isinstance(entry.get("id"), str) else "unknown",
            "name": entry["displayName"]
            if isinstance(entry.get("displayName"), str)
            else str(entry.get("id")),
            "capabilities": {
                "supports": {
                    "vision": "image" in input_modalities,
                    "reasoningEffort": len(reasoning_efforts) > 0,
                },
                "limits": {"max_context_window_tokens": 0},
            },
            "supportedReasoningEfforts": reasoning_efforts,
        }
        if isinstance(entry.get("defaultReasoningEffort"), str):
            model["defaultReasoningEffort"] = entry["defaultReasoningEffort"]
        models.append(model)
    return models


def normalized_sandbox_mode(
    mode: SandboxMode,
) -> Literal["dangerFullAccess", "readOnly", "workspaceWrite"]:
    if mode in ("danger-full-access", "dangerFullAccess"):
        return "dangerFullAccess"
    if mode in ("workspace-write", "workspaceWrite"):
        return "workspaceWrite"
    return "readOnly"


def codex_thread_sandbox_mode(
    mode: SandboxMode,
) -> Literal["danger-full-access", "read-only", "workspace-write"]:
    normalized = normalized_sandbox_mode(mode)
    if normalized == "dangerFullAccess":
        return "danger-full-access"
    if normalized == "workspaceWrite":
        return "workspace-write"
    return "read-only"


def codex_sandbox_policy(mode: SandboxMode, network_access: bool) -> dict[str, Any]:
    normalized = normalized_sandbox_mode(mode)
    if normalized == "dangerFullAccess":
        return {"type": "dangerFullAccess"}
    if normalized == "workspaceWrite":
        return {
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": network_access,
            "excludeTmpdirEnvVar": False,
            "excludeSlashTmp": False,
        }
    return {"type": "readOnly", "networkAccess": network_access}


def _list_available_decision_ids(params: Any) -> list[str]:
    if not _is_record(params) or not isinstance(params.get("availableDecisions"), list):
        return []
    ids: list[str] = []
    for entry in params["availableDecisions"]:
        if isinstance(entry, str):
            ids.append(entry)
        elif _is_record(entry):
            ids.extend(str(key) for key in entry.keys())
    return ids


def _proposed_execpolicy_amendment(params: Any) -> list[str] | None:
    if not _is_record(params) or not isinstance(params.get("proposedExecpolicyAmendment"), list):
        return None
    amendment = [entry for entry in params["proposedExecpolicyAmendment"] if isinstance(entry, str)]
    return amendment or None


def _proposed_network_policy_amendment(params: Any) -> dict[str, Any] | None:
    if not _is_record(params) or not isinstance(
        params.get("proposedNetworkPolicyAmendments"), list
    ):
        return None
    amendments = params["proposedNetworkPolicyAmendments"]
    for entry in amendments:
        if _is_record(entry) and entry.get("action") == "allow":
            return entry
    first = amendments[0] if amendments else None
    return first if _is_record(first) else None


def map_codex_command_approval_to_permission_request(params: Any) -> dict[str, Any]:
    payload = params if _is_record(params) else {}
    full_command_text = (
        payload["command"]
        if isinstance(payload.get("command"), str)
        else " ".join(payload["proposedExecpolicyAmendment"])
        if isinstance(payload.get("proposedExecpolicyAmendment"), list)
        else ""
    )
    command_actions = (
        payload.get("commandActions") if isinstance(payload.get("commandActions"), list) else []
    )
    commands = []
    for entry in command_actions:
        if not _is_record(entry):
            continue
        command = (
            entry.get("command") if isinstance(entry.get("command"), str) else entry.get("cmd")
        )
        command = command if isinstance(command, str) else full_command_text
        commands.append(
            {
                "identifier": command.split(maxsplit=1)[0] if command else "command",
                "readOnly": False,
            }
        )

    available = set(_list_available_decision_ids(params))
    return {
        "kind": "shell",
        "toolCallId": payload.get("itemId") if isinstance(payload.get("itemId"), str) else None,
        "intention": payload["reason"]
        if isinstance(payload.get("reason"), str) and payload["reason"]
        else "Execute a shell command outside the current approval boundary.",
        "canOfferSessionApproval": "acceptForSession" in available
        or "acceptWithExecpolicyAmendment" in available,
        "fullCommandText": full_command_text,
        "hasWriteFileRedirection": ">" in full_command_text,
        "commands": commands or [{"identifier": "command", "readOnly": False}],
        "possiblePaths": [],
        "possibleUrls": [],
    }


# Approve-family PermissionDecision kind literals from the v1.0.7 generated
# RPC schema (PermissionDecisionKind). Every other kind (reject / cancelled /
# user-not-available / denied-*) maps to a Codex decline.
_APPROVED_PERMISSION_KINDS = {
    "approve-once",
    "approve-for-session",
    "approve-for-location",
    "approve-permanently",
    "approved",
    "approved-for-session",
    "approved-for-location",
}


def _is_approved_permission_kind(permission_result: Any) -> bool:
    kind = permission_result.get("kind") if _is_record(permission_result) else None
    return isinstance(kind, str) and kind in _APPROVED_PERMISSION_KINDS


def map_permission_result_to_codex_command_decision(
    permission_result: Any, request_params: Any
) -> Any:
    if not _is_approved_permission_kind(permission_result):
        return "decline"

    available = set(_list_available_decision_ids(request_params))
    if "accept" in available:
        return "accept"
    execpolicy = _proposed_execpolicy_amendment(request_params)
    if execpolicy and "acceptWithExecpolicyAmendment" in available:
        return {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": execpolicy}}
    network_policy = _proposed_network_policy_amendment(request_params)
    if network_policy and "applyNetworkPolicyAmendment" in available:
        return {"applyNetworkPolicyAmendment": {"network_policy_amendment": network_policy}}
    if "acceptForSession" in available:
        return "acceptForSession"
    return "accept"


def extract_file_changes_from_params(params: Any) -> list[Any]:
    if not _is_record(params):
        return []
    if isinstance(params.get("changes"), list):
        return params["changes"]
    item = params.get("item")
    if _is_record(item) and isinstance(item.get("changes"), list):
        return item["changes"]
    return []


def map_codex_file_change_approval_to_permission_request(
    params: Any, changes: list[Any]
) -> dict[str, Any]:
    payload = params if _is_record(params) else {}
    paths = [
        change["path"]
        for change in changes
        if _is_record(change) and isinstance(change.get("path"), str)
    ]
    diffs = [
        change["diff"]
        for change in changes
        if _is_record(change) and isinstance(change.get("diff"), str) and change["diff"]
    ]
    return {
        "kind": "write",
        "toolCallId": payload.get("itemId") if isinstance(payload.get("itemId"), str) else None,
        "intention": payload["reason"]
        if isinstance(payload.get("reason"), str) and payload["reason"]
        else "Apply file changes outside the current approval boundary.",
        # Required by the v1.0.7 PermissionRequestWrite dataclass parser
        # (from_dict asserts on canOfferSessionApproval/diff/fileName).
        "canOfferSessionApproval": False,
        "diff": "\n".join(diffs),
        "fileName": paths[0] if paths else "",
        "grantRoot": payload.get("grantRoot")
        if isinstance(payload.get("grantRoot"), str)
        else None,
        "paths": paths,
        "possiblePaths": paths,
        "changes": changes,
    }


def map_permission_result_to_codex_file_change_decision(permission_result: Any) -> str:
    return "accept" if _is_approved_permission_kind(permission_result) else "decline"
