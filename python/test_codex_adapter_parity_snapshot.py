from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

import pytest

from copilot import CopilotClient, PermissionHandler, RuntimeConnection, define_tool
from copilot.codex_adapter import CODEX_ADAPTER_CAPABILITIES
from copilot.codex_adapter.server import CodexAdapterOptions, CodexCopilotAdapterServer
from copilot.generated.rpc import (
    PermissionDecisionApproveOnce,
    PermissionDecisionDeniedByRules,
    PermissionDecisionDeniedInteractivelyByUser,
)
from copilot.tools import ToolResult
from test_codex_adapter_server import FakeCodexGateway


def _transcript_methods(transcript, direction: str, method: str) -> list[str]:
    methods = []
    for entry in transcript:
        if entry["direction"] != direction:
            continue
        message = entry["message"]
        if isinstance(message, dict) and message.get("method") == method:
            methods.append(method)
    return methods


def _timeout_tool_names(transcript) -> list[str]:
    tool_names = []
    for entry in transcript:
        if entry["direction"] != "adapter.tool.timeout":
            continue
        message = entry["message"]
        if isinstance(message, dict) and isinstance(message.get("toolName"), str):
            tool_names.append(message["toolName"])
    return tool_names


async def _scenario_create_send_lifecycle(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            system_message={
                "mode": "replace",
                "content": "You are the adapter characterization test assistant.",
            },
        )
        assistant = await session.send_and_wait(
            "Reply through the fake Codex gateway.",
            timeout=2,
        )
        events = await session.get_events()
        thread_start = next(params for method, params in fake.requests if method == "thread/start")
        turn_start = next(params for method, params in fake.requests if method == "turn/start")

        await session.disconnect()
        await session.disconnect()
        resumed = await client.resume_session(
            session.session_id,
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
        )
        await client.delete_session(session.session_id)

        delete_resume_error = ""
        try:
            await client.resume_session(
                resumed.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
            )
        except Exception as exc:
            delete_resume_error = str(exc)

        return {
            "threadStart": {
                "model": thread_start["model"],
                "baseInstructions": thread_start["baseInstructions"],
                "ephemeral": thread_start["ephemeral"],
            },
            "turnStart": {
                "model": turn_start["model"],
                "threadIdMatches": turn_start["threadId"] == "thread-1",
            },
            "assistantMessage": assistant.data.content if assistant else None,
            "eventTypes": sorted(event.type.value for event in events),
            "unsubscribeCount": sum(
                1 for method, _ in fake.requests if method == "thread/unsubscribe"
            ),
            "resumeCount": sum(1 for method, _ in fake.requests if method == "thread/resume"),
            "archiveCount": sum(1 for method, _ in fake.requests if method == "thread/archive"),
            "deleteResumeError": delete_resume_error,
        }
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_restart_resume(store_path: Path) -> dict:
    first_fake = FakeCodexGateway()
    first_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=first_fake,
    )
    await first_server.start()
    first_client = CopilotClient(connection=RuntimeConnection.for_uri(first_server.cli_url()))
    await first_client.start()
    first_session = await first_client.create_session(
        model="gpt-test",
        on_permission_request=PermissionHandler.approve_all,
    )
    session_id = first_session.session_id
    await first_session.disconnect()
    await first_client.force_stop()
    await first_server.stop()

    second_fake = FakeCodexGateway()
    second_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=second_fake,
    )
    await second_server.start()
    second_client = CopilotClient(connection=RuntimeConnection.for_uri(second_server.cli_url()))
    await second_client.start()
    try:
        resumed = await second_client.resume_session(
            session_id,
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
        )
        assistant = await resumed.send_and_wait("Continue after adapter restart.", timeout=2)
        return {
            "threadStartCount": sum(
                1 for method, _ in second_fake.requests if method == "thread/start"
            ),
            "threadResumeCount": sum(
                1 for method, _ in second_fake.requests if method == "thread/resume"
            ),
            "assistantMessage": assistant.data.content if assistant else None,
        }
    finally:
        await second_client.force_stop()
        await second_server.stop()


