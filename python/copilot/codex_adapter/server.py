"""Copilot-protocol TCP server backed by Codex app-server."""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
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
SEMANTIC_PREVIEW_MAX_STRING_CHARS = 240
SEMANTIC_PREVIEW_MAX_ITEMS = 8
SEMANTIC_PREVIEW_MAX_DEPTH = 4
REDACTED_PREVIEW = "[redacted]"
TRUNCATED_PREVIEW = "[truncated]"
COMMAND_OUTPUT_PREVIEW_CHARS = 240
COMMAND_OUTPUT_WARNING_CHARS = 60_000
SENSITIVE_KEY_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "secret",
    "token",
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
        {
            "id": "session.abort",
            "status": "supported",
            "reason": (
                "Codex app-server has no single-turn cancel RPC; the adapter aborts by "
                "invalidating the SDK session and restarting the app-server to release "
                "the pending turn/start request."
            ),
        },
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
    experimental_raw_events: bool = False


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
    raw_tool_call_ids: set[str] = field(default_factory=set)
    raw_tool_output_call_ids: set[str] = field(default_factory=set)
    raw_tool_names: dict[str, str] = field(default_factory=dict)


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


def _attachment_display_name(attachment: dict[str, Any]) -> str | None:
    display_name = attachment.get("displayName")
    return display_name if isinstance(display_name, str) and display_name.strip() else None


def _attachment_mime_type(path: str, attachment: dict[str, Any]) -> str:
    mime_type = attachment.get("mimeType")
    if isinstance(mime_type, str) and mime_type.strip():
        return mime_type
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _is_image_mime_type(mime_type: str) -> bool:
    return mime_type.lower().startswith("image/")


def _codex_inputs_from_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        return []

    inputs: list[dict[str, Any]] = []
    for attachment in attachments:
        if not _is_record(attachment):
            continue
        attachment_type = attachment.get("type")
        if attachment_type == "blob":
            data = attachment.get("data")
            mime_type = attachment.get("mimeType")
            if not isinstance(data, str) or not isinstance(mime_type, str):
                continue
            if not _is_image_mime_type(mime_type):
                continue
            inputs.append(
                {
                    "type": "image",
                    "url": f"data:{mime_type};base64,{data}",
                    "detail": "auto",
                }
            )
        elif attachment_type == "file":
            path = attachment.get("path")
            if not isinstance(path, str) or not path.strip():
                continue
            mime_type = _attachment_mime_type(path, attachment)
            if _is_image_mime_type(mime_type):
                inputs.append({"type": "localImage", "path": path, "detail": "auto"})
            else:
                label = _attachment_display_name(attachment) or path
                inputs.append(
                    {
                        "type": "text",
                        "text": f"Attached file: {label} ({path})",
                        "text_elements": [],
                    }
                )
    return inputs


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


def _is_sensitive_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower().replace("-", "_").replace(" ", "_")
    return any(marker in normalized for marker in SENSITIVE_KEY_MARKERS)


def _looks_like_secret_string(value: str) -> bool:
    stripped = value.strip()
    lowered = stripped.lower()
    if lowered.startswith("bearer "):
        return True
    if stripped.startswith("sk-") and len(stripped) > 20:
        return True
    if stripped.startswith("eyJ") and stripped.count(".") >= 2:
        return True
    return len(stripped) > 120 and not any(char.isspace() for char in stripped)


