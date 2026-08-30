from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest

from copilot import CopilotClient, PermissionHandler, RuntimeConnection, define_tool
from copilot.codex_adapter.gateway import (
    CodexAppServerGateway,
    CodexAppServerGatewayOptions,
    CodexAppServerGatewayReaderError,
)
from copilot.codex_adapter.server import CodexAdapterOptions, CodexCopilotAdapterServer
from copilot.generated.rpc import (
    ModelSwitchToRequest,
    PermissionDecisionApproveOnce,
    PermissionDecisionDeniedByRules,
    PermissionDecisionDeniedInteractivelyByUser,
)
from copilot.tools import ToolResult


class FakeCodexGateway:
    def __init__(self):
        self.requests: list[tuple[str, Any]] = []
        self.responses: list[tuple[Any, Any, Any]] = []
        self.notification_handler = None
        self.request_handler = None
        self.fatal_error_handler = None
        self.next_thread = 1
        self.pending_codex_requests: dict[Any, asyncio.Future] = {}
        self.start_count = 0
        self.stop_count = 0

    async def start(self):
        self.start_count += 1
        return None

    async def stop(self):
        self.stop_count += 1
        for future in list(self.pending_codex_requests.values()):
            if not future.done():
                future.set_exception(RuntimeError("fake gateway stopped"))
        self.pending_codex_requests.clear()
        return None

    async def request(self, method, params=None):
        self.requests.append((method, params))
        if method == "account/read":
            return {
                "id": len(self.requests),
                "result": {
                    "account": {"type": "chatgpt", "email": "dev@example.test", "planType": "plus"}
                },
            }
        if method == "model/list":
            return {
                "id": len(self.requests),
                "result": {"data": [{"id": "gpt-5.4", "displayName": "GPT 5.4"}]},
            }
        if method == "thread/start":
            thread_id = f"thread-{self.next_thread}"
            self.next_thread += 1
            return {"id": len(self.requests), "result": {"thread": {"id": thread_id}}}
        if method in {"thread/resume", "turn/start", "thread/unsubscribe", "thread/archive"}:
            if method == "turn/start":
                asyncio.create_task(self._complete_turn(params["threadId"]))
            return {"id": len(self.requests), "result": {}}
        raise AssertionError(f"unexpected codex request {method}")

    def notify(self, method, params=None):
        self.requests.append((method, params))

    def respond(self, request_id, result=None, error=None):
        self.responses.append((request_id, result, error))
        future = self.pending_codex_requests.pop(request_id, None)
        if future and not future.done():
            future.set_result({"id": request_id, "result": result, "error": error})

    def on_notification(self, handler):
        self.notification_handler = handler
        return lambda: None

    def on_request(self, handler):
        self.request_handler = handler
        return lambda: None

    def on_fatal_error(self, handler):
        self.fatal_error_handler = handler
        return lambda: None

    def summary(self):
        return {"requests": self.requests, "responses": self.responses}

    async def emit_request(self, method, params):
        request_id = f"codex-{len(self.pending_codex_requests) + 1}"
        future = asyncio.get_running_loop().create_future()
        self.pending_codex_requests[request_id] = future
        outcome = self.request_handler({"id": request_id, "method": method, "params": params})
        if isinstance(outcome, asyncio.Task):
            await outcome
        elif asyncio.iscoroutine(outcome):
            await outcome
        return await asyncio.wait_for(future, 2)

    async def emit_fatal_error(self, error, metadata):
        outcome = self.fatal_error_handler(error, metadata)
        if isinstance(outcome, asyncio.Task):
            await outcome
        elif asyncio.iscoroutine(outcome):
            await outcome

    async def _complete_turn(self, thread_id):
        await asyncio.sleep(0.01)
        self.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": thread_id,
                    "item": {
                        "id": "assistant-1",
                        "type": "agentMessage",
                        "text": "adapter characterization reply",
                    },
                },
            }
        )
        self.notification_handler(
            {
                "method": "turn/completed",
                "params": {"threadId": thread_id, "turn": {"status": "completed"}},
            }
        )


