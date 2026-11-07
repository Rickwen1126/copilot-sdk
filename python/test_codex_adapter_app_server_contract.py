"""Every key the adapter sends to `codex app-server` must exist in its schema.

The app-server silently drops unknown request keys, so a misnamed field looks
like success: the adapter sent `reasoningEffort` on turn/start for months while
Codex 0.161.0 only reads `effort`, and every session ran at the model default.
The fake gateway accepts anything, so this test checks the requests against a
schema snapshot taken from the pinned Codex (see
scripts/snapshot_codex_app_server_params.py).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from copilot import CopilotClient, PermissionHandler, RuntimeConnection, define_tool
from copilot.codex_adapter.server import CodexAdapterOptions, CodexCopilotAdapterServer
from copilot.generated.rpc import ModelSwitchToRequest
from copilot.tools import ToolResult
from test_codex_adapter_server import FakeCodexGateway

CODEX_SCHEMA_VERSION = "0.161.0"
SCHEMA_PATH = (
    Path(__file__).parent / "test_fixtures" / f"codex_app_server_params_{CODEX_SCHEMA_VERSION}.json"
)
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

# Keys the adapter sends today that the pinned schema does not define. They are
# dropped by the app-server; listed here so they stay a visible decision rather
# than passing silently. Do not add an effort key here.
KNOWN_IGNORED: dict[str, set[str]] = {
    "thread/start": {"persistExtendedHistory"},
}


def _unknown_keys(requests: list[tuple[str, dict]]) -> dict[str, set[str]]:
    unknown: dict[str, set[str]] = {}
    for method, params in requests:
        allowed = SCHEMA["methods"].get(method)
        if allowed is None or not isinstance(params, dict):
            continue
        extra = set(params) - set(allowed) - KNOWN_IGNORED.get(method, set())
        if extra:
            unknown.setdefault(method, set()).update(extra)
    return unknown


@pytest.mark.asyncio
async def test_codex_requests_only_use_schema_keys_across_create_switch_and_resume(tmp_path):
    store_path = str(tmp_path / "sessions.json")
    first = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path), gateway=first
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()

    @define_tool(description="Echo", skip_permission=True)
    def echo(params: dict) -> ToolResult:
        return ToolResult(text_result_for_llm="ok", result_type="success")

    try:
        session = await client.create_session(
            model="gpt-test",
            reasoning_effort="high",
            system_message={"mode": "append", "content": "contract probe"},
            tools=[echo],
            on_permission_request=PermissionHandler.approve_all,
        )
        await session.send_and_wait("first", timeout=2)
        await session.rpc.model.switch_to(
            ModelSwitchToRequest(model_id="gpt-test-2", reasoning_effort="low")
        )
        await session.send_and_wait("second", timeout=2)
        session_id = session.session_id
        await session.disconnect()
    finally:
        await client.force_stop()
        await server.stop()

    second = FakeCodexGateway()
    server = CodexCopilotAdapterServer(
        CodexAdapterOptions(runtime_session_store_path=store_path), gateway=second
    )
    await server.start()
    client = CopilotClient(connection=RuntimeConnection.for_uri(server.cli_url()))
    await client.start()
    try:
        resumed = await client.resume_session(
            session_id, tools=[echo], on_permission_request=PermissionHandler.approve_all
        )
        await resumed.send_and_wait("after restart", timeout=2)
    finally:
        await client.force_stop()
        await server.stop()

    requests = first.requests + second.requests
    sent_methods = {method for method, _ in requests}
    assert {"thread/start", "turn/start", "thread/resume"} <= sent_methods
    assert _unknown_keys(requests) == {}

    turn_efforts = [params.get("effort") for method, params in requests if method == "turn/start"]
    # create(high) -> switch(low) -> resume restores low from the session store
    assert turn_efforts == ["high", "low", "low"]


@pytest.mark.asyncio
async def test_turn_start_omits_effort_when_session_has_none(tmp_path):
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
        await session.send_and_wait("hello", timeout=2)
    finally:
        await client.force_stop()
        await server.stop()

    turn_start = next(params for method, params in fake.requests if method == "turn/start")
    assert "effort" not in turn_start
    assert "reasoningEffort" not in turn_start