def _preview_value(value: Any, *, depth: int = 0) -> tuple[Any, bool, bool]:
    if depth >= SEMANTIC_PREVIEW_MAX_DEPTH:
        return TRUNCATED_PREVIEW, False, True

    if isinstance(value, dict):
        redacted = False
        truncated = False
        preview: dict[str, Any] = {}
        items = list(value.items())
        for key, item in items[:SEMANTIC_PREVIEW_MAX_ITEMS]:
            key_text = str(key)
            if _is_sensitive_key(key):
                preview[key_text] = REDACTED_PREVIEW
                redacted = True
                continue
            item_preview, item_redacted, item_truncated = _preview_value(
                item, depth=depth + 1
            )
            preview[key_text] = item_preview
            redacted = redacted or item_redacted
            truncated = truncated or item_truncated
        if len(items) > SEMANTIC_PREVIEW_MAX_ITEMS:
            preview["..."] = f"{len(items) - SEMANTIC_PREVIEW_MAX_ITEMS} more keys"
            truncated = True
        return preview, redacted, truncated

    if isinstance(value, (list, tuple)):
        redacted = False
        truncated = False
        preview_items = []
        for item in list(value)[:SEMANTIC_PREVIEW_MAX_ITEMS]:
            item_preview, item_redacted, item_truncated = _preview_value(
                item, depth=depth + 1
            )
            preview_items.append(item_preview)
            redacted = redacted or item_redacted
            truncated = truncated or item_truncated
        if len(value) > SEMANTIC_PREVIEW_MAX_ITEMS:
            preview_items.append(f"... {len(value) - SEMANTIC_PREVIEW_MAX_ITEMS} more items")
            truncated = True
        return preview_items, redacted, truncated

    if isinstance(value, str):
        if _looks_like_secret_string(value):
            return REDACTED_PREVIEW, True, False
        if len(value) > SEMANTIC_PREVIEW_MAX_STRING_CHARS:
            return value[:SEMANTIC_PREVIEW_MAX_STRING_CHARS] + "...", False, True
        return value, False, False

    if value is None or isinstance(value, (bool, int, float)):
        return value, False, False

    text = repr(value)
    if len(text) > SEMANTIC_PREVIEW_MAX_STRING_CHARS:
        return text[:SEMANTIC_PREVIEW_MAX_STRING_CHARS] + "...", False, True
    return text, False, False


def _preview_fields(prefix: str, value: Any) -> dict[str, Any]:
    preview, redacted, truncated = _preview_value(value)
    return {
        f"{prefix}Preview": preview,
        f"{prefix}PreviewRedacted": redacted,
        f"{prefix}PreviewTruncated": truncated,
    }


def _first_text_from_content_items(content_items: Any, *, limit: int = 500) -> str:
    if not isinstance(content_items, list):
        return ""
    pieces: list[str] = []
    for item in content_items:
        if not _is_record(item):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            pieces.append(text)
    text = "\n".join(pieces)
    return text[:limit] + "..." if len(text) > limit else text