@pytest.fixture
async def adapter(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(tmp_path / "sessions.json")),
        gateway=fake,
    )
    await server.start()
    try:
        yield server, fake
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_python_sdk_can_ping_status_auth_models_and_send(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        ping = await client.ping("python")
        status = await client.get_status()
        auth = await client.get_auth_status()
        models = await client.list_models()
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        response = await session.send_and_wait("hello", timeout=2)
        messages = await session.get_events()

        assert ping.message == "pong: python"
        assert status.protocol_version == 3
        assert auth.isAuthenticated is True
        assert models[0].id == "gpt-5.4"
        assert response is not None
        assert any(event.type.value == "assistant.message" for event in messages)
        thread_start = next(params for method, params in fake.requests if method == "thread/start")
        turn_start = next(params for method, params in fake.requests if method == "turn/start")
        assert thread_start["approvalPolicy"] == "on-request"
        assert thread_start["approvalsReviewer"] == "auto_review"
        assert thread_start["sandbox"] == "workspace-write"
        assert turn_start["approvalPolicy"] == "on-request"
        assert turn_start["approvalsReviewer"] == "auto_review"
        assert turn_start["sandboxPolicy"] == {
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": False,
            "excludeTmpdirEnvVar": False,
            "excludeSlashTmp": False,
        }
        semantic_events = {
            (entry["category"], entry["event"]) for entry in server.summary()["semanticLog"]
        }
        assert ("session.lifecycle", "created") in semantic_events
        assert ("turn.lifecycle", "started") in semantic_events
        assert ("assistant.message", "completed") in semantic_events
        assert ("turn.lifecycle", "completed") in semantic_events
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_lifecycle_notifications_are_sdk_parseable_for_abort_resume_and_delete(
    adapter, tmp_path
):
    server, _fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    events = []
    loop = asyncio.get_running_loop()
    loop_exceptions = []
    previous_exception_handler = loop.get_exception_handler()

    def capture_loop_exception(_loop, context):
        loop_exceptions.append(context)

    loop.set_exception_handler(capture_loop_exception)
    unsubscribe = None
    try:
        await client.start()
        unsubscribe = client.on_lifecycle(events.append)

        aborted = await client.create_session(
            session_id="lifecycle-abort",
            working_directory=str(tmp_path),
            on_permission_request=PermissionHandler.approve_all,
        )
        await aborted.abort()

        created = await client.create_session(
            session_id="lifecycle-resume-delete",
            working_directory=str(tmp_path),
            on_permission_request=PermissionHandler.approve_all,
        )
        await created.disconnect()
        resumed = await client.resume_session(
            session_id=created.session_id,
            working_directory=str(tmp_path),
            on_permission_request=PermissionHandler.approve_all,
        )
        await resumed.disconnect()
        await client.delete_session(created.session_id)
        await asyncio.sleep(0)
    finally:
        if unsubscribe:
            unsubscribe()
        loop.set_exception_handler(previous_exception_handler)
        await client.force_stop()

    assert not loop_exceptions
    lifecycle_session_ids = {event.session_id for event in events}
    assert "lifecycle-abort" in lifecycle_session_ids
    assert "lifecycle-resume-delete" in lifecycle_session_ids


@pytest.mark.asyncio
async def test_model_switch_keeps_session_and_updates_turn_start_reasoning(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-5.4",
            reasoning_effort="high",
            on_permission_request=PermissionHandler.approve_all,
        )
        thread_id = server.summary()["sessions"][0]["threadId"]

        current = await session.rpc.model.get_current()
        assert current.model_id == "gpt-5.4"

        await session.send_and_wait("first turn", timeout=2)
        first_turn_start = next(
            params for method, params in fake.requests if method == "turn/start"
        )
        assert first_turn_start["threadId"] == thread_id
        assert first_turn_start["model"] == "gpt-5.4"
        assert first_turn_start["reasoningEffort"] == "high"

        await session.rpc.model.switch_to(
            ModelSwitchToRequest(
                model_id="gpt-4.1",
                reasoning_effort="none",
            )
        )
        current = await session.rpc.model.get_current()
        assert current.model_id == "gpt-4.1"

        messages = await session.get_events()
        model_change = [
            event
            for event in messages
            if event.type.value == "session.model_change"
        ]
        assert model_change
        assert model_change[-1].data.new_model == "gpt-4.1"
        assert model_change[-1].data.previous_model == "gpt-5.4"
        assert model_change[-1].data.previous_reasoning_effort == "high"
        assert model_change[-1].data.reasoning_effort == "none"

        await session.send_and_wait("second turn", timeout=2)
        turn_starts = [params for method, params in fake.requests if method == "turn/start"]
        assert turn_starts[-1]["threadId"] == thread_id
        assert turn_starts[-1]["model"] == "gpt-4.1"
        assert turn_starts[-1]["reasoningEffort"] == "none"
        assert server.summary()["sessions"][0]["threadId"] == thread_id
        assert server.summary()["sessions"][0]["reasoningEffort"] == "none"
        semantic_events = {
            (entry["category"], entry["event"]) for entry in server.summary()["semanticLog"]
        }
        assert ("session.model", "switched") in semantic_events
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_gateway_reader_failure_emits_session_error(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)

        await fake.emit_fatal_error(
            RuntimeError("Separator is found, but chunk is longer than limit"),
            {
                "errorName": "ValueError",
                "errorMessage": "Separator is found, but chunk is longer than limit",
                "streamLimitBytes": 1024,
            },
        )
        messages = await session.get_events()
        error_events = [event for event in messages if event.type.value == "session.error"]

        assert error_events
        assert error_events[-1].data.error_type == "adapter_transport"
        assert error_events[-1].data.provider_call_id == "codex_gateway_reader_failed"
        assert "chunk or spill" in error_events[-1].data.message
        assert "stream_limit_bytes=1024" in error_events[-1].data.message
        semantic_events = {
            (entry["category"], entry["event"]) for entry in server.summary()["semanticLog"]
        }
        assert ("codex.gateway", "reader_failed") in semantic_events
        assert ("runtime.error", "codex_gateway_reader_failed") in semantic_events
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_gateway_transcript_spills_oversized_payload(tmp_path):
    gateway = CodexAppServerGateway(
        CodexAppServerGatewayOptions(
            codex_home=str(tmp_path / "codex-home"),
            isolate_codex_home=False,
            payload_spill_threshold_bytes=40,
            transcript_payload_preview_chars=12,
            payload_spill_dir=str(tmp_path / "spill"),
        )
    )
    payload = {
        "method": "item/completed",
        "params": {
            "threadId": "thread-large",
            "item": {
                "id": "item-large",
                "type": "commandExecution",
                "aggregatedOutput": "x" * 200,
            },
        },
    }

    gateway._record("codex->adapter", payload)
    entry = gateway.summary()["transcripts"][0]["message"]

    assert entry["oversized"] is True
    assert entry["method"] == "item/completed"
    assert entry["threadId"] == "thread-large"
    assert entry["itemId"] == "item-large"
    assert entry["itemType"] == "commandExecution"
    assert entry["payloadBytes"] > 40
    assert len(entry["preview"]) == 12
    assert entry["spillPath"].endswith(".json.gz")
    assert Path(entry["spillPath"]).exists()


@pytest.mark.asyncio
async def test_gateway_reader_limit_failure_fails_pending_requests(tmp_path):
    class FailingStdout:
        async def readline(self):
            raise ValueError("Separator is found, but chunk is longer than limit")

    class FakeProcess:
        stdout = FailingStdout()
        returncode = None
        terminated = False
        killed = False

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        async def wait(self):
            self.returncode = 1

    gateway = CodexAppServerGateway(
        CodexAppServerGatewayOptions(
            codex_home=str(tmp_path / "codex-home"),
            isolate_codex_home=False,
            subprocess_stream_limit_bytes=65536,
        )
    )
    fake_process = FakeProcess()
    gateway.process = fake_process
    pending = asyncio.get_running_loop().create_future()
    gateway.pending["pending"] = pending
    captured = []
    gateway.on_fatal_error(lambda error, metadata: captured.append((error, metadata)))

    task = asyncio.create_task(gateway._read_stdout())
    task.add_done_callback(gateway._handle_reader_done)
    await asyncio.sleep(0.01)

    with pytest.raises(CodexAppServerGatewayReaderError):
        await pending
    assert captured
    assert captured[-1][1]["streamLimitBytes"] == 65536
    assert captured[-1][1]["originalErrorName"] == "ValueError"
    assert gateway.process is None
    assert fake_process.terminated is True


@pytest.mark.asyncio
async def test_session_create_without_working_directory_uses_isolated_fallback_workspace(tmp_path):
    fake = FakeCodexGateway()
    fallback_parent = tmp_path / "fallback-workspaces"
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            runtime_session_store_path=str(tmp_path / "sessions.json"),
            fallback_workspace_parent=str(fallback_parent),
        ),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        first = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        second = await client.create_session(on_permission_request=PermissionHandler.approve_all)

        thread_starts = [params for method, params in fake.requests if method == "thread/start"]
        first_cwd = thread_starts[0]["cwd"]
        second_cwd = thread_starts[1]["cwd"]

        assert first.session_id != second.session_id
        assert first_cwd != second_cwd
        assert first_cwd != os.getcwd()
        assert second_cwd != os.getcwd()
        assert Path(first_cwd).parent == fallback_parent
        assert Path(second_cwd).parent == fallback_parent
        assert Path(first_cwd).is_dir()
        assert Path(second_cwd).is_dir()
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_session_create_preserves_explicit_working_directory(tmp_path):
    fake = FakeCodexGateway()
    fallback_parent = tmp_path / "fallback-workspaces"
    explicit_workspace = tmp_path / "explicit-workspace"
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            runtime_session_store_path=str(tmp_path / "sessions.json"),
            fallback_workspace_parent=str(fallback_parent),
        ),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(
            working_directory=str(explicit_workspace),
            on_permission_request=PermissionHandler.approve_all,
        )

        thread_start = next(params for method, params in fake.requests if method == "thread/start")
        assert thread_start["cwd"] == str(explicit_workspace)
        assert not fallback_parent.exists()
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_network_access_can_be_enabled_for_workspace_sandbox(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            runtime_session_store_path=str(tmp_path / "sessions.json"),
            sandbox_mode="workspaceWrite",
            network_access=True,
        ),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        await session.send_and_wait("Use the network-enabled sandbox policy.", timeout=2)

        turn_start = next(params for method, params in fake.requests if method == "turn/start")
        assert turn_start["sandboxPolicy"] == {
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": True,
            "excludeTmpdirEnvVar": False,
            "excludeSlashTmp": False,
        }
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_image_attachments_are_mapped_to_codex_turn_input(tmp_path):
    image_path = tmp_path / "sample.png"
    image_path.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
            "de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082"
        )
    )
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(tmp_path / "sessions.json")),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        await session.send_and_wait(
            "Describe the attachments.",
            attachments=[
                {"type": "file", "path": str(image_path)},
                {
                    "type": "blob",
                    "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe",
                    "mimeType": "image/png",
                    "displayName": "inline.png",
                },
            ],
            timeout=2,
        )

        turn_start = next(params for method, params in fake.requests if method == "turn/start")
        assert turn_start["input"] == [
            {"type": "text", "text": "Describe the attachments.", "text_elements": []},
            {"type": "localImage", "path": str(image_path), "detail": "auto"},
            {
                "type": "image",
                "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe",
                "detail": "auto",
            },
        ]
        assert any(
            entry["category"] == "turn.lifecycle"
            and entry["event"] == "started"
            and entry["data"]["attachmentCount"] == 2
            and entry["data"]["inputCount"] == 3
            for entry in server.summary()["semanticLog"]
        )
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_logs_but_allows_concurrent_threads_in_same_explicit_workspace(tmp_path):
    fake = FakeCodexGateway()
    explicit_workspace = tmp_path / "shared-workspace"
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(tmp_path / "sessions.json")),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        first = await client.create_session(
            working_directory=str(explicit_workspace),
            on_permission_request=PermissionHandler.approve_all,
        )
        second = await client.create_session(
            working_directory=str(explicit_workspace),
            on_permission_request=PermissionHandler.approve_all,
        )

        assert first.session_id != second.session_id
        assert sum(1 for method, _ in fake.requests if method == "thread/start") == 2

        concurrent_log = next(
            entry
            for entry in server.summary()["adapterTranscript"]
            if entry["direction"] == "adapter.workspace.concurrent_threads"
        )
        assert concurrent_log["message"] == {
            "operation": "create",
            "cwd": str(explicit_workspace),
            "sessionId": second.session_id,
            "threadId": "thread-2",
            "overlappingSessions": [
                {
                    "sessionId": first.session_id,
                    "threadId": "thread-1",
                    "attachedConnectionCount": 1,
                }
            ],
        }
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_protocol_v2_dynamic_tool_call_round_trips_through_tool_call(tmp_path):
    # SDK v1.0.7 removed the legacy direct tool.call client handler and its
    # client refuses protocol-2 servers at handshake, so the adapter now
    # refuses protocol_version=2 loudly at construction.
    with pytest.raises(RuntimeError, match="protocol_version 2 is not supported on SDK v1.0.7"):
        CodexCopilotAdapterServer(
            CodexAdapterOptions(
                protocol_version=2,
                runtime_session_store_path=str(tmp_path / "sessions.json"),
            ),
            gateway=FakeCodexGateway(),
        )

