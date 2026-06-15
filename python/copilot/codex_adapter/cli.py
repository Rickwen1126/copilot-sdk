"""CLI entrypoint for the Python-native experimental Codex adapter."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
from pathlib import Path

from .server import CodexAdapterOptions, CodexCopilotAdapterServer


def _env_string(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _env_int(name: str) -> int | None:
    value = _env_string(name)
    return int(value) if value is not None else None


def _env_bool(name: str) -> bool | None:
    value = _env_string(name)
    return value.lower() in {"1", "true", "yes", "on"} if value is not None else None


def build_options() -> CodexAdapterOptions:
    protocol_version = _env_int("CODEX_ADAPTER_PROTOCOL_VERSION")
    if protocol_version is not None and protocol_version not in (2, 3):
        raise ValueError("CODEX_ADAPTER_PROTOCOL_VERSION must be 2 or 3")
    return CodexAdapterOptions(
        codex_bin=_env_string("CODEX_ADAPTER_CODEX_BIN"),
        codex_home=_env_string("CODEX_ADAPTER_CODEX_HOME"),
        isolate_codex_home=_env_bool("CODEX_ADAPTER_ISOLATE_CODEX_HOME")
        if _env_bool("CODEX_ADAPTER_ISOLATE_CODEX_HOME") is not None
        else True,
        host=_env_string("CODEX_ADAPTER_HOST") or "127.0.0.1",
        port=_env_int("CODEX_ADAPTER_PORT"),
        protocol_version=protocol_version or 3,  # type: ignore[arg-type]
        model=_env_string("CODEX_ADAPTER_MODEL") or "gpt-5.4",
        approval_policy=_env_string("CODEX_ADAPTER_APPROVAL_POLICY") or "on-request",
        approvals_reviewer=_env_string("CODEX_ADAPTER_APPROVALS_REVIEWER") or "auto_review",
        sandbox_mode=_env_string("CODEX_ADAPTER_SANDBOX_MODE") or "workspaceWrite",  # type: ignore[arg-type]
        network_access=_env_bool("CODEX_ADAPTER_NETWORK_ACCESS") or False,
        request_timeout_ms=_env_int("CODEX_ADAPTER_REQUEST_TIMEOUT_MS") or 45_000,
        transcript_limit=_env_int("CODEX_ADAPTER_TRANSCRIPT_LIMIT") or 500,
        runtime_session_store_path=_env_string("CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH"),
        fallback_workspace_parent=_env_string("CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT"),
        client_info={
            "name": _env_string("CODEX_ADAPTER_CLIENT_NAME"),
            "title": _env_string("CODEX_ADAPTER_CLIENT_TITLE"),
            "version": _env_string("CODEX_ADAPTER_CLIENT_VERSION"),
        },
    )


def _write_summary(path: Path, server: CodexCopilotAdapterServer) -> None:
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(server.summary(), indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


async def _flush_summary_loop(
    path: Path,
    server: CodexCopilotAdapterServer,
    interval_seconds: float,
) -> None:
    while True:
        _write_summary(path, server)
        await asyncio.sleep(interval_seconds)


async def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary-path", default=_env_string("CODEX_ADAPTER_SUMMARY_PATH"))
    args = parser.parse_args()

    server = CodexCopilotAdapterServer(build_options())
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    started = await server.start()
    summary_task: asyncio.Task[None] | None = None
    summary_path = Path(args.summary_path) if args.summary_path else None
    if summary_path:
        interval_ms = _env_int("CODEX_ADAPTER_SUMMARY_FLUSH_INTERVAL_MS") or 1_000
        summary_task = asyncio.create_task(
            _flush_summary_loop(summary_path, server, max(interval_ms, 100) / 1000)
        )
    print(
        json.dumps(
            {
                "event": "codex-adapter.listening",
                "cliUrl": started["cliUrl"],
                "port": started["port"],
                "targetProfiles": server.capabilities()["targetProfiles"],
            }
        ),
        flush=True,
    )
    await stop_event.wait()
    if summary_task:
        summary_task.cancel()
        try:
            await summary_task
        except asyncio.CancelledError:
            pass
    if summary_path:
        _write_summary(summary_path, server)
    await server.stop()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