def _json_object_from_string(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _text_from_mcp_result(result: Any, *, limit: int = 500) -> str:
    if not _is_record(result):
        return ""
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    pieces: list[str] = []
    for item in content:
        if not _is_record(item):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            pieces.append(text)
    text = "\n".join(pieces)
    return text[:limit] + "..." if len(text) > limit else text


def _tool_output_preview(text: str, *, limit: int = 500) -> tuple[str, bool]:
    return (text[:limit] + "...", True) if len(text) > limit else (text, False)


def _exit_code_from_command_output(text: str) -> int | None:
    match = re.search(r"Process exited with code (-?\d+)", text)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _mcp_tool_name(item: dict[str, Any]) -> tuple[str, str | None, str | None]:
    server = item.get("server") if isinstance(item.get("server"), str) else None
    tool = item.get("tool") if isinstance(item.get("tool"), str) else None
    if server and tool:
        return f"{server}.{tool}", server, tool
    if tool:
        return tool, server, tool
    name = _first_string_field(item, "toolName", "name") or "mcp_tool"
    return name, server, tool


def _reasoning_content(item: dict[str, Any]) -> str:
    """Return readable reasoning only when Codex actually provides it.

    Codex often emits reasoning lifecycle items with an empty ``[]`` content
    placeholder. Those events are useful for fidelity/debugging, but they are
    not user-readable reasoning. The adapter must not fabricate thinking text
    just to make downstream timelines look busy.
    """
    for key in ("text", "summary", "content"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, list):
            parts = [part for part in value if isinstance(part, str) and part.strip()]
            if parts:
                return "\n".join(parts)
    return ""


def _first_string_field(value: dict[str, Any], *names: str) -> str | None:
    for name in names:
        item = value.get(name)
        if isinstance(item, str) and item:
            return item
    return None


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
        self.command_output_chars: dict[str, int] = {}
        self.command_output_warning_emitted: set[str] = set()
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
        on_fatal_error = getattr(self.codex, "on_fatal_error", None)
        if callable(on_fatal_error):
            on_fatal_error(
                lambda error, metadata: asyncio.create_task(
                    self._handle_codex_gateway_fatal(error, metadata)
                )
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
                "experimentalRawEvents": self.options.experimental_raw_events,
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
            "session.abort": self._handle_session_abort,
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
            "experimentalRawEvents": self.options.experimental_raw_events,
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
        attachments = params.get("attachments")
        attachment_inputs = _codex_inputs_from_attachments(attachments)
        turn_input = [
            {"type": "text", "text": prompt, "text_elements": []},
            *attachment_inputs,
        ]
        self._record_semantic(
            "turn.lifecycle",
            "started",
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={
                "messageId": user_message_id,
                "promptChars": len(prompt),
                "model": session.model or self.options.model,
                "attachmentCount": len(attachments) if isinstance(attachments, list) else 0,
                "inputCount": len(turn_input),
            },
        )
        response = await self.codex.request(
            "turn/start",
            {
                "threadId": session.thread_id,
                "input": turn_input,
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

    async def _handle_session_abort(self, params: Any, _connection_id: str) -> dict[str, Any]:
        session_id = (
            params.get("sessionId")
            if _is_record(params) and isinstance(params.get("sessionId"), str)
            else None
        )
        if not session_id:
            return {"success": False, "error": "session.abort requires sessionId"}
        session = self.sessions.get(session_id)
        if not session:
            return {"success": False, "error": f"Unknown session: {session_id}"}
        abort_time = _now_iso()
        await self._emit_lifecycle("session.aborted", session_id, {"abortTime": abort_time})
        self.sessions.pop(session_id, None)
        self.thread_to_session.pop(session.thread_id, None)
        self.session_store.delete(session_id)
        self._delete_pending_tool_calls_for_session(session_id)
        self._record_semantic(
            "session.lifecycle",
            "aborted",
            session_id=session_id,
            thread_id=session.thread_id,
            data={"cwd": session.cwd, "model": session.model or self.options.model},
        )
        await self._restart_codex_after_abort(session)
        return {"success": True, "gatewayRestarted": True}

    async def _restart_codex_after_abort(self, session: SessionState) -> None:
        self._record(
            "adapter.session.abort.gateway_restart",
            {"sessionId": session.session_id, "threadId": session.thread_id},
        )
        await self.codex.stop()
        await self.codex.start()

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

    def _emit_codex_session_event(
        self,
        session: SessionState,
        event_type: str,
        data: dict[str, Any],
        *,
        ephemeral: bool = False,
    ) -> None:
        """Bridge one Codex app-server event into the SDK session event stream.

        This helper intentionally lives at the adapter boundary. Product tools
        should not synthesize UI progress just because the frontend wants more
        detail; the adapter is the layer that still sees the native Codex
        runtime events and can preserve them with the right SDK event type.
        """
        asyncio.create_task(
            self._emit_session_event(
                session.session_id,
                self._create_session_event(session, event_type, data, ephemeral),
            )
        )

    def _emit_codex_raw_event(
        self,
        session: SessionState,
        *,
        method: str,
        params: dict[str, Any],
        reason: str,
    ) -> None:
        """Preserve unmatched Codex events without dumping large raw payloads.

        The full raw JSON-RPC event remains in the gateway transcript/spill
        files. The SDK event carries enough identity and preview data for UI
        and log correlation while keeping the normal session event stream small
        and safe.
        """
        payload = {
            "source": "codex.app_server",
            "method": method,
            "reason": reason,
            "threadId": session.thread_id,
            **_preview_fields("params", params),
        }
        self._record_semantic(
            "codex.raw",
            method.replace("/", "."),
            session_id=session.session_id,
            thread_id=session.thread_id,
            data={"reason": reason, **_preview_fields("params", params)},
        )
        self._emit_codex_session_event(session, "codex.raw", payload, ephemeral=True)

    async def _handle_codex_gateway_fatal(
        self,
        error: Exception,
        metadata: dict[str, Any],
    ) -> None:
        stream_limit = metadata.get("streamLimitBytes")
        error_name = metadata.get("errorName") or error.__class__.__name__
        error_message = metadata.get("errorMessage") or str(error)
        message = (
            "Codex adapter transport failed while reading app-server output. "
            "The payload likely exceeded the subprocess stream limit; chunk or "
            "spill large payloads before returning them to the adapter. "
            f"error_code=codex_gateway_reader_failed stream_limit_bytes={stream_limit} "
            f"error={error_name}: {error_message}"
        )
        data = {
            "errorName": error_name,
            "errorMessage": error_message,
            "streamLimitBytes": stream_limit,
            "sessionCount": len(self.sessions),
        }
        self._record("codex.gateway.reader_failed", data)
        self._record_semantic("codex.gateway", "reader_failed", data=data)
        for session in list(self.sessions.values()):
            self._record_semantic(
                "runtime.error",
                "codex_gateway_reader_failed",
                session_id=session.session_id,
                thread_id=session.thread_id,
                data=data,
            )
            await self._emit_session_event(
                session.session_id,
                self._create_session_event(
                    session,
                    "session.error",
                    {
                        "errorType": "adapter_transport",
                        "errorCode": "codex_gateway_reader_failed",
                        "message": message,
                        "providerCallId": "codex_gateway_reader_failed",
                        "streamLimitBytes": stream_limit,
                        "errorName": error_name,
                        "errorMessage": error_message,
                    },
                ),
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
        if method == "rawResponseItem/completed":
            item = params.get("item") if _is_record(params.get("item")) else {}
            item_type = item.get("type") if isinstance(item.get("type"), str) else ""
            if item_type == "function_call":
                tool_name = item.get("name") if isinstance(item.get("name"), str) else "function_call"
                tool_call_id = (
                    item.get("call_id") if isinstance(item.get("call_id"), str) else None
                )
                raw_arguments = item.get("arguments")
                parsed_arguments = _json_object_from_string(raw_arguments)
                argument_source = parsed_arguments if parsed_arguments is not None else raw_arguments
                argument_preview, redacted, truncated = _preview_value(argument_source)
                if tool_call_id:
                    session.raw_tool_call_ids.add(tool_call_id)
                    session.raw_tool_names[tool_call_id] = tool_name
                    self._record_semantic(
                        "tool.execution",
                        "raw_function_call",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "argumentsPreviewRedacted": redacted,
                            "argumentsPreviewTruncated": truncated,
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_start",
                        {
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "arguments": argument_preview,
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="raw_function_call_missing_call_id",
                    )
            elif item_type == "function_call_output":
                tool_call_id = (
                    item.get("call_id") if isinstance(item.get("call_id"), str) else None
                )
                output = item.get("output") if isinstance(item.get("output"), str) else ""
                output_preview, truncated = _tool_output_preview(
                    output, limit=COMMAND_OUTPUT_PREVIEW_CHARS
                )
                exit_code = _exit_code_from_command_output(output)
                success = exit_code in (0, None)
                if tool_call_id:
                    session.raw_tool_output_call_ids.add(tool_call_id)
                    tool_name = session.raw_tool_names.get(tool_call_id)
                    self._record_semantic(
                        "tool.execution",
                        "raw_function_call_output",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolCallId": tool_call_id,
                            "success": success,
                            "exitCode": exit_code,
                            "outputChars": len(output),
                            "previewTruncated": truncated,
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_complete",
                        {
                            "toolCallId": tool_call_id,
                            "success": success,
                            "model": session.model or self.options.model,
                            "toolTelemetry": {
                                "toolName": tool_name,
                                "source": "rawResponseItem",
                                "itemType": item_type,
                                "outputChars": len(output),
                                "outputPreviewTruncated": truncated,
                                "exitCode": exit_code,
                            },
                            "result": {"content": output_preview} if output_preview else None,
                            **(
                                {}
                                if success
                                else {
                                    "error": {
                                        "message": f"function call output exitCode={exit_code}",
                                    }
                                }
                            ),
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="raw_function_call_output_missing_call_id",
                    )
            elif item_type in {"tool_search_call", "tool_search_output"}:
                self._emit_codex_raw_event(
                    session,
                    method=method,
                    params=params,
                    reason="raw_tool_search_provenance",
                )
        elif method == "turn/started":
            turn = params.get("turn") if _is_record(params.get("turn")) else {}
            turn_id = turn.get("id") if isinstance(turn.get("id"), str) else None
            self._record_semantic(
                "turn.lifecycle",
                "codex_started",
                session_id=session_id,
                thread_id=thread_id,
                data={"turnId": turn_id, "status": turn.get("status")},
            )
            if turn_id:
                self._emit_codex_session_event(
                    session,
                    "assistant.turn_start",
                    {"turnId": turn_id},
                )
        elif method == "item/agentMessage/delta":
            # Codex app-server streams assistant text as item/agentMessage/delta.
            # The SDK already has assistant.message_delta for this exact shape,
            # so forwarding it here preserves the CLI-like working stream
            # without making individual product tools invent progress text.
            item_id = params.get("itemId") if isinstance(params.get("itemId"), str) else None
            delta = params.get("delta") if isinstance(params.get("delta"), str) else ""
            if item_id and delta:
                self._record_semantic(
                    "assistant.message",
                    "delta",
                    session_id=session_id,
                    thread_id=thread_id,
                    data={"messageId": item_id, "deltaChars": len(delta)},
                )
                self._emit_codex_session_event(
                    session,
                    "assistant.message_delta",
                    {"messageId": item_id, "deltaContent": delta},
                    ephemeral=True,
                )
            else:
                self._emit_codex_raw_event(
                    session,
                    method=method,
                    params=params,
                    reason="missing_agent_message_delta_identity",
                )
        elif method == "thread/tokenUsage/updated":
            token_usage = params.get("tokenUsage") if _is_record(params.get("tokenUsage")) else {}
            last = token_usage.get("last") if _is_record(token_usage.get("last")) else {}
            turn_id = params.get("turnId") if isinstance(params.get("turnId"), str) else None
            self._record_semantic(
                "assistant.usage",
                "updated",
                session_id=session_id,
                thread_id=thread_id,
                data={
                    "turnId": turn_id,
                    "inputTokens": last.get("inputTokens"),
                    "outputTokens": last.get("outputTokens"),
                    "reasoningTokens": last.get("reasoningOutputTokens"),
                    "modelContextWindow": token_usage.get("modelContextWindow"),
                },
            )
            self._emit_codex_session_event(
                session,
                "assistant.usage",
                {
                    "model": session.model or self.options.model,
                    "providerCallId": turn_id,
                    "inputTokens": last.get("inputTokens"),
                    "outputTokens": last.get("outputTokens"),
                    "cacheReadTokens": last.get("cachedInputTokens"),
                    "reasoningTokens": last.get("reasoningOutputTokens"),
                },
                ephemeral=True,
            )
        elif method == "thread/status/changed":
            self._emit_codex_raw_event(
                session,
                method=method,
                params=params,
                reason="thread_status_provenance",
            )
        elif method == "item/started":
            item = params.get("item") if _is_record(params.get("item")) else {}
            if item.get("type") == "commandExecution":
                item_id = item.get("id") if isinstance(item.get("id"), str) else None
                command = item.get("command") if isinstance(item.get("command"), str) else ""
                if item_id:
                    self.command_output_chars[item_id] = 0
                self._record_semantic(
                    "command.execution",
                    "started",
                    session_id=session_id,
                    thread_id=thread_id,
                    data={
                        "itemId": item_id,
                        "commandChars": len(command),
                        "cwd": item.get("cwd") if isinstance(item.get("cwd"), str) else None,
                        **_preview_fields("command", command),
                    },
                )
                if item_id in session.raw_tool_call_ids:
                    return
                asyncio.create_task(
                    self._emit_session_event(
                        session_id,
                        self._create_session_event(
                            session,
                            "tool.execution_start",
                            {
                                "toolName": "exec_command",
                                "toolCallId": item_id,
                                "arguments": {"command": command},
                            },
                            True,
                        ),
                    )
                )
            elif item.get("type") == "mcpToolCall":
                tool_call_id = item.get("id") if isinstance(item.get("id"), str) else None
                tool_name, server_name, mcp_tool_name = _mcp_tool_name(item)
                if tool_call_id:
                    self._record_semantic(
                        "tool.execution",
                        "mcp_started",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "server": server_name,
                            "mcpTool": mcp_tool_name,
                            **_preview_fields("arguments", item.get("arguments")),
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_start",
                        {
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "arguments": item.get("arguments"),
                            "mcpServerName": server_name,
                            "mcpToolName": mcp_tool_name,
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="mcp_tool_started_missing_identity",
                    )
            elif item.get("type") == "dynamicToolCall":
                # Codex-native dynamic tool lifecycle. This is separate from
                # the SDK tool.call callback: the lifecycle says what Codex is
                # doing, while tool.call is the transport used to obtain the
                # product tool result.
                tool_call_id = item.get("id") if isinstance(item.get("id"), str) else None
                tool_name = _first_string_field(item, "tool", "toolName", "name")
                if tool_call_id and tool_name:
                    self._record_semantic(
                        "tool.execution",
                        "codex_started",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            **_preview_fields("arguments", item.get("arguments")),
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_start",
                        {
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "arguments": item.get("arguments"),
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="dynamic_tool_started_missing_identity",
                    )
            elif item.get("type") == "reasoning":
                self._emit_codex_raw_event(
                    session,
                    method=method,
                    params=params,
                    reason="reasoning_started_without_readable_content",
                )
            else:
                self._emit_codex_raw_event(
                    session,
                    method=method,
                    params=params,
                    reason="unmapped_item_started",
                )
        elif method == "item/commandExecution/outputDelta":
            item_id = params.get("itemId") if isinstance(params.get("itemId"), str) else None
            delta = params.get("delta") if isinstance(params.get("delta"), str) else ""
            total = self.command_output_chars.get(item_id or "", 0) + len(delta)
            if item_id:
                self.command_output_chars[item_id] = total
            preview = delta[:COMMAND_OUTPUT_PREVIEW_CHARS]
            self._record_semantic(
                "command.execution",
                "output_delta",
                session_id=session_id,
                thread_id=thread_id,
                data={
                    "itemId": item_id,
                    "deltaChars": len(delta),
                    "totalOutputChars": total,
                    "preview": preview,
                    "previewTruncated": len(delta) > COMMAND_OUTPUT_PREVIEW_CHARS,
                },
            )
            asyncio.create_task(
                self._emit_session_event(
                    session_id,
                    self._create_session_event(
                        session,
                        "tool.execution_partial_result",
                        {
                            "toolCallId": item_id,
                            "partialOutput": preview,
                        },
                        True,
                    ),
                )
            )
            if item_id and total > COMMAND_OUTPUT_WARNING_CHARS:
                warning_key = f"{session_id}:{item_id}"
                if warning_key not in self.command_output_warning_emitted:
                    self.command_output_warning_emitted.add(warning_key)
                    self._record_semantic(
                        "runtime.warning",
                        "command_output_over_safe_limit",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "itemId": item_id,
                            "totalOutputChars": total,
                            "safeLimitChars": COMMAND_OUTPUT_WARNING_CHARS,
                        },
                    )
                    asyncio.create_task(
                        self._emit_session_event(
                            session_id,
                            self._create_session_event(
                                session,
                                "session.warning",
                                {
                                    "warningType": "command_output_over_safe_limit",
                                    "message": (
                                        "Codex command output exceeded the adapter safe "
                                        f"visibility limit ({total} chars > "
                                        f"{COMMAND_OUTPUT_WARNING_CHARS}). Use a narrower "
                                        "query or redirect large output to a file."
                                    ),
                                },
                                True,
                            ),
                        )
                    )
        elif method == "item/completed":
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
            elif item.get("type") == "mcpToolCall":
                tool_call_id = item.get("id") if isinstance(item.get("id"), str) else None
                tool_name, server_name, mcp_tool_name = _mcp_tool_name(item)
                status = item.get("status") if isinstance(item.get("status"), str) else None
                error_value = item.get("error")
                success = status == "completed" and error_value in (None, "")
                result_text = _text_from_mcp_result(item.get("result"))
                result_preview, result_truncated = _tool_output_preview(
                    result_text, limit=COMMAND_OUTPUT_PREVIEW_CHARS
                )
                if tool_call_id:
                    self._record_semantic(
                        "tool.execution",
                        "mcp_completed",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "status": status,
                            "success": success,
                            "durationMs": item.get("durationMs"),
                            "resultChars": len(result_text),
                            "previewTruncated": result_truncated,
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_complete",
                        {
                            "toolCallId": tool_call_id,
                            "success": success,
                            "model": session.model or self.options.model,
                            "toolTelemetry": {
                                "toolName": tool_name,
                                "mcpServerName": server_name,
                                "mcpToolName": mcp_tool_name,
                                "status": status,
                                "durationMs": item.get("durationMs"),
                                "resultChars": len(result_text),
                                "resultPreviewTruncated": result_truncated,
                            },
                            "result": {"content": result_preview}
                            if result_preview
                            else None,
                            **(
                                {}
                                if success
                                else {
                                    "error": {
                                        "message": str(error_value or f"mcp tool status={status}"),
                                    }
                                }
                            ),
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="mcp_tool_completed_missing_identity",
                    )
            elif item.get("type") == "dynamicToolCall":
                tool_call_id = item.get("id") if isinstance(item.get("id"), str) else None
                tool_name = _first_string_field(item, "tool", "toolName", "name")
                status = item.get("status") if isinstance(item.get("status"), str) else None
                success = (
                    bool(item.get("success"))
                    if item.get("success") is not None
                    else status == "completed"
                )
                content_preview = _first_text_from_content_items(item.get("contentItems"))
                if tool_call_id:
                    self._record_semantic(
                        "tool.execution",
                        "codex_completed",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "status": status,
                            "success": success,
                            "durationMs": item.get("durationMs"),
                            "contentPreviewChars": len(content_preview),
                        },
                    )
                    self._emit_codex_session_event(
                        session,
                        "tool.execution_complete",
                        {
                            "toolCallId": tool_call_id,
                            "success": success,
                            "model": session.model or self.options.model,
                            "toolTelemetry": {
                                "toolName": tool_name,
                                "status": status,
                                "durationMs": item.get("durationMs"),
                                "contentPreviewChars": len(content_preview),
                            },
                            "result": {"content": content_preview}
                            if content_preview
                            else None,
                            **(
                                {}
                                if success
                                else {
                                    "error": {
                                        "message": f"dynamic tool status={status}",
                                    }
                                }
                            ),
                        },
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="dynamic_tool_completed_missing_identity",
                    )
            elif item.get("type") == "reasoning":
                reasoning_id = item.get("id") if isinstance(item.get("id"), str) else None
                content = _reasoning_content(item)
                if reasoning_id and content:
                    self._record_semantic(
                        "assistant.reasoning",
                        "completed",
                        session_id=session_id,
                        thread_id=thread_id,
                        data={"reasoningId": reasoning_id, "contentChars": len(content)},
                    )
                    self._emit_codex_session_event(
                        session,
                        "assistant.reasoning",
                        {"reasoningId": reasoning_id, "content": content},
                        ephemeral=True,
                    )
                else:
                    self._emit_codex_raw_event(
                        session,
                        method=method,
                        params=params,
                        reason="reasoning_completed_without_readable_content",
                    )
            elif item.get("type") == "commandExecution":
                item_id = item.get("id") if isinstance(item.get("id"), str) else None
                aggregated = (
                    item.get("aggregatedOutput")
                    if isinstance(item.get("aggregatedOutput"), str)
                    else ""
                )
                output_chars = len(aggregated) or self.command_output_chars.get(item_id or "", 0)
                exit_code = item.get("exitCode")
                status = item.get("status") if isinstance(item.get("status"), str) else None
                if item_id:
                    self.command_output_chars.pop(item_id, None)
                    self.command_output_warning_emitted.discard(f"{session_id}:{item_id}")
                self._record_semantic(
                    "command.execution",
                    "completed",
                    session_id=session_id,
                    thread_id=thread_id,
                    data={
                        "itemId": item_id,
                        "status": status,
                        "exitCode": exit_code,
                        "outputChars": output_chars,
                        "durationMs": item.get("durationMs"),
                    },
                )
                if item_id in session.raw_tool_call_ids:
                    return
                asyncio.create_task(
                    self._emit_session_event(
                        session_id,
                        self._create_session_event(
                            session,
                            "tool.execution_complete",
                            {
                                "toolCallId": item_id,
                                "success": status == "completed" and exit_code in (0, None),
                                "model": session.model or self.options.model,
                                "toolTelemetry": {
                                    "outputChars": output_chars,
                                    "status": status,
                                    "exitCode": exit_code,
                                },
                                **(
                                    {}
                                    if status == "completed" and exit_code in (0, None)
                                    else {
                                        "error": {
                                            "message": (
                                                f"command status={status} exitCode={exit_code}"
                                            )
                                        }
                                    }
                                ),
                            },
                            True,
                        ),
                    )
                )
        elif method == "turn/completed":
            turn = params.get("turn") if _is_record(params.get("turn")) else {}
            status = turn.get("status") if isinstance(turn.get("status"), str) else "completed"
            turn_id = turn.get("id") if isinstance(turn.get("id"), str) else None
            self._record_semantic(
                "turn.lifecycle",
                "completed",
                session_id=session_id,
                thread_id=thread_id,
                data={"turnId": turn_id, "status": status},
            )
            if turn_id:
                self._emit_codex_session_event(
                    session,
                    "assistant.turn_end",
                    {"turnId": turn_id},
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
        tool_name = _first_string_field(params, "tool", "toolName", "name")
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
                **_preview_fields("arguments", params.get("arguments")),
            },
        )
        # Preserve the assistant's tool decision as an assistant.message with
        # toolRequests before the transport callback runs. This is the SDK's
        # native "the agent is about to call tool X" shape and gives Chat UI a
        # CLI-like step marker without asking the tool implementation to fake
        # progress.
        self._emit_codex_session_event(
            session,
            "assistant.message",
            {
                "content": "",
                "messageId": f"tool-request-{tool_call_id}",
                "phase": "tool_call",
                "toolRequests": [
                    {
                        "name": tool_name,
                        "toolCallId": tool_call_id,
                        "arguments": params.get("arguments"),
                        "type": "function",
                    }
                ],
            },
            ephemeral=True,
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
                        **_preview_fields("result", result),
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
                **_preview_fields(
                    "result",
                    params.get("result") if params.get("error") is None else params.get("error"),
                ),
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