@pytest.mark.asyncio
async def test_protocol_v3_dynamic_tool_call_round_trips_through_pending_tool_call(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Lookup source data")
        def lookup(args):
            return f"lookup:{args['query']}"

        await client.create_session(
            on_permission_request=PermissionHandler.approve_all, tools=[lookup]
        )
        result = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "lookup",
                "callId": "call-1",
                "arguments": {"query": "v3"},
            },
        )
        assert result["result"] == {
            "contentItems": [{"type": "inputText", "text": "lookup:v3"}],
            "success": True,
        }
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_codex_native_events_are_forwarded_as_sdk_session_events(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        captured = []

        @define_tool(description="Lookup source data")
        def lookup(args):
            return f"lookup:{args['query']}"

        session = await client.create_session(
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=[lookup],
        )
        session.on(captured.append)

        fake.notification_handler(
            {
                "method": "turn/started",
                "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "running"}},
            }
        )
        fake.notification_handler(
            {
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "thread-1",
                    "itemId": "assistant-1",
                    "delta": "我先確認工具和資料。",
                },
            }
        )
        fake.notification_handler(
            {
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "tokenUsage": {
                        "last": {
                            "inputTokens": 12,
                            "outputTokens": 7,
                            "cachedInputTokens": 3,
                            "reasoningOutputTokens": 2,
                        },
                        "modelContextWindow": 128000,
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/started",
                "params": {
                    "threadId": "thread-1",
                    "item": {
                        "id": "call-1",
                        "type": "dynamicToolCall",
                        "toolName": "lookup",
                        "arguments": {"query": "v3"},
                    },
                },
            }
        )
        result = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "toolName": "lookup",
                "callId": "call-1",
                "arguments": {"query": "v3"},
            },
        )
        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "item": {
                        "id": "call-1",
                        "type": "dynamicToolCall",
                        "toolName": "lookup",
                        "status": "completed",
                        "success": True,
                        "durationMs": 25,
                        "contentItems": [{"type": "inputText", "text": "lookup:v3"}],
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "item": {"id": "reasoning-empty", "type": "reasoning", "content": []},
                },
            }
        )
        fake.notification_handler(
            {
                "method": "turn/completed",
                "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}},
            }
        )

        await _wait_for_event_types(
            captured,
            {
                "assistant.turn_start",
                "assistant.message_delta",
                "assistant.usage",
                "tool.execution_start",
                "assistant.message",
                "tool.execution_complete",
                "codex.raw",
                "assistant.turn_end",
                "session.idle",
            },
        )

        assert result["result"] == {
            "contentItems": [{"type": "inputText", "text": "lookup:v3"}],
            "success": True,
        }
        by_type = {_event_type(event): event for event in captured}

        assert by_type["assistant.turn_start"].data.turn_id == "turn-1"
        assert by_type["assistant.message_delta"].data.message_id == "assistant-1"
        assert by_type["assistant.message_delta"].data.delta_content == "我先確認工具和資料。"
        assert by_type["assistant.usage"].data.input_tokens == 12
        assert by_type["assistant.usage"].data.output_tokens == 7
        # v1.0.7 schema note: AssistantUsageData has no turnId field (the fork
        # hand-patched it in). The adapter still emits turnId on the wire, but
        # the typed python parser drops it; turn correlation for typed
        # consumers relies on assistant.turn_start/turn_end instead.
        assert not hasattr(by_type["assistant.usage"].data, "turn_id") or (
            by_type["assistant.usage"].data.turn_id is None
        )
        assert by_type["tool.execution_start"].data.tool_name == "lookup"
        assert by_type["tool.execution_start"].data.tool_call_id == "call-1"

        tool_request_event = next(
            event
            for event in captured
            if _event_type(event) == "assistant.message" and event.data.tool_requests
        )
        assert tool_request_event.data.phase == "tool_call"
        assert tool_request_event.data.tool_requests[0].name == "lookup"
        assert tool_request_event.data.tool_requests[0].tool_call_id == "call-1"
        assert tool_request_event.data.tool_requests[0].arguments == {"query": "v3"}

        complete = by_type["tool.execution_complete"].data
        assert complete.tool_call_id == "call-1"
        assert complete.success is True
        assert complete.result.content == "lookup:v3"
        assert complete.tool_telemetry["toolName"] == "lookup"

        raw = by_type["codex.raw"]
        assert raw.type.value == "unknown"
        assert raw.raw_type == "codex.raw"
        assert raw.data.raw["reason"] == "reasoning_completed_without_readable_content"
        assert raw.data.raw["method"] == "item/completed"
        assert by_type["assistant.turn_end"].data.turn_id == "turn-1"

        semantic_events = {
            (entry["category"], entry["event"]) for entry in server.summary()["semanticLog"]
        }
        assert ("assistant.message", "delta") in semantic_events
        assert ("assistant.usage", "updated") in semantic_events
        assert ("tool.execution", "codex_started") in semantic_events
        assert ("tool.execution", "codex_completed") in semantic_events
        assert ("codex.raw", "item.completed") in semantic_events
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_unmapped_raw_response_items_are_forwarded_as_codex_raw(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        captured = []
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        session.on(captured.append)

        fake.notification_handler(
            {
                "method": "rawResponseItem/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "message",
                        "id": "msg-raw-1",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "done"}],
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "rawResponseItem/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "reasoning",
                        "id": "reasoning-raw-1",
                        "summary": [],
                        "content": [],
                    },
                },
            }
        )

        await _wait_for_event_types(captured, {"codex.raw"})
        raw_events = [event for event in captured if _event_type(event) == "codex.raw"]
        assert [event.data.raw["itemType"] for event in raw_events] == ["message", "reasoning"]
        assert raw_events[0].data.raw["turnId"] == "turn-1"
        assert raw_events[0].data.raw["itemId"] == "msg-raw-1"
        assert raw_events[0].data.raw["reason"] == "raw_response_item_message_provenance"
        assert raw_events[1].data.raw["itemId"] == "reasoning-raw-1"
        assert raw_events[1].data.raw["reason"] == "raw_response_item_reasoning_provenance"

        semantic = server.summary()["semanticLog"]
        raw_semantic = [
            entry
            for entry in semantic
            if entry["category"] == "codex.raw"
            and entry["event"] == "rawResponseItem.completed"
        ]
        assert [entry["data"]["itemType"] for entry in raw_semantic] == [
            "message",
            "reasoning",
        ]
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_codex_raw_function_call_events_are_forwarded_as_typed_tool_events(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        captured = []
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        session.on(captured.append)

        fake.notification_handler(
            {
                "method": "rawResponseItem/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "call-raw-1",
                        "arguments": '{"cmd":"pwd","workdir":"/tmp/demo"}',
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/started",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "commandExecution",
                        "id": "call-raw-1",
                        "command": "/bin/zsh -lc pwd",
                        "status": "inProgress",
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/commandExecution/outputDelta",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "call-raw-1",
                    "delta": "/tmp/demo\n",
                },
            }
        )
        fake.notification_handler(
            {
                "method": "rawResponseItem/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "function_call_output",
                        "call_id": "call-raw-1",
                        "output": (
                            "Chunk ID: abc\nWall time: 0.0000 seconds\n"
                            "Process exited with code 0\nOutput:\n/tmp/demo\n"
                        ),
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "commandExecution",
                        "id": "call-raw-1",
                        "status": "completed",
                        "exitCode": 0,
                    },
                },
            }
        )

        await _wait_for_event_types(
            captured,
            {
                "tool.execution_start",
                "tool.execution_partial_result",
                "tool.execution_complete",
            },
        )

        starts = [event for event in captured if _event_type(event) == "tool.execution_start"]
        completes = [event for event in captured if _event_type(event) == "tool.execution_complete"]
        assert len(starts) == 1
        assert len(completes) == 1
        assert starts[0].data.tool_name == "exec_command"
        assert starts[0].data.tool_call_id == "call-raw-1"
        assert starts[0].data.arguments == {"cmd": "pwd", "workdir": "/tmp/demo"}
        partial = next(event for event in captured if _event_type(event) == "tool.execution_partial_result")
        assert partial.data.partial_output == "/tmp/demo\n"
        complete = completes[0].data
        assert complete.success is True
        assert complete.result.content.endswith("/tmp/demo\n")
        assert complete.tool_telemetry["toolName"] == "exec_command"
        assert complete.tool_telemetry["source"] == "rawResponseItem"
        assert complete.tool_telemetry["outputChars"] > 0
        assert complete.tool_telemetry["exitCode"] == 0
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_codex_mcp_tool_call_events_are_forwarded_as_typed_tool_events(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        captured = []
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        session.on(captured.append)

        fake.notification_handler(
            {
                "method": "item/started",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "mcpToolCall",
                        "id": "call-mcp-1",
                        "server": "codex",
                        "tool": "list_mcp_resources",
                        "status": "inProgress",
                        "arguments": {"cursor": "abc"},
                    },
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "type": "mcpToolCall",
                        "id": "call-mcp-1",
                        "server": "codex",
                        "tool": "list_mcp_resources",
                        "status": "completed",
                        "arguments": {"cursor": "abc"},
                        "result": {
                            "content": [
                                {"type": "text", "text": '{"resources":[{"name":"demo"}]}'}
                            ]
                        },
                        "error": None,
                        "durationMs": 11,
                    },
                },
            }
        )

        await _wait_for_event_types(
            captured,
            {
                "tool.execution_start",
                "tool.execution_complete",
            },
        )

        start = next(event for event in captured if _event_type(event) == "tool.execution_start")
        complete = next(event for event in captured if _event_type(event) == "tool.execution_complete")
        assert start.data.tool_name == "codex.list_mcp_resources"
        assert start.data.mcp_server_name == "codex"
        assert start.data.mcp_tool_name == "list_mcp_resources"
        assert start.data.arguments == {"cursor": "abc"}
        assert complete.data.success is True
        assert complete.data.result.content == '{"resources":[{"name":"demo"}]}'
        assert complete.data.tool_telemetry["mcpServerName"] == "codex"
        assert complete.data.tool_telemetry["mcpToolName"] == "list_mcp_resources"
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_experimental_raw_events_option_is_sent_to_codex_thread_only(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            runtime_session_store_path=str(tmp_path / "sessions.json"),
            experimental_raw_events=True,
        ),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        await session.send_and_wait("hello", timeout=2)

        thread_start = next(params for method, params in fake.requests if method == "thread/start")
        turn_start = next(params for method, params in fake.requests if method == "turn/start")
        assert thread_start["experimentalRawEvents"] is True
        assert "experimentalRawEvents" not in turn_start
        assert server.summary()["options"]["experimentalRawEvents"] is True
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_protocol_v3_oversized_dynamic_tool_result_fails_fast(adapter, monkeypatch):
    monkeypatch.setenv("CODEX_ADAPTER_DYNAMIC_TOOL_TEXT_CHAR_LIMIT", "1000")
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        result_text = "x" * 1200

        @define_tool(description="Return oversized source data")
        def oversized_lookup(_args):
            return ToolResult(text_result_for_llm=result_text, result_type="success")

        await client.create_session(
            on_permission_request=PermissionHandler.approve_all, tools=[oversized_lookup]
        )
        result = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "oversized_lookup",
                "callId": "oversized-call-1",
                "arguments": {},
            },
        )

        tool_response = result["result"]
        assert tool_response["success"] is False
        text = tool_response["contentItems"][0]["text"]
        assert "Tool result was too large" in text
        assert "1200 chars" in text
        assert result_text not in text
    finally:
        await client.force_stop()


