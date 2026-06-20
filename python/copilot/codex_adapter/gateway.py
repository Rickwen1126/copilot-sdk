"""Gateway between the adapter and ``codex app-server``."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

JsonRpcHandler = Callable[[dict[str, Any]], None]
FatalErrorHandler = Callable[[Exception, dict[str, Any]], None]
DEFAULT_SUBPROCESS_STREAM_LIMIT_BYTES = 16 * 1024 * 1024
DEFAULT_TRANSCRIPT_PAYLOAD_PREVIEW_CHARS = 2_000
DEFAULT_PAYLOAD_SPILL_THRESHOLD_BYTES = 64 * 1024
SUBPROCESS_STREAM_LIMIT_ENV = "CODEX_ADAPTER_SUBPROCESS_STREAM_LIMIT_BYTES"
TRANSCRIPT_PAYLOAD_PREVIEW_CHARS_ENV = "CODEX_ADAPTER_TRANSCRIPT_PAYLOAD_PREVIEW_CHARS"
PAYLOAD_SPILL_THRESHOLD_ENV = "CODEX_ADAPTER_PAYLOAD_SPILL_THRESHOLD_BYTES"
PAYLOAD_SPILL_DIR_ENV = "CODEX_ADAPTER_PAYLOAD_SPILL_DIR"


def _env_int(name: str, default: int, *, minimum: int = 65_536) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, value)


class CodexAppServerGatewayReaderError(RuntimeError):
    """Fatal stdout-reader failure for the line-delimited app-server transport."""

    def __init__(self, error: Exception, *, stream_limit_bytes: int):
        self.stream_limit_bytes = stream_limit_bytes
        self.original_error_name = error.__class__.__name__
        self.original_error_message = str(error)
        super().__init__(
            "codex app-server stdout reader failed "
            f"(stream_limit_bytes={stream_limit_bytes}): "
            f"{self.original_error_name}: {self.original_error_message}"
        )


@dataclass
class CodexAppServerGatewayOptions:
    codex_bin: str | None = None
    codex_home: str | None = None
    isolate_codex_home: bool = True
    request_timeout_ms: int = 45_000
    transcript_limit: int = 500
    subprocess_stream_limit_bytes: int = field(
        default_factory=lambda: _env_int(
            SUBPROCESS_STREAM_LIMIT_ENV, DEFAULT_SUBPROCESS_STREAM_LIMIT_BYTES
        )
    )
    transcript_payload_preview_chars: int = field(
        default_factory=lambda: _env_int(
            TRANSCRIPT_PAYLOAD_PREVIEW_CHARS_ENV,
            DEFAULT_TRANSCRIPT_PAYLOAD_PREVIEW_CHARS,
            minimum=0,
        )
    )
    payload_spill_threshold_bytes: int = field(
        default_factory=lambda: _env_int(
            PAYLOAD_SPILL_THRESHOLD_ENV, DEFAULT_PAYLOAD_SPILL_THRESHOLD_BYTES, minimum=1
        )
    )
    payload_spill_dir: str | None = field(
        default_factory=lambda: os.environ.get(PAYLOAD_SPILL_DIR_ENV) or None
    )
    client_info: dict[str, str | None] = field(default_factory=dict)


def _now_loop_time_ms() -> int:
    return int(asyncio.get_running_loop().time() * 1000)


class CodexAppServerGateway:
    """Line-delimited JSON-RPC gateway used by ``codex app-server``."""

    def __init__(self, options: CodexAppServerGatewayOptions | None = None):
        self.options = options or CodexAppServerGatewayOptions()
        self.process: asyncio.subprocess.Process | None = None
        self.next_id = 1
        self.pending: dict[Any, asyncio.Future[dict[str, Any]]] = {}
        self.notification_handlers: set[JsonRpcHandler] = set()
        self.request_handlers: set[JsonRpcHandler] = set()
        self.fatal_error_handlers: set[FatalErrorHandler] = set()
        self.transcript: list[dict[str, Any]] = []
        self.codex_home = self._prepare_codex_home()
        self.codex_bin = self.options.codex_bin or shutil.which("codex") or "codex"
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self.restartable = False

    def _prepare_codex_home(self) -> str:
        if self.options.codex_home and not self.options.isolate_codex_home:
            return self.options.codex_home
        source_home = Path(
            self.options.codex_home or os.environ.get("CODEX_HOME", "~/.codex")
        ).expanduser()
        adapter_home = Path(tempfile.mkdtemp(prefix="copilot-codex-adapter-"))
        for dirname in ("sessions", "archived_sessions", "tmp"):
            (adapter_home / dirname).mkdir(parents=True, exist_ok=True)
        for filename in ("auth.json", "config.toml", "installation_id", "models_cache.json"):
            source = source_home / filename
            if source.exists():
                shutil.copy2(source, adapter_home / filename)
        return str(adapter_home)

    def _record(self, direction: str, message: Any) -> None:
        self.transcript.append(
            {
                "at": _now_loop_time_ms(),
                "direction": direction,
                "message": self._transcript_message(direction, message),
            }
        )
        if len(self.transcript) > self.options.transcript_limit:
            del self.transcript[: len(self.transcript) - self.options.transcript_limit]

    def _transcript_message(self, direction: str, message: Any) -> Any:
        text = self._serialize_for_transcript(message)
        payload_bytes = len(text.encode("utf-8"))
        if payload_bytes <= self.options.payload_spill_threshold_bytes:
            return message

        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        preview_chars = self.options.transcript_payload_preview_chars
        metadata: dict[str, Any] = {
            "oversized": True,
            "payloadBytes": payload_bytes,
            "sha256": digest,
            "preview": text[:preview_chars] if preview_chars > 0 else "",
            "previewTruncated": len(text) > preview_chars,
            "spillThresholdBytes": self.options.payload_spill_threshold_bytes,
            **self._message_identity(message),
        }
        spill_path, spill_error = self._write_payload_spill(
            direction=direction,
            message=message,
            text=text,
            digest=digest,
        )
        if spill_path:
            metadata["spillPath"] = spill_path
        if spill_error:
            metadata["spillError"] = spill_error
        return metadata

    def _serialize_for_transcript(self, message: Any) -> str:
        try:
            return json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str)
        except TypeError:
            return repr(message)

    def _message_identity(self, message: Any) -> dict[str, Any]:
        if not isinstance(message, dict):
            return {}
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        thread = params.get("thread") if isinstance(params.get("thread"), dict) else {}
        return {
            key: value
            for key, value in {
                "id": message.get("id"),
                "method": message.get("method"),
                "threadId": params.get("threadId") or thread.get("id"),
                "itemId": params.get("itemId") or item.get("id"),
                "itemType": item.get("type"),
            }.items()
            if value is not None
        }

    def _write_payload_spill(
        self,
        *,
        direction: str,
        message: Any,
        text: str,
        digest: str,
    ) -> tuple[str | None, str | None]:
        if not self.options.payload_spill_dir:
            return None, None
        try:
            identity = self._message_identity(message)
            method = _safe_filename(str(identity.get("method") or "message"))
            direction_name = _safe_filename(direction)
            now = datetime.now(UTC)
            directory = Path(self.options.payload_spill_dir).expanduser() / now.strftime("%Y-%m-%d")
            directory.mkdir(parents=True, exist_ok=True)
            filename = (
                f"{now.strftime('%H%M%S')}-{direction_name}-{method}-"
                f"{digest[:12]}-{uuid4().hex[:8]}.json.gz"
            )
            path = directory / filename
            with gzip.open(path, "wt", encoding="utf-8") as handle:
                handle.write(text)
            return path.as_posix(), None
        except Exception as exc:
            return None, f"{exc.__class__.__name__}: {exc}"

    async def start(self) -> None:
        if self.process is not None:
            return
        env = dict(os.environ)
        env.pop("OPENAI_API_KEY", None)
        env["CODEX_HOME"] = self.codex_home
        self.restartable = True
        self.process = await asyncio.create_subprocess_exec(
            self.codex_bin,
            "app-server",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=self.options.subprocess_stream_limit_bytes,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        if self._reader_task:
            self._reader_task.add_done_callback(self._handle_reader_done)
        response = await self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": self.options.client_info.get("name") or "copilot_sdk_codex_adapter",
                    "title": self.options.client_info.get("title") or "Copilot SDK Codex Adapter",
                    "version": self.options.client_info.get("version") or "0.0.0",
                },
                "capabilities": {
                    "experimentalApi": True,
                    "requestAttestation": False,
                    "optOutNotificationMethods": None,
                },
            },
        )
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "codex initialize failed"))
        self.notify("initialized", {})

    def _handle_reader_done(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        error = task.exception() or RuntimeError("codex app-server stdout closed")
        metadata = self._reader_error_metadata(error)
        self._record("codex-gateway.reader_failed", {"error": metadata})
        self._fail_pending_requests(error)
        for handler in list(self.fatal_error_handlers):
            handler(error, metadata)
        self._detach_failed_process()

    def _reader_error_metadata(self, error: Exception) -> dict[str, Any]:
        metadata = {
            "errorName": error.__class__.__name__,
            "errorMessage": str(error),
            "streamLimitBytes": self.options.subprocess_stream_limit_bytes,
        }
        if isinstance(error, CodexAppServerGatewayReaderError):
            metadata.update(
                {
                    "originalErrorName": error.original_error_name,
                    "originalErrorMessage": error.original_error_message,
                    "streamLimitBytes": error.stream_limit_bytes,
                }
            )
        return metadata

    def _detach_failed_process(self) -> None:
        process = self.process
        self.process = None
        if self._stderr_task:
            self._stderr_task.cancel()
            self._stderr_task = None
        if process and process.returncode is None:
            asyncio.create_task(self._terminate_failed_process(process))

    async def _terminate_failed_process(self, process: asyncio.subprocess.Process) -> None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 0.5)
        except TimeoutError:
            process.kill()
            await process.wait()

    async def _ensure_started(self) -> None:
        if self.process is None:
            if not self.restartable:
                raise RuntimeError("codex app-server is not started")
            await self.start()

    async def request(self, method: str, params: Any = None) -> dict[str, Any]:
        await self._ensure_started()
        assert self.process and self.process.stdin
        request_id = self.next_id
        self.next_id += 1
        payload = {"id": request_id, "method": method, "params": params}
        self._record("adapter->codex", payload)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.process.stdin.write(json.dumps(payload).encode() + b"\n")
        await self.process.stdin.drain()
        try:
            return await asyncio.wait_for(future, self.options.request_timeout_ms / 1000)
        finally:
            self.pending.pop(request_id, None)

    def _fail_pending_requests(self, error: Exception) -> None:
        for future in list(self.pending.values()):
            if not future.done():
                future.set_exception(error)
        self.pending.clear()

    def notify(self, method: str, params: Any = None) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("codex app-server is not started")
        payload = {"method": method, "params": params}
        self._record("adapter->codex", payload)
        self.process.stdin.write(json.dumps(payload).encode() + b"\n")

    def respond(
        self, request_id: Any, result: Any = None, error: dict[str, Any] | None = None
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("codex app-server is not started")
        payload = {"id": request_id, **({"error": error} if error else {"result": result})}
        self._record("adapter->codex.response", payload)
        self.process.stdin.write(json.dumps(payload).encode() + b"\n")

    async def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        while True:
            try:
                line = await self.process.stdout.readline()
            except Exception as exc:
                raise CodexAppServerGatewayReaderError(
                    exc,
                    stream_limit_bytes=self.options.subprocess_stream_limit_bytes,
                ) from exc
            if not line:
                break
            try:
                message: Any = json.loads(line)
            except json.JSONDecodeError:
                message = line.decode(errors="replace").rstrip()
            self._record("codex->adapter", message)
            if isinstance(message, dict) and "id" in message and "method" not in message:
                future = self.pending.get(message["id"])
                if future and not future.done():
                    future.set_result(message)
            elif (
                isinstance(message, dict)
                and "id" in message
                and isinstance(message.get("method"), str)
            ):
                for handler in list(self.request_handlers):
                    handler(message)
            elif isinstance(message, dict) and isinstance(message.get("method"), str):
                for handler in list(self.notification_handlers):
                    handler(message)

    async def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        while True:
            line = await self.process.stderr.readline()
            if not line:
                break
            self._record("codex-stderr", line.decode(errors="replace").rstrip())

    def on_notification(self, handler: JsonRpcHandler) -> Callable[[], None]:
        self.notification_handlers.add(handler)
        return lambda: self.notification_handlers.discard(handler)

    def on_request(self, handler: JsonRpcHandler) -> Callable[[], None]:
        self.request_handlers.add(handler)
        return lambda: self.request_handlers.discard(handler)

    def on_fatal_error(self, handler: FatalErrorHandler) -> Callable[[], None]:
        self.fatal_error_handlers.add(handler)
        return lambda: self.fatal_error_handlers.discard(handler)

    async def stop(self) -> None:
        if self.process is None:
            return
        self.restartable = False
        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), 0.5)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
        self.process = None
        self._fail_pending_requests(RuntimeError("codex app-server stopped"))
        for task in (self._reader_task, self._stderr_task):
            if task:
                task.cancel()
        self._reader_task = None
        self._stderr_task = None

    def summary(self) -> dict[str, Any]:
        return {"codexHome": self.codex_home, "transcripts": self.transcript}


def _safe_filename(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in "._-" else "-" for char in value)
    return cleaned.strip(".-")[:80] or "payload"
