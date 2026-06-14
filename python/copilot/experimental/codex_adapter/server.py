"""Copilot-protocol TCP server backed by Codex app-server."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .gateway import CodexAppServerGateway, CodexAppServerGatewayOptions
from .mappers import (
    SandboxMode,
    ToolDescriptor,
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
    tool_descriptors_from_session_create_params,
)
from .session_store import CodexAdapterSessionStore, CodexRuntimeSessionRecord
from .tool_policy import plan_dynamic_tool_call_routing

DEFAULT_MODEL = "gpt-5.4"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_REQUEST_TIMEOUT_MS = 45_000
DEFAULT_TRANSCRIPT_LIMIT = 500
DEFAULT_FALLBACK_WORKSPACE_PARENT = os.path.join(
    tempfile.gettempdir(), "copilot-codex-adapter-workspaces"
)

CODEX_ADAPTER_CAPABILITIES = {
    "targetProfiles": ["SDK Core Profile", "Coding Agent Profile"],
    "flags": [
        {"id": "ping", "status": "supported"},
        {"id": "status.get", "status": "supported"},
        {"id": "auth.getStatus", "status": "supported"},
        {"id": "models.list", "status": "supported"},
        {"id": "session.create", "status": "supported"},
        {"id": "session.resume", "status": "supported"},
        {"id": "session.getMessages", "status": "supported"},
        {"id": "session.send", "status": "supported"},
        {"id": "session.destroy", "status": "supported"},
        {"id": "session.delete", "status": "supported"},
        {"id": "command approval", "status": "supported"},
        {"id": "file approval", "status": "supported"},
        {"id": "custom tool call", "status": "supported"},
        {"id": "tool failure/denial", "status": "supported"},
        {
            "id": "Interactive Profile",
            "status": "deferred",
            "reason": "user input and elicitation are not in the selected runtime profile",
        },
        {
            "id": "Fidelity Profile",
            "status": "deferred",
            "reason": (
                "streaming deltas, usage events, and sub-agent fidelity are not first-gate parity"
            ),
        },
        {
            "id": "Extended CLI Profile",
            "status": "deferred",
            "reason": "CLI escape-hatch RPCs are required only when a product path consumes them",
        },
    ],
}


@dataclass
class CodexAdapterOptions:
    codex_bin: str | None = None
    codex_home: str | None = None
    isolate_codex_home: bool = True
    host: str = DEFAULT_HOST
    port: int | None = None
    protocol_version: Literal[2, 3] = 3
    model: str = DEFAULT_MODEL
    approval_policy: str = "on-request"
    approvals_reviewer: str = "auto_review"
    sandbox_mode: SandboxMode = "workspaceWrite"
    network_access: bool = False
    request_timeout_ms: int = DEFAULT_REQUEST_TIMEOUT_MS
    transcript_limit: int = DEFAULT_TRANSCRIPT_LIMIT
    runtime_session_store_path: str | None = None
    fallback_workspace_parent: str | None = None
    client_info: dict[str, str | None] = field(default_factory=dict)


@dataclass
class SessionState:
    session_id: str
    thread_id: str
    created_at: str
    cwd: str
    model: str | None
    tools: list[ToolDescriptor]
    last_event_id: str | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    attached_connection_ids: set[str] = field(default_factory=set)
    resume_count: int = 0


@dataclass
class PendingDynamicToolCall:
    codex_request_id: Any
    session_id: str
    tool_call_id: str
    tool_name: str
    timeout_task: asyncio.Task[None]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _stable_stringify(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key)}:{_stable_stringify(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    return json.dumps(value, separators=(",", ":"))


def _summarize_error(error: Exception) -> dict[str, str]:
    return {"name": error.__class__.__name__, "message": str(error)}


def tool_fingerprint_from_descriptors(tools: list[ToolDescriptor]) -> str:
    normalized = [
        {
            "name": tool.get("name"),
            "description": tool.get("description"),
            "parameters": tool.get("parameters"),
            "skipPermission": tool.get("skipPermission") is True,
        }
        for tool in tools
    ]
    return hashlib.sha256(_stable_stringify(normalized).encode()).hexdigest()


EMPTY_TOOL_FINGERPRINT = tool_fingerprint_from_descriptors([])


class JsonRpcConnection:
    def __init__(
        self,
        connection_id: str,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        on_request: Callable[[str, Any, str], Awaitable[Any]],
        on_close: Callable[[str], None],
    ):
        self.connection_id = connection_id
        self.reader = reader
        self.writer = writer
        self.on_request = on_request
        self.on_close = on_close
        self.pending: dict[Any, asyncio.Future[Any]] = {}
        self.next_id = 1
        self._write_lock = asyncio.Lock()

    async def run(self) -> None:
        try:
            while True:
                message = await self._read_message()
                if message is None:
                    return
                asyncio.create_task(self._handle_message(message))
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            return
        finally:
            self.on_close(self.connection_id)
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except OSError:
                pass

    async def _read_message(self) -> dict[str, Any] | None:
        header = await self.reader.readuntil(b"\r\n\r\n")
        if not header:
            return None
        length = None
        for line in header.decode().split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
                break
        if length is None:
            raise ValueError("JSON-RPC message missing Content-Length")
        body = await self.reader.readexactly(length)
        return json.loads(body)

    async def _send(self, message: dict[str, Any]) -> None:
        body = json.dumps(message, separators=(",", ":")).encode()
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        async with self._write_lock:
            self.writer.write(header + body)
            await self.writer.drain()

    async def _handle_message(self, message: dict[str, Any]) -> None:
        if "id" in message and "method" not in message:
            future = self.pending.pop(message["id"], None)
            if future and not future.done():
                if "error" in message:
                    future.set_exception(RuntimeError(message["error"].get("message", "RPC error")))
                else:
                    future.set_result(message.get("result"))
            return

        if "id" in message and isinstance(message.get("method"), str):
            try:
                result = await self.on_request(
                    message["method"], message.get("params", {}), self.connection_id
                )
                await self._send({"jsonrpc": "2.0", "id": message["id"], "result": result})
            except Exception as exc:
                await self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {"code": -32603, "message": str(exc)},
                    }
                )

    async def notify(self, method: str, params: Any) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def request(self, method: str, params: Any, timeout: float | None = None) -> Any:
        request_id = self.next_id
        self.next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return await asyncio.wait_for(future, timeout)


class CodexCopilotAdapterServer:
    def __init__(self, options: CodexAdapterOptions | None = None, gateway: Any | None = None):
        self.options = options or CodexAdapterOptions()
        self.codex = gateway or CodexAppServerGateway(
            CodexAppServerGatewayOptions(
                codex_bin=self.options.codex_bin,
                codex_home=self.options.codex_home,
                isolate_codex_home=self.options.isolate_codex_home,
                request_timeout_ms=self.options.request_timeout_ms,
                transcript_limit=self.options.transcript_limit,
                client_info=self.options.client_info,
            )
        )
        self.session_store = CodexAdapterSessionStore(self.options.runtime_session_store_path)
        self.sessions: dict[str, SessionState] = {}
        self.thread_to_session: dict[str, str] = {}
        self.connections: dict[str, JsonRpcConnection] = {}
        self.file_change_snapshots: dict[str, list[Any]] = {}
        self.pending_dynamic_tool_calls: dict[str, PendingDynamicToolCall] = {}
        self.transcript: list[dict[str, Any]] = []
        self.semantic_log: list[dict[str, Any]] = []
        self.server: asyncio.AbstractServer | None = None
        self.port = 0
        self.next_connection_id = 1

    def _record(self, direction: str, message: Any) -> None:
        self.transcript.append({"at": _now_iso(), "direction": direction, "message": message})
        if len(self.transcript) > self.options.transcript_limit:
            del self.transcript[: len(self.transcript) - self.options.transcript_limit]

    def _record_semantic(
        self,
        category: str,
        event: str,
        *,
        session_id: str | None = None,
        thread_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        entry: dict[str, Any] = {
            "at": _now_iso(),
            "category": category,
            "event": event,
        }
        if session_id:
            entry["sessionId"] = session_id
        if thread_id:
            entry["threadId"] = thread_id
        if data:
            entry["data"] = {key: value for key, value in data.items() if value is not None}
        self.semantic_log.append(entry)
        if len(self.semantic_log) > self.options.transcript_limit:
            del self.semantic_log[: len(self.semantic_log) - self.options.transcript_limit]

    async def start(self) -> dict[str, Any]:
        await self.codex.start()
        self.codex.on_notification(self._handle_codex_notification)
        self.codex.on_request(
            lambda request: asyncio.create_task(self._handle_codex_request(request))
        )
        self.server = await asyncio.start_server(
            self._handle_client, self.options.host, self.options.port or 0
        )
        socket = self.server.sockets[0]
        self.port = int(socket.getsockname()[1])
        return {"port": self.port, "cliUrl": self.cli_url(), "clientOptions": self.client_options()}

    async def stop(self) -> None:
        for connection in list(self.connections.values()):
            connection.writer.close()
        for connection in list(self.connections.values()):
            try:
                await connection.writer.wait_closed()
            except OSError:
                pass
        self.connections.clear()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        await self.codex.stop()

    def cli_url(self) -> str:
        if not self.port:
            raise RuntimeError("Codex adapter server is not started")
        return f"{self.options.host}:{self.port}"

    def client_options(self) -> dict[str, Any]:
        return {"autoStart": False, "cliUrl": self.cli_url()}

    def capabilities(self) -> dict[str, Any]:
        return CODEX_ADAPTER_CAPABILITIES

    def summary(self) -> dict[str, Any]:
        return {
            "options": {
                "host": self.options.host,
                "port": self.port,
                "protocolVersion": self.options.protocol_version,
                "sandboxMode": self.options.sandbox_mode,
                "networkAccess": self.options.network_access,
            },
            "capabilities": self.capabilities(),
            "sessions": [
                {
                    "sessionId": session.session_id,
                    "threadId": session.thread_id,
                    "cwd": session.cwd,
                    "model": session.model,
                    "eventCount": len(session.events),
                    "attachedConnectionCount": len(session.attached_connection_ids),
                }
                for session in self.sessions.values()
            ],
            "adapterTranscript": self.transcript,
            "semanticLog": self.semantic_log,
            "codex": self.codex.summary(),
        }

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        connection_id = f"sdk-{self.next_connection_id}"
        self.next_connection_id += 1
        connection = JsonRpcConnection(
            connection_id, reader, writer, self._dispatch_sdk_request, self._detach_connection
        )
        self.connections[connection_id] = connection
        self._record("adapter.connection.open", {"connectionId": connection_id})
        await connection.run()

    def _detach_connection(self, connection_id: str) -> None:
        self.connections.pop(connection_id, None)
        for session in self.sessions.values():
            if connection_id in session.attached_connection_ids:
                session.attached_connection_ids.discard(connection_id)
                if not session.attached_connection_ids:
                    self.thread_to_session.pop(session.thread_id, None)
        self._record("adapter.connection.close", {"connectionId": connection_id})

    async def _dispatch_sdk_request(self, method: str, params: Any, connection_id: str) -> Any:
        self._record("sdk->adapter.request", {"method": method, "params": params})
        handlers: dict[str, Callable[[Any, str], Awaitable[Any] | Any]] = {
            "ping": self._handle_ping,
            "status.get": self._handle_status_get,
            "auth.getStatus": self._handle_auth_status,
            "models.list": self._handle_models_list,
            "session.create": self._handle_session_create,
            "session.resume": self._handle_session_resume,
            "session.getMessages": self._handle_session_get_messages,
            "session.send": self._handle_session_send,
            "session.destroy": self._handle_session_destroy,
            "session.delete": self._handle_session_delete,
            "session.tools.handlePendingToolCall": self._handle_pending_tool_call,
        }
        handler = handlers.get(method)
        if not handler:
            raise RuntimeError(f"Method not found: {method}")
        result = handler(params, connection_id)
        if asyncio.iscoroutine(result):
            result = await result
        self._record("adapter->sdk.response", {"method": method, "result": result})
        return result

    def _handle_ping(self, params: Any, _connection_id: str) -> dict[str, Any]:
        message = (
            params.get("message")
            if _is_record(params) and isinstance(params.get("message"), str)
            else None
        )
        return {
            "message": f"pong: {message}" if message else "pong",
            "timestamp": int(time.time() * 1000),
            "protocolVersion": self.options.protocol_version,
        }

    def _handle_status_get(self, _params: Any, _connection_id: str) -> dict[str, Any]:
        return {
            "version": "codex-copilot-adapter",
            "protocolVersion": self.options.protocol_version,
        }

    async def _handle_auth_status(self, _params: Any, _connection_id: str) -> dict[str, Any]:
        response = await self.codex.request("account/read", {"refreshToken": False})
        if response.get("error"):
            return {"isAuthenticated": False, "statusMessage": response["error"].get("message")}
        account = (
            response.get("result", {}).get("account")
            if _is_record(response.get("result"))
            else None
        )
        if not _is_record(account):
            return {"isAuthenticated": False, "statusMessage": "No account"}
        return {
            "isAuthenticated": True,
            "authType": "api-key" if account.get("type") == "apiKey" else "user",
            "login": account.get("email") if isinstance(account.get("email"), str) else None,
            "statusMessage": f"{account.get('type')}:{account.get('planType', 'unknown')}",
        }

    async def _handle_models_list(self, _params: Any, _connection_id: str) -> dict[str, Any]:
        response = await self.codex.request("model/list", {"includeHidden": False, "limit": 50})
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "model/list failed"))
        return {"models": map_codex_models(response.get("result"))}

    def _extract_base_instructions(self, params: dict[str, Any]) -> str | None:
        system_message = params.get("systemMessage")
        content = system_message.get("content") if _is_record(system_message) else None
        return content if isinstance(content, str) and content.strip() else None

    def _session_create_cwd(self, params: dict[str, Any]) -> str:
        working_directory = params.get("workingDirectory")
        if isinstance(working_directory, str) and working_directory.strip():
            return working_directory
        parent = Path(
            self.options.fallback_workspace_parent or DEFAULT_FALLBACK_WORKSPACE_PARENT
        ).expanduser()
        workspace = parent / str(uuid.uuid4())
        workspace.mkdir(parents=True, exist_ok=False)
        return str(workspace)

    def _record_concurrent_workspace_threads(
        self, session: SessionState, operation: Literal["create", "resume"]
    ) -> None:
        overlapping_sessions = [
            {
                "sessionId": other.session_id,
                "threadId": other.thread_id,
                "attachedConnectionCount": len(other.attached_connection_ids),
            }
            for other in self.sessions.values()
            if other.session_id != session.session_id
            and other.thread_id != session.thread_id
            and other.cwd == session.cwd
        ]
        if not overlapping_sessions:
            return
        self._record(
            "adapter.workspace.concurrent_threads",
            {
                "operation": operation,
                "cwd": session.cwd,
                "sessionId": session.session_id,
                "threadId": session.thread_id,
                "overlappingSessions": overlapping_sessions,
            },
        )

    async def _handle_session_create(self, params: Any, connection_id: str) -> dict[str, Any]:
        if not _is_record(params):
            raise RuntimeError("session.create params missing")
        session_id = (
            params.get("sessionId")
            if isinstance(params.get("sessionId"), str)
            else str(uuid.uuid4())
        )
        cwd = self._session_create_cwd(params)
        created_at = _now_iso()
        model = params.get("model") if isinstance(params.get("model"), str) else self.options.model
        tools = tool_descriptors_from_session_create_params(params)
        dynamic_tools = dynamic_tools_from_descriptors(tools)
        thread_params: dict[str, Any] = {
            "cwd": cwd,
            "model": model,
            "approvalPolicy": self.options.approval_policy,
            "approvalsReviewer": self.options.approvals_reviewer,
            "sandbox": codex_thread_sandbox_mode(self.options.sandbox_mode),
            "ephemeral": False,
            "experimentalRawEvents": False,
            "persistExtendedHistory": False,
        }
        base_instructions = self._extract_base_instructions(params)
        if base_instructions:
            thread_params["baseInstructions"] = base_instructions
        if dynamic_tools:
            thread_params["dynamicTools"] = dynamic_tools
        response = await self.codex.request("thread/start", thread_params)
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "thread/start failed"))
        thread = (
            response.get("result", {}).get("thread") if _is_record(response.get("result")) else None
        )
        thread_id = (
            thread.get("id") if _is_record(thread) and isinstance(thread.get("id"), str) else None
        )
        if not thread_id:
            raise RuntimeError("thread/start did not return thread.id")
        session = SessionState(
            session_id=session_id,
            thread_id=thread_id,
            created_at=created_at,
            cwd=cwd,
            model=model,
            tools=tools,
            attached_connection_ids={connection_id},
        )
        self.sessions[session_id] = session
        self.thread_to_session[thread_id] = session_id
        self.session_store.upsert(self._session_record_from_session(session, created_at))
        self._record_concurrent_workspace_threads(session, "create")
        self._record_semantic(
            "session.lifecycle",
            "created",
            session_id=session_id,
            thread_id=thread_id,
            data={"cwd": cwd, "model": model, "toolCount": len(tools)},
        )
        await self._emit_lifecycle(
            "session.created", session_id, {"startTime": created_at, "modifiedTime": created_at}
        )
        await self._emit_session_event(
            session_id,
            self._create_session_event(
                session,
                "session.start",
                {
                    "sessionId": session_id,
                    "startTime": created_at,
                    "version": 1,
                    "producer": "codex-copilot-adapter",
                    "copilotVersion": "codex-copilot-adapter",
                    "selectedModel": model,
                    "reasoningEffort": params.get("reasoningEffort")
                    if isinstance(params.get("reasoningEffort"), str)
                    else None,
                    "context": {"cwd": cwd},
                },
            ),
        )
        return {"sessionId": session_id, "capabilities": {"ui": {"elicitation": False}}}

    async def _handle_session_resume(self, params: Any, connection_id: str) -> dict[str, Any]:
        if not _is_record(params):
            raise RuntimeError("session.resume params missing")
        session_id = params.get("sessionId") if isinstance(params.get("sessionId"), str) else None
        if not session_id:
            raise RuntimeError("session.resume requires sessionId")
        resume_has_tools = isinstance(params.get("tools"), list)
        resume_tools = (
            tool_descriptors_from_session_create_params(params) if resume_has_tools else None
        )
        session = self.sessions.get(session_id)
        if not session:
            record = self.session_store.get(session_id)
            if not record:
                raise RuntimeError(f"Unknown session: {session_id}")
            if resume_tools is None and record.toolFingerprint != EMPTY_TOOL_FINGERPRINT:
                raise RuntimeError(
                    f"Cannot resume session {session_id}: "
                    "matching tools are required after adapter restart"
                )
            if (
                resume_tools is not None
                and tool_fingerprint_from_descriptors(resume_tools) != record.toolFingerprint
            ):
                raise RuntimeError(
                    f"Cannot resume session {session_id}: "
                    "tool set is incompatible with the persisted runtime session"
                )
            session = self._session_from_record(record, params, resume_tools or [])
            self.sessions[session_id] = session
        elif resume_tools is not None and tool_fingerprint_from_descriptors(
            resume_tools
        ) != tool_fingerprint_from_descriptors(session.tools):
            raise RuntimeError(
                f"Cannot resume session {session_id}: "
                "tool set is incompatible with the active runtime session"
            )
        already_in_use = len(session.attached_connection_ids) > 0
        event_count = len(session.events)
        session.attached_connection_ids.add(connection_id)
        session.cwd = (
            params.get("workingDirectory")
            if isinstance(params.get("workingDirectory"), str)
            else session.cwd
        )
        session.model = (
            params.get("model") if isinstance(params.get("model"), str) else session.model
        )
        session.resume_count += 1
        self.thread_to_session[session.thread_id] = session.session_id
        response = await self.codex.request(
            "thread/resume",
            {
                "threadId": session.thread_id,
                "cwd": session.cwd,
                "approvalPolicy": self.options.approval_policy,
                "approvalsReviewer": self.options.approvals_reviewer,
                "sandbox": codex_thread_sandbox_mode(self.options.sandbox_mode),
                "initialTurnsPage": {"limit": 50, "sortDirection": "desc", "itemsView": "summary"},
            },
        )
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "thread/resume failed"))
        self.session_store.upsert(self._session_record_from_session(session, _now_iso()))
        self._record_concurrent_workspace_threads(session, "resume")
        resume_time = _now_iso()
        self._record_semantic(
            "session.lifecycle",
            "resumed",
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={
                "cwd": session.cwd,
                "model": session.model or self.options.model,
                "eventCount": event_count,
                "alreadyInUse": already_in_use,
                "toolCount": len(session.tools),
            },
        )
        await self._emit_lifecycle(
            "session.resumed",
            session.session_id,
            {"resumeTime": resume_time, "eventCount": event_count, "alreadyInUse": already_in_use},
        )
        if params.get("disableResume") is not True:
            await self._emit_session_event(
                session.session_id,
                self._create_session_event(
                    session,
                    "session.resume",
                    {
                        "resumeTime": resume_time,
                        "eventCount": event_count,
                        "selectedModel": session.model or self.options.model,
                        "reasoningEffort": params.get("reasoningEffort")
                        if isinstance(params.get("reasoningEffort"), str)
                        else None,
                        "alreadyInUse": already_in_use,
                        "context": {"cwd": session.cwd},
                    },
                ),
            )
        return {"sessionId": session.session_id, "capabilities": {"ui": {"elicitation": False}}}

    def _handle_session_get_messages(self, params: Any, connection_id: str) -> dict[str, Any]:
        session_id = (
            params.get("sessionId")
            if _is_record(params) and isinstance(params.get("sessionId"), str)
            else None
        )
        if not session_id:
            raise RuntimeError("session.getMessages requires sessionId")
        session = self.sessions.get(session_id)
        if not session or connection_id not in session.attached_connection_ids:
            raise RuntimeError(f"Session not found: {session_id}")
        return {"events": list(session.events)}

    async def _handle_session_send(self, params: Any, connection_id: str) -> dict[str, Any]:
        if not _is_record(params):
            raise RuntimeError("session.send params missing")
        session_id = params.get("sessionId") if isinstance(params.get("sessionId"), str) else None
        prompt = params.get("prompt") if isinstance(params.get("prompt"), str) else None
        if not session_id or prompt is None:
            raise RuntimeError("session.send requires sessionId and prompt")
        session = self.sessions.get(session_id)
        if not session or connection_id not in session.attached_connection_ids:
            raise RuntimeError(f"Session not found: {session_id}")
        user_message_id = str(uuid.uuid4())
        await self._emit_session_event(
            session.session_id,
            self._create_session_event(
                session,
                "user.message",
                {"content": prompt, "messageId": user_message_id},
            ),
        )
        self._record_semantic(
            "turn.lifecycle",
            "started",
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={
                "messageId": user_message_id,
                "promptChars": len(prompt),
                "model": session.model or self.options.model,
            },
        )
        response = await self.codex.request(
            "turn/start",
            {
                "threadId": session.thread_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}],
                "model": session.model or self.options.model,
                "approvalPolicy": self.options.approval_policy,
                "approvalsReviewer": self.options.approvals_reviewer,
                "sandboxPolicy": codex_sandbox_policy(
                    self.options.sandbox_mode, self.options.network_access
                ),
            },
        )
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "turn/start failed"))
        return {"messageId": user_message_id}

    async def _handle_session_destroy(self, params: Any, connection_id: str) -> dict[str, Any]:
        session_id = (
            params.get("sessionId")
            if _is_record(params) and isinstance(params.get("sessionId"), str)
            else None
        )
        if session_id and (session := self.sessions.get(session_id)):
            session.attached_connection_ids.discard(connection_id)
            if not session.attached_connection_ids and session.thread_id in self.thread_to_session:
                response = await self.codex.request(
                    "thread/unsubscribe", {"threadId": session.thread_id}
                )
                if response.get("error"):
                    self._record("adapter.session.destroy.unsubscribe.error", response["error"])
                self.thread_to_session.pop(session.thread_id, None)
        return {"success": True}

    async def _handle_session_delete(self, params: Any, _connection_id: str) -> dict[str, Any]:
        session_id = (
            params.get("sessionId")
            if _is_record(params) and isinstance(params.get("sessionId"), str)
            else None
        )
        if not session_id:
            return {"success": False, "error": "session.delete requires sessionId"}
        session = self.sessions.get(session_id)
        if not session:
            return {"success": False, "error": f"Unknown session: {session_id}"}
        response = await self.codex.request("thread/archive", {"threadId": session.thread_id})
        if response.get("error"):
            return {"success": False, "error": response["error"].get("message")}
        await self._emit_lifecycle("session.deleted", session_id, {"deleteTime": _now_iso()})
        self.sessions.pop(session_id, None)
        self.thread_to_session.pop(session.thread_id, None)
        self.session_store.delete(session_id)
        self._delete_pending_tool_calls_for_session(session_id)
        return {"success": True}

    def _session_record_from_session(
        self, session: SessionState, updated_at: str
    ) -> CodexRuntimeSessionRecord:
        return CodexRuntimeSessionRecord(
            sdkSessionId=session.session_id,
            runtime="codex",
            runtimeSessionId=session.thread_id,
            codexThreadId=session.thread_id,
            cwd=session.cwd,
            model=session.model,
            toolFingerprint=tool_fingerprint_from_descriptors(session.tools),
            codexHomeIdentity=self.options.codex_home,
            createdAt=session.created_at,
            updatedAt=updated_at,
        )

    def _session_from_record(
        self, record: CodexRuntimeSessionRecord, params: dict[str, Any], tools: list[ToolDescriptor]
    ) -> SessionState:
        return SessionState(
            session_id=record.sdkSessionId,
            thread_id=record.runtimeSessionId,
            created_at=record.createdAt,
            cwd=params.get("workingDirectory")
            if isinstance(params.get("workingDirectory"), str)
            else record.cwd,
            model=params.get("model") if isinstance(params.get("model"), str) else record.model,
            tools=tools,
        )

    def _create_session_event(
        self, session: SessionState, event_type: str, data: dict[str, Any], ephemeral: bool = False
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        event = {
            "type": event_type,
            "data": {key: value for key, value in data.items() if value is not None},
            "id": event_id,
            "parentId": session.last_event_id,
            "timestamp": _now_iso(),
            "ephemeral": ephemeral,
        }
        session.last_event_id = event_id
        return event

    async def _emit_lifecycle(
        self, event_type: str, session_id: str, metadata: dict[str, Any] | None = None
    ) -> None:
        session = self.sessions.get(session_id)
        await self._notify_connections(
            "session.lifecycle",
            {"type": event_type, "sessionId": session_id, "metadata": metadata},
            session.attached_connection_ids if session else None,
        )

    async def _emit_session_event(self, session_id: str, event: dict[str, Any]) -> None:
        session = self.sessions.get(session_id)
        if session and event.get("ephemeral") is not True:
            session.events.append(event)
        await self._notify_connections(
            "session.event",
            {"sessionId": session_id, "event": event},
            session.attached_connection_ids if session else None,
        )

    async def _notify_connections(
        self, method: str, params: Any, connection_ids: set[str] | None = None
    ) -> None:
        ids = list(connection_ids if connection_ids is not None else self.connections.keys())
        for connection_id in ids:
            connection = self.connections.get(connection_id)
            if connection:
                try:
                    await connection.notify(method, params)
                except (ConnectionResetError, BrokenPipeError, OSError):
                    self._detach_connection(connection_id)

    def _handle_codex_notification(self, notification: dict[str, Any]) -> None:
        params = notification.get("params") if _is_record(notification.get("params")) else {}
        file_change_item_id = (
            params.get("itemId")
            if isinstance(params.get("itemId"), str)
            else params.get("item", {}).get("id")
            if _is_record(params.get("item")) and isinstance(params["item"].get("id"), str)
            else None
        )
        file_changes = extract_file_changes_from_params(params)
        if file_change_item_id and file_changes:
            self.file_change_snapshots[file_change_item_id] = file_changes
        thread_id = (
            params.get("threadId")
            if isinstance(params.get("threadId"), str)
            else params.get("thread", {}).get("id")
            if _is_record(params.get("thread")) and isinstance(params["thread"].get("id"), str)
            else None
        )
        if not thread_id or thread_id not in self.thread_to_session:
            return
        session_id = self.thread_to_session[thread_id]
        session = self.sessions.get(session_id)
        if not session:
            return
        method = notification.get("method")
        if method == "item/completed":
            item = params.get("item") if _is_record(params.get("item")) else {}
            if item.get("type") == "agentMessage":
                text = item.get("text") if isinstance(item.get("text"), str) else ""
                message_id = (
                    item.get("id")
                    if isinstance(item.get("id"), str)
                    else f"assistant-{uuid.uuid4()}"
                )
                self._record_semantic(
                    "assistant.message",
                    "completed",
                    session_id=session_id,
                    thread_id=thread_id,
                    data={
                        "messageId": message_id,
                        "contentChars": len(text),
                        "phase": item.get("phase") if isinstance(item.get("phase"), str) else None,
                    },
                )
                asyncio.create_task(
                    self._emit_session_event(
                        session_id,
                        self._create_session_event(
                            session,
                            "assistant.message",
                            {
                                "content": text,
                                "messageId": message_id,
                                "phase": item.get("phase")
                                if isinstance(item.get("phase"), str)
                                else None,
                            },
                        ),
                    )
                )
        elif method == "turn/completed":
            turn = params.get("turn") if _is_record(params.get("turn")) else {}
            status = turn.get("status") if isinstance(turn.get("status"), str) else "completed"
            self._record_semantic(
                "turn.lifecycle",
                "completed",
                session_id=session_id,
                thread_id=thread_id,
                data={"status": status},
            )
            event = (
                self._create_session_event(session, "session.idle", {})
                if status == "completed"
                else self._create_session_event(
                    session,
                    "session.error",
                    {
                        "errorType": "adapter",
                        "message": f"Codex turn completed with status={status}",
                    },
                )
            )
            asyncio.create_task(self._emit_session_event(session_id, event))

    async def _handle_codex_request(self, request: dict[str, Any]) -> None:
        if request.get("method") not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/tool/call",
        }:
            return
        params = request.get("params") if _is_record(request.get("params")) else {}
        thread_id = params.get("threadId") if isinstance(params.get("threadId"), str) else None
        request_id = request.get("id")
        if not thread_id:
            if request.get("method") == "item/tool/call":
                self.codex.respond(
                    request_id,
                    {
                        "contentItems": [
                            {"type": "inputText", "text": "dynamic tool request missing threadId"}
                        ],
                        "success": False,
                    },
                )
            else:
                self.codex.respond(request_id, {"decision": "decline"})
            return
        session_id = self.thread_to_session.get(thread_id)
        session = self.sessions.get(session_id) if session_id else None
        if not session:
            if request.get("method") == "item/tool/call":
                self.codex.respond(
                    request_id,
                    {
                        "contentItems": [
                            {"type": "inputText", "text": "dynamic tool request has no session"}
                        ],
                        "success": False,
                    },
                )
            else:
                self.codex.respond(request_id, {"decision": "decline"})
            return
        connection = self._primary_connection(session)
        if not connection:
            if request.get("method") == "item/tool/call":
                self.codex.respond(
                    request_id,
                    {
                        "contentItems": [
                            {
                                "type": "inputText",
                                "text": "dynamic tool request has no SDK connection",
                            }
                        ],
                        "success": False,
                    },
                )
            else:
                self.codex.respond(request_id, {"decision": "decline"})
            return
        if request.get("method") == "item/tool/call":
            await self._handle_codex_dynamic_tool_call(request, params, session, connection)
            return
        changes = (
            self.file_change_snapshots.get(params.get("itemId"), [])
            if request.get("method") == "item/fileChange/requestApproval"
            and isinstance(params.get("itemId"), str)
            else []
        )
        permission_request = (
            map_codex_file_change_approval_to_permission_request(params, changes)
            if request.get("method") == "item/fileChange/requestApproval"
            else map_codex_command_approval_to_permission_request(params)
        )
        approval_kind = (
            "file_change"
            if request.get("method") == "item/fileChange/requestApproval"
            else "command"
        )
        self._record_semantic(
            "approval.requested",
            approval_kind,
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={"requestId": str(request_id), "itemId": params.get("itemId")},
        )
        try:
            callback_params = {
                "sessionId": session.session_id,
                "permissionRequest": permission_request,
            }
            self._record(
                "adapter->sdk.request",
                {"method": "permission.request", "params": callback_params},
            )
            response = await connection.request(
                "permission.request",
                callback_params,
                self.options.request_timeout_ms / 1000,
            )
            self._record(
                "sdk->adapter.response",
                {"method": "permission.request", "response": response},
            )
            result = (
                response.get("result")
                if _is_record(response) and "result" in response
                else response
            )
            decision = (
                map_permission_result_to_codex_file_change_decision(result)
                if request.get("method") == "item/fileChange/requestApproval"
                else map_permission_result_to_codex_command_decision(result, params)
            )
            self._record_semantic(
                "approval.resolved",
                approval_kind,
                session_id=session.session_id,
                thread_id=session.thread_id,
                data={"requestId": str(request_id), "decision": decision},
            )
            self.codex.respond(request_id, {"decision": decision})
        except Exception as exc:
            self._record(
                "sdk->adapter.response",
                {"method": "permission.request", "error": _summarize_error(exc)},
            )
            self._record_semantic(
                "runtime.error",
                "approval.callback_failed",
                session_id=session.session_id,
                thread_id=session.thread_id,
                data={"requestId": str(request_id), "error": str(exc)},
            )
            self.codex.respond(request_id, {"decision": "decline"})

    def _primary_connection(self, session: SessionState | None) -> JsonRpcConnection | None:
        if not session:
            return None
        for connection_id in session.attached_connection_ids:
            if connection_id in self.connections:
                return self.connections[connection_id]
        return None

    async def _handle_codex_dynamic_tool_call(
        self,
        request: dict[str, Any],
        params: dict[str, Any],
        session: SessionState,
        connection: JsonRpcConnection,
    ) -> None:
        tool_name = params.get("tool") if isinstance(params.get("tool"), str) else None
        tool_call_id = (
            params.get("callId")
            if isinstance(params.get("callId"), str)
            else str(request.get("id"))
        )
        if not tool_name:
            self.codex.respond(
                request.get("id"),
                {
                    "contentItems": [
                        {"type": "inputText", "text": "dynamic tool request missing tool name"}
                    ],
                    "success": False,
                },
            )
            return
        if not any(tool.get("name") == tool_name for tool in session.tools):
            self.codex.respond(
                request.get("id"),
                {
                    "contentItems": [
                        {
                            "type": "inputText",
                            "text": (
                                f"dynamic tool {tool_name} "
                                "is not registered with the SDK session"
                            ),
                        }
                    ],
                    "success": False,
                },
            )
            return
        routing = plan_dynamic_tool_call_routing(
            {
                "protocolVersion": self.options.protocol_version,
                "sessionId": session.session_id,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "argumentsPayload": params.get("arguments"),
            }
        )
        self._record_semantic(
            "tool.routing",
            "requested",
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={
                "toolName": tool_name,
                "toolCallId": tool_call_id,
                "protocolVersion": self.options.protocol_version,
                "mode": routing["mode"],
            },
        )
        if routing["mode"] == "protocol-v2-sdk-request":
            try:
                self._record(
                    "adapter->sdk.request",
                    {"method": "tool.call", "params": routing["toolCallParams"]},
                )
                self._record_semantic(
                    "tool.sdk_call",
                    "dispatched",
                    session_id=session.session_id,
                    thread_id=session.thread_id,
                    data={"toolName": tool_name, "toolCallId": tool_call_id},
                )
                response = await connection.request(
                    "tool.call",
                    routing["toolCallParams"],
                    self.options.request_timeout_ms / 1000,
                )
                self._record(
                    "sdk->adapter.response",
                    {"method": "tool.call", "response": response},
                )
                result = (
                    response.get("result")
                    if _is_record(response) and "result" in response
                    else response
                )
                codex_response = map_sdk_tool_result_to_codex_dynamic_tool_response(
                    result, None
                )
                self._record_semantic(
                    "tool.sdk_result",
                    "received",
                    session_id=session.session_id,
                    thread_id=session.thread_id,
                    data={
                        "toolName": tool_name,
                        "toolCallId": tool_call_id,
                        "success": codex_response.get("success"),
                    },
                )
                self.codex.respond(request.get("id"), codex_response)
            except Exception as exc:
                self._record(
                    "sdk->adapter.response",
                    {"method": "tool.call", "error": _summarize_error(exc)},
                )
                self._record_semantic(
                    "runtime.error",
                    "tool.sdk_call_failed",
                    session_id=session.session_id,
                    thread_id=session.thread_id,
                    data={"toolName": tool_name, "toolCallId": tool_call_id, "error": str(exc)},
                )
                self.codex.respond(
                    request.get("id"),
                    map_sdk_tool_result_to_codex_dynamic_tool_response(None, str(exc)),
                )
            return
        sdk_request_id = routing["sdkRequestId"]
        timeout_task = asyncio.create_task(self._tool_timeout(sdk_request_id))
        self.pending_dynamic_tool_calls[sdk_request_id] = PendingDynamicToolCall(
            codex_request_id=request.get("id"),
            session_id=session.session_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            timeout_task=timeout_task,
        )
        self._record_semantic(
            "tool.sdk_call",
            "pending",
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={
                "requestId": sdk_request_id,
                "toolName": tool_name,
                "toolCallId": tool_call_id,
            },
        )
        await self._emit_session_event(
            session.session_id,
            self._create_session_event(
                session, "external_tool.requested", routing["eventData"], routing["ephemeral"]
            ),
        )

    async def _tool_timeout(self, request_id: str) -> None:
        await asyncio.sleep(self.options.request_timeout_ms / 1000)
        pending = self.pending_dynamic_tool_calls.pop(request_id, None)
        if not pending:
            return
        self.codex.respond(
            pending.codex_request_id,
            map_sdk_tool_result_to_codex_dynamic_tool_response(
                None, f"Timed out waiting for SDK tool result: {pending.tool_name}"
            ),
        )
        self._record(
            "adapter.tool.timeout",
            {
                "requestId": request_id,
                "sessionId": pending.session_id,
                "toolName": pending.tool_name,
                "toolCallId": pending.tool_call_id,
            },
        )
        session = self.sessions.get(pending.session_id)
        self._record_semantic(
            "runtime.error",
            "tool.timeout",
            session_id=pending.session_id,
            thread_id=session.thread_id if session else None,
            data={
                "requestId": request_id,
                "toolName": pending.tool_name,
                "toolCallId": pending.tool_call_id,
            },
        )

    def _handle_pending_tool_call(self, params: Any, _connection_id: str) -> dict[str, Any]:
        if not _is_record(params):
            raise RuntimeError("session.tools.handlePendingToolCall params missing")
        request_id = params.get("requestId") if isinstance(params.get("requestId"), str) else None
        if not request_id:
            raise RuntimeError("session.tools.handlePendingToolCall requires requestId")
        pending = self.pending_dynamic_tool_calls.pop(request_id, None)
        if not pending:
            return {"success": False}
        pending.timeout_task.cancel()
        response = map_sdk_tool_result_to_codex_dynamic_tool_response(
            params.get("result"), params.get("error")
        )
        self.codex.respond(pending.codex_request_id, response)
        session = self.sessions.get(pending.session_id)
        self._record_semantic(
            "tool.sdk_result",
            "received",
            session_id=pending.session_id,
            thread_id=session.thread_id if session else None,
            data={
                "requestId": request_id,
                "toolName": pending.tool_name,
                "toolCallId": pending.tool_call_id,
                "success": response.get("success"),
            },
        )
        if session:
            asyncio.create_task(
                self._emit_session_event(
                    pending.session_id,
                    self._create_session_event(
                        session, "external_tool.completed", {"requestId": request_id}, True
                    ),
                )
            )
        return {"success": True}

    def _delete_pending_tool_calls_for_session(self, session_id: str) -> None:
        for request_id, pending in list(self.pending_dynamic_tool_calls.items()):
            if pending.session_id == session_id:
                pending.timeout_task.cancel()
                self.pending_dynamic_tool_calls.pop(request_id, None)