def _event_type(event) -> str:
    return event.raw_type if event.type.value == "unknown" and event.raw_type else event.type.value


async def _wait_for_event_types(captured, expected: set[str], timeout: float = 1.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        seen = {_event_type(event) for event in captured}
        if expected <= seen:
            return
        await asyncio.sleep(0.01)
    seen = [_event_type(event) for event in captured]
    raise AssertionError(f"missing events {sorted(expected - set(seen))}; saw {seen}")


@pytest.mark.asyncio
async def test_resume_after_restart_rejects_missing_tool_fingerprint_before_thread_resume(tmp_path):
    store_path = str(tmp_path / "sessions.json")
    fake_one = FakeCodexGateway()
    first = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path), gateway=fake_one
    )
    await first.start()
    client_one = CopilotClient(connection=RuntimeConnection.for_uri(first.cli_url()))
    await client_one.start()

    @define_tool(description="Lookup source data")
    def lookup(args):
        return f"lookup:{args['query']}"

    session = await client_one.create_session(
        on_permission_request=PermissionHandler.approve_all, tools=[lookup]
    )
    await client_one.force_stop()
    await first.stop()

    fake_two = FakeCodexGateway()
    second = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path), gateway=fake_two
    )
    await second.start()
    client_two = CopilotClient(connection=RuntimeConnection.for_uri(second.cli_url()))
    await client_two.start()
    try:
        with pytest.raises(Exception, match="matching tools are required"):
            await client_two.resume_session(
                session.session_id, on_permission_request=PermissionHandler.approve_all
            )
        assert not any(method == "thread/resume" for method, _ in fake_two.requests)
    finally:
        await client_two.force_stop()
        await second.stop()