async def _scenario_active_tool_mismatch(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Original tool shape")
        def stable_tool(_args):
            return "stable"

        session = await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=[stable_tool],
        )

        @define_tool(description="Changed tool shape")
        def changed_tool(_args):
            return "changed"

        error_message = ""
        try:
            await client.resume_session(
                session.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
                tools=[changed_tool],
            )
        except Exception as exc:
            error_message = str(exc)

        return {
            "error": error_message,
            "threadResumeCount": sum(1 for method, _ in fake.requests if method == "thread/resume"),
        }
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_restart_tool_checks(store_path: Path) -> dict:
    first_fake = FakeCodexGateway()
    first_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=first_fake,
    )
    await first_server.start()
    first_client = CopilotClient(connection=RuntimeConnection.for_uri(first_server.cli_url()))
    await first_client.start()

    @define_tool(description="Tool that must be reattached after restart")
    def restart_tool(_args):
        return "restart"

    first_session = await first_client.create_session(
        model="gpt-test",
        on_permission_request=PermissionHandler.approve_all,
        tools=[restart_tool],
    )
    session_id = first_session.session_id
    await first_session.disconnect()
    await first_client.force_stop()
    await first_server.stop()

    second_fake = FakeCodexGateway()
    second_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=second_fake,
    )
    await second_server.start()
    second_client = CopilotClient(connection=RuntimeConnection.for_uri(second_server.cli_url()))
    await second_client.start()
    try:
        missing_tools_error = ""
        try:
            await second_client.resume_session(
                session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
            )
        except Exception as exc:
            missing_tools_error = str(exc)

        @define_tool(description="Changed persisted tool")
        def changed_restart_tool(_args):
            return "changed"

        incompatible_tools_error = ""
        try:
            await second_client.resume_session(
                session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
                tools=[changed_restart_tool],
            )
        except Exception as exc:
            incompatible_tools_error = str(exc)

        return {
            "missingToolsError": missing_tools_error,
            "incompatibleToolsError": incompatible_tools_error,
            "threadResumeCount": sum(
                1 for method, _ in second_fake.requests if method == "thread/resume"
            ),
        }
    finally:
        await second_client.force_stop()
        await second_server.stop()


async def _scenario_command_approval(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    seen_requests = []

    def approve_shell(request, _invocation):
        seen_requests.append(request.to_dict())
        return PermissionDecisionApproveOnce()

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=approve_shell)
        approved = await fake.emit_request(
            "item/commandExecution/requestApproval",
            {
                "threadId": "thread-1",
                "itemId": "command-1",
                "reason": "Need to write the approval probe.",
                "command": "zsh -lc 'echo hello > /tmp/probe'",
                "commandActions": [{"command": "zsh -lc 'echo hello > /tmp/probe'"}],
                "availableDecisions": ["accept", "acceptForSession"],
            },
        )
        transcript = server.summary()["adapterTranscript"]
        approved_payload = {
            "approvedDecision": approved["result"],
            "request": seen_requests[0],
            "transcriptMethods": {
                "request": _transcript_methods(
                    transcript, "adapter->sdk.request", "permission.request"
                ),
                "response": _transcript_methods(
                    transcript, "sdk->adapter.response", "permission.request"
                ),
            },
        }
    finally:
        await client.force_stop()
        await server.stop()

    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path.with_suffix(".deny.json"))),
        gateway=fake,
    )
    await server.start()

    def deny_shell(_request, _invocation):
        return PermissionDecisionDeniedByRules(rules=[])

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=deny_shell)
        denied = await fake.emit_request(
            "item/commandExecution/requestApproval",
            {
                "threadId": "thread-1",
                "itemId": "command-2",
                "command": "zsh -lc 'echo denied'",
                "availableDecisions": ["accept", "acceptForSession"],
            },
        )
        approved_payload["deniedDecision"] = denied["result"]
        return approved_payload
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_file_approval(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    seen_requests = []

    def approve_write(request, _invocation):
        seen_requests.append(request.to_dict())
        return PermissionDecisionApproveOnce()

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=approve_write)
        fake.notification_handler(
            {
                "method": "item/updated",
                "params": {
                    "threadId": "thread-1",
                    "itemId": "file-1",
                    "changes": [{"path": "/tmp/allowed.txt"}, {"kind": "metadata-without-path"}],
                },
            }
        )
        approved = await fake.emit_request(
            "item/fileChange/requestApproval",
            {"threadId": "thread-1", "itemId": "file-1"},
        )
        approved_payload = {
            "approvedDecision": approved["result"],
            "request": seen_requests[0],
        }
    finally:
        await client.force_stop()
        await server.stop()

    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path.with_suffix(".deny.json"))),
        gateway=fake,
    )
    await server.start()

    def deny_write(_request, _invocation):
        return PermissionDecisionDeniedInteractivelyByUser()

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=deny_write)
        fake.notification_handler(
            {
                "method": "item/updated",
                "params": {
                    "threadId": "thread-1",
                    "itemId": "file-2",
                    "changes": [{"path": "/tmp/denied.txt"}],
                },
            }
        )
        denied = await fake.emit_request(
            "item/fileChange/requestApproval",
            {"threadId": "thread-1", "itemId": "file-2"},
        )
        approved_payload["deniedDecision"] = denied["result"]
        return approved_payload
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_tool_v2(store_path: Path) -> dict:
    # protocol v2 is refused loudly on SDK v1.0.7 (mirrors the nodejs
    # snapshot): record the refusal instead of exercising the removed path.
    refusal = None
    try:
        CodexCopilotAdapterServer(
            CodexAdapterOptions(protocol_version=2, runtime_session_store_path=str(store_path)),
            gateway=FakeCodexGateway(),
        )
    except RuntimeError as exc:
        refusal = str(exc)
    return {"refused": refusal is not None, "refusal": refusal}


