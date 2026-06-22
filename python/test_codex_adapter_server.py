from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from copilot import CopilotClient, ExternalServerConfig, PermissionHandler, define_tool
from copilot.codex_adapter.gateway import (
    CodexAppServerGateway,
    CodexAppServerGatewayOptions,
    CodexAppServerGatewayReaderError,
)
from copilot.codex_adapter.server import CodexAdapterOptions, CodexCopilotAdapterServer
from copilot.generated.rpc import ModelSwitchToRequest
from copilot.session import PermissionRequestResult
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
    await client.start()
    try:
        ping = await client.ping("python")
        status = await client.get_status()
        auth = await client.get_auth_status()
        models = await client.list_models()
        session = await client.create_session(on_permission_request=PermissionHandler.approve_all)
        response = await session.send_and_wait("hello", timeout=2)
        messages = await session.get_messages()

        assert ping.message == "pong: python"
        assert status.protocolVersion == 3
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
async def test_model_switch_keeps_session_and_updates_turn_start_reasoning(adapter):
    server, fake = adapter
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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

        messages = await session.get_messages()
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
        messages = await session.get_messages()
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    fake = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(
            protocol_version=2, runtime_session_store_path=str(tmp_path / "sessions.json")
        ),
        gateway=fake,
    )
    await server.start()
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
    await client.start()
    try:
        result_text = "lookup:v2 " + ("result-preview-" * 30)

        @define_tool(description="Lookup source data")
        def lookup(args):
            assert args["api_token"] == "sk-" + ("secret" * 8)
            return ToolResult(text_result_for_llm=result_text, result_type="success")

        await client.create_session(
            on_permission_request=PermissionHandler.approve_all, tools=[lookup]
        )
        result = await fake.emit_request(
            "item/tool/call",
            {
                "threadId": "thread-1",
                "tool": "lookup",
                "callId": "call-1",
                "arguments": {
                    "query": "v2",
                    "api_token": "sk-" + ("secret" * 8),
                    "long_note": "argument preview " * 30,
                },
            },
        )
        assert result["result"] == {
            "contentItems": [{"type": "inputText", "text": result_text}],
            "success": True,
        }
        semantic_log = server.summary()["semanticLog"]
        semantic_events = {(entry["category"], entry["event"]) for entry in semantic_log}
        assert ("tool.routing", "requested") in semantic_events
        assert ("tool.sdk_call", "dispatched") in semantic_events
        assert ("tool.sdk_result", "received") in semantic_events
        routing_entry = next(entry for entry in semantic_log if entry["category"] == "tool.routing")
        assert routing_entry["data"]["argumentsPreview"]["query"] == "v2"
        assert routing_entry["data"]["argumentsPreview"]["api_token"] == "[redacted]"
        assert routing_entry["data"]["argumentsPreview"]["long_note"].endswith("...")
        assert routing_entry["data"]["argumentsPreviewRedacted"] is True
        assert routing_entry["data"]["argumentsPreviewTruncated"] is True
        result_entry = next(
            entry for entry in semantic_log if entry["category"] == "tool.sdk_result"
        )
        assert result_entry["data"]["resultPreview"]["textResultForLlm"].startswith("lookup:v2")
        assert result_entry["data"]["resultPreview"]["textResultForLlm"].endswith("...")
        assert result_entry["data"]["resultPreviewTruncated"] is True
    finally:
        await client.force_stop()
        await server.stop()


@pytest.mark.asyncio
async def test_protocol_v3_dynamic_tool_call_round_trips_through_pending_tool_call(adapter):
    server, fake = adapter
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
async def test_codex_raw_function_call_events_are_forwarded_as_typed_tool_events(adapter):
    server, fake = adapter
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client_one = CopilotClient(ExternalServerConfig(url=first.cli_url()))
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
    client_two = CopilotClient(ExternalServerConfig(url=second.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
        events = await session.get_messages()
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    first_client = CopilotClient(ExternalServerConfig(url=first_server.cli_url()))
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
    second_client = CopilotClient(ExternalServerConfig(url=second_server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    first_client = CopilotClient(ExternalServerConfig(url=first_server.cli_url()))
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
    second_client = CopilotClient(ExternalServerConfig(url=second_server.cli_url()))
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
        return PermissionRequestResult(kind="approved")

    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
        assert seen_requests == [
            {
                "kind": "shell",
                "toolCallId": "command-1",
                "intention": "Need to write the approval probe.",
                "canOfferSessionApproval": True,
                "fullCommandText": "zsh -lc 'echo hello > /tmp/probe'",
                "hasWriteFileRedirection": True,
                "commands": [{"identifier": "zsh", "readOnly": False}],
                "possiblePaths": [],
                "possibleUrls": [],
            }
        ]

        transcript_methods = [
            entry["message"]["method"]
            for entry in server.summary()["adapterTranscript"]
            if entry["direction"] in {"adapter->sdk.request", "sdk->adapter.response"}
            and isinstance(entry["message"], dict)
            and entry["message"].get("method") == "permission.request"
        ]
        assert transcript_methods == ["permission.request", "permission.request"]
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_command_approval_denial_round_trips_to_decline(adapter):
    server, fake = adapter

    def deny_shell(_request, _invocation):
        return PermissionRequestResult(kind="denied-by-rules")

    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
        return PermissionRequestResult(kind="approved")

    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
        assert seen_requests == [
                {
                    "kind": "write",
                    "toolCallId": "file-1",
                    "intention": "Apply file changes outside the current approval boundary.",
                    "paths": ["/tmp/allowed.txt"],
                    "possiblePaths": ["/tmp/allowed.txt"],
                    "changes": [
                        {"path": "/tmp/allowed.txt"},
                        {"kind": "metadata-without-path"},
                ],
            }
        ]
    finally:
        await client.force_stop()


@pytest.mark.asyncio
async def test_file_approval_denial_round_trips_to_decline(adapter):
    server, fake = adapter

    def deny_write(_request, _invocation):
        return PermissionRequestResult(kind="denied-interactively-by-user")

    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
    client = CopilotClient(ExternalServerConfig(url=server.cli_url()))
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