@pytest.mark.asyncio
async def test_characterizes_create_send_destroy_resume_and_delete_lifecycle(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(tmp_path / "sessions.json")),
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
        thread_start = next(params for method, params in fake.requests if method == "thread/start")
        assert thread_start["model"] == "gpt-test"
        assert (
            thread_start["baseInstructions"]
            == "You are the adapter characterization test assistant."
        )
        assert thread_start["ephemeral"] is False

        assistant = await session.send_and_wait("Reply through the fake Codex gateway.", timeout=2)
        events = await session.get_events()
        event_types = {event.type.value for event in events}
        turn_start = next(params for method, params in fake.requests if method == "turn/start")

        assert assistant is not None
        assert assistant.data.content == "adapter characterization reply"
        assert turn_start["threadId"] == "thread-1"
        assert turn_start["model"] == "gpt-test"
        assert {"session.start", "user.message", "assistant.message", "session.idle"} <= event_types

        await session.disconnect()
        await session.disconnect()
        assert sum(1 for method, _ in fake.requests if method == "thread/unsubscribe") == 1

        resumed = await client.resume_session(
            session.session_id,
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
        )
        assert any(
            method == "thread/resume" and params["threadId"] == "thread-1"
            for method, params in fake.requests
        )

        await client.delete_session(session.session_id)
        assert any(
            method == "thread/archive" and params["threadId"] == "thread-1"
            for method, params in fake.requests
        )

        with pytest.raises(Exception, match="Unknown session"):
            await client.resume_session(
                resumed.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
            )
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_session_abort_invalidates_session_and_restarts_gateway(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=str(tmp_path / "sessions.json")),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-test", on_permission_request=PermissionHandler.approve_all
        )

        await session.abort()

        assert fake.stop_count == 1
        assert fake.start_count == 2
        assert server.summary()["sessions"] == []
        semantic_events = {
            (entry["category"], entry["event"]) for entry in server.summary()["semanticLog"]
        }
        assert ("session.lifecycle", "aborted") in semantic_events
        with pytest.raises(Exception, match="Unknown session"):
            await client.resume_session(
                session.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
            )
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_resume_after_restart_uses_persisted_runtime_mapping(tmp_path):
    store_path = str(tmp_path / "sessions.json")
    first_gateway = FakeCodexGateway()
    first_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=first_gateway,
    )
    await first_server.start()
    first_client = CopilotClient(connection=RuntimeConnection.for_uri(first_server.cli_url()))
    await first_client.start()

    session = await first_client.create_session(
        model="gpt-test",
        reasoning_effort="high",
        on_permission_request=PermissionHandler.approve_all,
    )
    session_id = session.session_id
    await session.disconnect()
    await first_client.force_stop()
    await first_server.stop()

    second_gateway = FakeCodexGateway()
    second_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=second_gateway,
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
        assert not any(method == "thread/start" for method, _ in second_gateway.requests)
        assert any(method == "thread/resume" for method, _ in second_gateway.requests)

        assistant = await resumed.send_and_wait("Continue after adapter restart.", timeout=2)
        assert assistant is not None
        assert assistant.data.content == "adapter characterization reply"
        turn_start = next(
            params for method, params in second_gateway.requests if method == "turn/start"
        )
        assert turn_start["reasoningEffort"] == "high"
        assert second_server.summary()["sessions"][0]["reasoningEffort"] == "high"
    finally:
        await second_client.force_stop()
        await second_server.stop()