async def _scenario_tool_v3(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Lookup source data")
        def lookup(args):
            return f"lookup:{args['query']}"

        @define_tool(description="Deliberately deny a tool call")
        def deny_tool(_args):
            return ToolResult(text_result_for_llm="tool denied", result_type="denied")

        @define_tool(description="Raise a deterministic error")
        def fail_tool(_args):
            raise RuntimeError("tool failed hard")

        await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=[lookup, deny_tool, fail_tool],
        )
        success = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "lookup",
                "callId": "call-v3",
                "arguments": {"query": "v3"},
            },
        )
        denied = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "deny_tool",
                "callId": "deny-v3",
                "arguments": {},
            },
        )
        failed = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "fail_tool",
                "callId": "fail-v3",
                "arguments": {},
            },
        )
        return {
            "success": success["result"],
            "denied": denied["result"],
            "failed": failed["result"],
        }
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_tool_timeout(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(request_timeout_ms=10, runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Tool that never reports a result")
        async def slow_tool(_args):
            await asyncio.Future()

        await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=[slow_tool],
        )
        result = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "slow_tool",
                "callId": "slow-call-1",
                "arguments": {},
            },
        )
        return {
            "response": result["result"],
            "transcriptToolNames": _timeout_tool_names(server.summary()["adapterTranscript"]),
        }
    finally:
        await client.force_stop()
        await server.stop()


async def _scenario_dynamic_tool_errors(store_path: Path) -> dict:
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(store_path)),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Lookup source data")
        def lookup(_args):
            return "lookup"

        await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=[lookup],
        )
        missing_thread = await fake.emit_request(
            "item/tool/call",
            {"tool": "lookup", "callId": "missing-thread", "arguments": {}},
        )
        missing_name = await fake.emit_request(
            "item/tool/call",
            {"threadId": "thread-1", "callId": "missing-name", "arguments": {}},
        )
        unknown_tool = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "not_registered",
                "callId": "unknown-tool",
                "arguments": {},
            },
        )
        server.connections.clear()
        no_connection = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "lookup",
                "callId": "no-connection",
                "arguments": {},
            },
        )
        return {
            "missingThread": missing_thread["result"]["contentItems"][0]["text"],
            "missingName": missing_name["result"]["contentItems"][0]["text"],
            "unknownTool": unknown_tool["result"]["contentItems"][0]["text"],
            "noConnection": no_connection["result"]["contentItems"][0]["text"],
        }
    finally:
        await client.force_stop()
        await server.stop()


async def _build_python_snapshot(tmp_path: Path) -> dict:
    return {
        "capabilities": {
            "supported": sorted(
                flag["id"]
                for flag in CODEX_ADAPTER_CAPABILITIES["flags"]
                if flag["status"] == "supported"
            ),
            "deferred": sorted(
                flag["id"]
                for flag in CODEX_ADAPTER_CAPABILITIES["flags"]
                if flag["status"] == "deferred"
            ),
        },
        "createSendLifecycle": await _scenario_create_send_lifecycle(tmp_path / "create-send.json"),
        "restartResume": await _scenario_restart_resume(tmp_path / "restart-resume.json"),
        "activeToolMismatch": await _scenario_active_tool_mismatch(tmp_path / "active-tools.json"),
        "restartToolChecks": await _scenario_restart_tool_checks(tmp_path / "restart-tools.json"),
        "commandApproval": await _scenario_command_approval(tmp_path / "command-approve.json"),
        "fileApproval": await _scenario_file_approval(tmp_path / "file-approve.json"),
        "toolV2": await _scenario_tool_v2(tmp_path / "tool-v2.json"),
        "toolV3": await _scenario_tool_v3(tmp_path / "tool-v3.json"),
        "toolTimeout": await _scenario_tool_timeout(tmp_path / "tool-timeout.json"),
        "dynamicToolErrors": await _scenario_dynamic_tool_errors(tmp_path / "tool-errors.json"),
    }


def _load_node_snapshot(repo_root: Path) -> dict:
    runner = repo_root / "nodejs" / "node_modules" / ".bin" / "tsx"
    script = repo_root / "nodejs" / "conformance" / "codexAdapterParitySnapshot.ts"
    result = subprocess.run(
        [str(runner), str(script)],
        check=True,
        capture_output=True,
        text=True,
        cwd=repo_root,
    )
    return json.loads(result.stdout)


def _normalize_snapshot(value):
    if isinstance(value, dict):
        return {key: _normalize_snapshot(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_snapshot(item) for item in value]
    if isinstance(value, str):
        normalized = re.sub(
            r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
            "<session-id>",
            value,
        )
        for prefix in (
            "Request session.resume failed with message: ",
            "JSON-RPC Error -32603: ",
        ):
            if normalized.startswith(prefix):
                normalized = normalized[len(prefix) :]
        if "2 is not supported on SDK v1.0.7" in normalized:
            return "<protocol-2-refused>"
        return normalized
    return value


@pytest.mark.asyncio
async def test_python_selected_profile_matches_node_snapshot(tmp_path):
    repo_root = Path(__file__).resolve().parent.parent
    node_snapshot = _normalize_snapshot(_load_node_snapshot(repo_root))
    python_snapshot = _normalize_snapshot(await _build_python_snapshot(tmp_path))
    assert python_snapshot == node_snapshot