@pytest.mark.asyncio
async def test_rejects_in_memory_resume_when_tool_set_changes(adapter):
    server, fake = adapter
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

        with pytest.raises(
            Exception, match="tool set is incompatible with the active runtime session"
        ):
            await client.resume_session(
                session.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
                tools=[changed_tool],
            )
        assert not any(method == "thread/resume" for method, _ in fake.requests)
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_resume_after_restart_rejects_incompatible_tool_fingerprint(tmp_path):
    store_path = str(tmp_path / "sessions.json")
    first_gateway = FakeCodexGateway()
    first_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=first_gateway,
    )
    await first_server.start()
    first_client = CopilotClient(connection=RuntimeConnection.for_uri(first_server.cli_url()))
    await first_client.start()

    @define_tool(description="Original persisted tool")
    def original_restart_tool(_args):
        return "original"

    session = await first_client.create_session(
        model="gpt-test",
        on_permission_request=PermissionHandler.approve_all,
        tools=[original_restart_tool],
    )
    await session.disconnect()
    await first_client.force_stop()
    await first_server.stop()

    second_gateway = FakeCodexGateway()
    second_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=second_gateway,
    )
    await second_server.start()
    second_client = CopilotClient(connection=RuntimeConnection.for_uri(second_server.cli_url()))
    await second_client.start()
    try:

        @define_tool(description="Changed persisted tool")
        def changed_restart_tool(_args):
            return "changed"

        with pytest.raises(
            Exception, match="tool set is incompatible with the persisted runtime session"
        ):
            await second_client.resume_session(
                session.session_id,
                model="gpt-test",
                on_permission_request=PermissionHandler.approve_all,
                tools=[changed_restart_tool],
            )
        assert not any(method == "thread/resume" for method, _ in second_gateway.requests)
    finally:
        await second_client.force_stop()
        await second_server.stop()


@pytest.mark.asyncio
async def test_command_approval_round_trips_through_permission_handler(adapter):
    server, fake = adapter
    seen_requests = []

    def approve_shell(request, _invocation):
        seen_requests.append(request.to_dict())
        return PermissionDecisionApproveOnce()

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=approve_shell)
        result = await fake.emit_request(
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

        assert result["result"] == {"decision": "accept"}
        # The handler receives the typed PermissionRequestShell; to_dict() is the
        # v1.0.7 canonical serialization (key-sorted, kind included).
        assert seen_requests == [
            {
                "canOfferSessionApproval": True,
                "commands": [{"identifier": "zsh", "readOnly": False}],
                "fullCommandText": "zsh -lc 'echo hello > /tmp/probe'",
                "hasWriteFileRedirection": True,
                "intention": "Need to write the approval probe.",
                "kind": "shell",
                "possiblePaths": [],
                "possibleUrls": [],
                "toolCallId": "command-1",
            }
        ]

        # v1.0.7 delivery: one permission.requested event out, one
        # handlePendingPermissionRequest completion back — and no legacy
        # direct permission.request requests at all.
        transcript = server.summary()["adapterTranscript"]
        event_deliveries = [
            entry
            for entry in transcript
            if entry["direction"] == "adapter->sdk.event"
            and isinstance(entry["message"], dict)
            and entry["message"].get("method") == "permission.requested"
        ]
        assert len(event_deliveries) == 1
        completions = [
            entry for entry in transcript if entry["direction"] == "adapter.permission.completed"
        ]
        assert len(completions) == 1
        assert completions[0]["message"]["decision"] == "accept"
        legacy_requests = [
            entry
            for entry in transcript
            if isinstance(entry["message"], dict)
            and entry["message"].get("method") == "permission.request"
        ]
        assert legacy_requests == []
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_command_approval_denial_round_trips_to_decline(adapter):
    server, fake = adapter

    def deny_shell(_request, _invocation):
        return PermissionDecisionDeniedByRules(rules=[])

    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        await client.create_session(model="gpt-test", on_permission_request=deny_shell)
        result = await fake.emit_request(
            "item/commandExecution/requestApproval",
            {
                "threadId": "thread-1",
                "itemId": "command-2",
                "command": "zsh -lc 'echo denied'",
                "availableDecisions": ["accept", "acceptForSession"],
            },
        )
        assert result["result"] == {"decision": "decline"}
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_file_approval_round_trips_through_permission_handler(adapter):
    server, fake = adapter
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
        result = await fake.emit_request(
            "item/fileChange/requestApproval",
            {"threadId": "thread-1", "itemId": "file-1"},
        )

        assert result["result"] == {"decision": "accept"}
        # The handler receives the typed PermissionRequestWrite. The adapter's
        # extra keys (paths/changes/grantRoot) are not part of the v1.0.7
        # write-kind schema and are dropped by the typed parser; the required
        # canOfferSessionApproval/diff/fileName fields are adapter-filled.
        assert seen_requests == [
            {
                "canOfferSessionApproval": False,
                "diff": "",
                "fileName": "/tmp/allowed.txt",
                "intention": "Apply file changes outside the current approval boundary.",
                "kind": "write",
                "toolCallId": "file-1",
            }
        ]
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_file_approval_denial_round_trips_to_decline(adapter):
    server, fake = adapter

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
        result = await fake.emit_request(
            "item/fileChange/requestApproval",
            {"threadId": "thread-1", "itemId": "file-2"},
        )
        assert result["result"] == {"decision": "decline"}
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_protocol_v3_dynamic_tool_denial_and_failure_results_round_trip(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Deliberately deny a tool call")
        def deny_tool(_args):
            return ToolResult(text_result_for_llm="tool denied", result_type="denied")

        @define_tool(description="Raise a deterministic error")
        def fail_tool(_args):
            raise RuntimeError("tool failed hard")

        await client.create_session(
            on_permission_request=PermissionHandler.approve_all,
            tools=[deny_tool, fail_tool],
        )

        denied = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "deny_tool",
                "callId": "deny-call-1",
                "arguments": {},
            },
        )
        failed = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "fail_tool",
                "callId": "fail-call-1",
                "arguments": {},
            },
        )

        assert denied["result"] == {
            "contentItems": [{"type": "inputText", "text": "tool denied"}],
            "success": False,
        }
        assert failed["result"] == {
            "contentItems": [
                {
                    "type": "inputText",
                    "text": "tool failed hard",
                }
            ],
            "success": False,
        }
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_protocol_v3_dynamic_tool_timeout_records_timeout_transcript(tmp_path):
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            request_timeout_ms=10,
            runtime_session_store_path=str(tmp_path / "sessions.json"),
        ),
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

        assert result["result"] == {
            "contentItems": [
                {
                    "type": "inputText",
                    "text": "Timed out waiting for SDK tool result: slow_tool",
                }
            ],
            "success": False,
        }
        assert any(
            entry["direction"] == "adapter.tool.timeout"
            and entry["message"]["toolName"] == "slow_tool"
            for entry in server.summary()["adapterTranscript"]
        )
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_dynamic_tool_request_errors_are_explicit(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:

        @define_tool(description="Lookup source data")
        def lookup(_args):
            return "lookup"

        await client.create_session(
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

        assert (
            missing_thread["result"]["contentItems"][0]["text"]
            == "dynamic tool request missing threadId"
        )
        assert (
            missing_name["result"]["contentItems"][0]["text"]
            == "dynamic tool request missing tool name"
        )
        assert (
            unknown_tool["result"]["contentItems"][0]["text"]
            == "dynamic tool not_registered is not registered with the SDK session"
        )
        assert (
            no_connection["result"]["contentItems"][0]["text"]
            == "dynamic tool request has no SDK connection"
        )
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_tool_metadata_round_trips_through_store_and_restart(tmp_path):
    store_path = str(tmp_path / "sessions.json")
    metadata_bag = {"tekric:topic": "codex-adapter-v107", "tekric:window": "w1"}

    def make_tools():
        @define_tool(description="Lookup source data", metadata=metadata_bag)
        def lookup(args):
            return f"lookup:{args['query']}"

        return [lookup]

    first_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=FakeCodexGateway(),
    )
    await first_server.start()
    first_client = CopilotClient(connection=RuntimeConnection.for_uri(first_server.cli_url()))
    await first_client.start()

    session = await first_client.create_session(
        model="gpt-test",
        on_permission_request=PermissionHandler.approve_all,
        tools=make_tools(),
    )
    session_id = session.session_id

    # Live outlet: summary() exposes the bag untouched.
    live = first_server.summary()["sessions"][0]["tools"]
    assert live == [{"name": "lookup", "metadata": metadata_bag}]

    await session.disconnect()
    await first_client.force_stop()
    await first_server.stop()

    # Persistence: the store file carries toolMetadata keyed by tool name.
    stored = json.loads(Path(store_path).read_text())
    record = next(r for r in stored["records"] if r["sdkSessionId"] == session_id)
    assert record["toolMetadata"] == {"lookup": metadata_bag}

    # Restart-resume: metadata still present (and excluded from the tool
    # fingerprint, so the resume is accepted).
    second_server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path),
        gateway=FakeCodexGateway(),
    )
    await second_server.start()
    second_client = CopilotClient(connection=RuntimeConnection.for_uri(second_server.cli_url()))
    await second_client.start()
    try:
        await second_client.resume_session(
            session_id,
            model="gpt-test",
            on_permission_request=PermissionHandler.approve_all,
            tools=make_tools(),
        )
        resumed = second_server.summary()["sessions"][0]["tools"]
        assert resumed == [{"name": "lookup", "metadata": metadata_bag}]
    finally:
        await second_client.force_stop()
        await second_server.stop()


@pytest.mark.asyncio
async def test_unmapped_codex_notifications_are_counted_and_queryable(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-test", on_permission_request=PermissionHandler.approve_all
        )
        captured = []
        session.on(lambda event: captured.append(event))

        for _ in range(2):
            fake.notification_handler(
                {
                    "method": "thread/compact/started",
                    "params": {"threadId": "thread-1", "phase": "warmup"},
                }
            )
        fake.notification_handler(
            {
                "method": "item/started",
                "params": {
                    "threadId": "thread-1",
                    "item": {"type": "todoList", "id": "todo-1"},
                },
            }
        )

        await _wait_for_event_types(captured, {"codex.raw"})

        summary = server.unmapped_events_summary()
        assert summary["thread/compact/started"]["count"] == 2
        assert summary["thread/compact/started"]["paramsKeys"] == ["phase", "threadId"]
        assert summary["thread/compact/started"]["firstReason"] == "unmapped_codex_notification"
        assert summary["item/started:todoList"]["count"] == 1
        # Aggregate meter coexists with the per-event codex.raw channel.
        raw_events = [event for event in captured if _event_type(event) == "codex.raw"]
        assert len(raw_events) >= 1
        # Wire outlet on status.get (the typed GetStatusResponse drops unknown
        # fields, so assert at the served-handler level).
        status_payload = server._handle_status_get({}, "test")
        assert status_payload["unmappedEvents"]["thread/compact/started"]["count"] == 2
        assert server.summary()["unmappedEvents"]["item/started:todoList"]["count"] == 1
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_reasoning_record_entries_are_extracted(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-test", on_permission_request=PermissionHandler.approve_all
        )
        captured = []
        session.on(lambda event: captured.append(event))

        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "item": {
                        "type": "reasoning",
                        "id": "rs-record",
                        "summary": [{"type": "summary_text", "text": "planning the fix"}],
                        "content": [],
                    },
                },
            }
        )

        await _wait_for_event_types(captured, {"assistant.reasoning"})
        reasoning = next(
            event for event in captured if _event_type(event) == "assistant.reasoning"
        )
        assert reasoning.data.content == "planning the fix"
        assert reasoning.data.reasoning_id == "rs-record"
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_file_change_items_map_to_tool_and_workspace_events(adapter):
    server, fake = adapter
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        session = await client.create_session(
            model="gpt-test", on_permission_request=PermissionHandler.approve_all
        )
        captured = []
        session.on(lambda event: captured.append(event))

        changes = [
            {"path": "/tmp/ws/new.txt", "kind": {"type": "add"}, "diff": "new content\n"},
            {
                "path": "/tmp/ws/old.txt",
                "kind": {"type": "update", "move_path": None},
                "diff": "@@ -1 +1 @@\n-a\n+b\n",
            },
        ]
        fake.notification_handler(
            {
                "method": "item/started",
                "params": {
                    "threadId": "thread-1",
                    "item": {"type": "fileChange", "id": "fc-1", "changes": changes},
                },
            }
        )
        fake.notification_handler(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "item": {
                        "type": "fileChange",
                        "id": "fc-1",
                        "changes": changes,
                        "status": "completed",
                    },
                },
            }
        )

        await _wait_for_event_types(
            captured,
            {"tool.execution_start", "tool.execution_complete", "session.workspace_file_changed"},
        )

        start = next(event for event in captured if _event_type(event) == "tool.execution_start")
        assert start.data.tool_name == "apply_patch"
        assert start.data.tool_call_id == "fc-1"

        complete = next(
            event for event in captured if _event_type(event) == "tool.execution_complete"
        )
        assert complete.data.tool_call_id == "fc-1"
        assert complete.data.success is True
        assert complete.data.result.content == "add /tmp/ws/new.txt\nupdate /tmp/ws/old.txt"
        assert complete.data.result.detailed_content == "new content\n\n@@ -1 +1 @@\n-a\n+b\n"

        workspace = [
            event
            for event in captured
            if _event_type(event) == "session.workspace_file_changed"
        ]
        assert [(event.data.operation.value, event.data.path) for event in workspace] == [
            ("create", "/tmp/ws/new.txt"),
            ("update", "/tmp/ws/old.txt"),
        ]

        # Nothing from this flow leaked into the unmapped meter.
        assert "item/started:fileChange" not in server.unmapped_events_summary()
        assert "item/completed:fileChange" not in server.unmapped_events_summary()
    finally:
        await client.force_stop()
