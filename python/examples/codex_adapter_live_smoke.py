from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import signal
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from copilot import CopilotClient, PermissionHandler, RuntimeConnection


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _extract_codex_methods(summary: dict[str, Any]) -> list[str]:
    codex = summary.get("codex")
    transcripts = codex.get("transcripts") if _is_record(codex) else None
    methods: list[str] = []
    if not isinstance(transcripts, list):
        return methods
    for entry in transcripts:
        if not _is_record(entry):
            continue
        message = entry.get("message")
        if _is_record(message) and isinstance(message.get("method"), str):
            methods.append(message["method"])
    return methods


def _adapter_transcript_entries(summary: dict[str, Any]) -> list[dict[str, Any]]:
    entries = summary.get("adapterTranscript")
    return entries if isinstance(entries, list) else []


def _codex_transcript_entries(summary: dict[str, Any]) -> list[dict[str, Any]]:
    codex = summary.get("codex")
    entries = codex.get("transcripts") if _is_record(codex) else None
    return entries if isinstance(entries, list) else []


def _find_adapter_request(summary: dict[str, Any], method: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for entry in _adapter_transcript_entries(summary):
        if not _is_record(entry) or entry.get("direction") != "sdk->adapter.request":
            continue
        message = entry.get("message")
        if not _is_record(message) or message.get("method") != method:
            continue
        params = message.get("params")
        matches.append(params if _is_record(params) else {})
    return matches


def _find_codex_request(summary: dict[str, Any], method: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for entry in _codex_transcript_entries(summary):
        if not _is_record(entry) or entry.get("direction") != "adapter->codex":
            continue
        message = entry.get("message")
        if not _is_record(message) or message.get("method") != method:
            continue
        params = message.get("params")
        matches.append(params if _is_record(params) else {})
    return matches


async def _read_first_stdout_line(process: asyncio.subprocess.Process) -> dict[str, Any]:
    assert process.stdout is not None
    raw = await asyncio.wait_for(process.stdout.readline(), timeout=20)
    if not raw:
        stderr = await process.stderr.read() if process.stderr is not None else b""
        raise RuntimeError(f"adapter exited before listen event: {stderr.decode(errors='replace')}")
    line = raw.decode().strip()
    payload = json.loads(line)
    if not _is_record(payload) or payload.get("event") != "codex-adapter.listening":
        raise RuntimeError(f"unexpected adapter startup line: {line}")
    return payload


async def _terminate_adapter(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=10)
    except TimeoutError:
        process.kill()
        await process.wait()


async def run_smoke(out_path: Path, raw_summary_path: Path) -> dict[str, Any]:
    runtime_store = raw_summary_path.with_suffix(".sessions.json")
    adapter_env = {
        **os.environ,
        "CODEX_ADAPTER_PROTOCOL_VERSION": "3",
        "CODEX_ADAPTER_MODEL": "gpt-5.4",
        "CODEX_ADAPTER_APPROVAL_POLICY": "on-request",
        "CODEX_ADAPTER_APPROVALS_REVIEWER": "auto_review",
        "CODEX_ADAPTER_SANDBOX_MODE": "workspaceWrite",
        "CODEX_ADAPTER_NETWORK_ACCESS": "0",
        "CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH": str(runtime_store),
        "CODEX_ADAPTER_ISOLATE_CODEX_HOME": "true",
    }

    process = await asyncio.create_subprocess_exec(
        "copilot-codex-adapter",
        "--summary-path",
        str(raw_summary_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=adapter_env,
    )

    result: dict[str, Any] = {
        "artifact": "python-native-codex-adapter-live-smoke",
        "createdAt": _now_iso(),
        "status": "fail",
        "rawAdapterSummaryPath": str(raw_summary_path),
        "runtimeSessionStorePath": str(runtime_store),
        "config": {
            "protocolVersion": 3,
            "model": "gpt-5.4",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandboxMode": "workspaceWrite",
            "networkAccess": False,
            "isolateCodexHome": True,
        },
        "reservedPortsUntouched": ["4800", "4801", "4811"],
    }

    client: CopilotClient | None = None
    session_id: str | None = None

    try:
        startup = await _read_first_stdout_line(process)
        cli_url = startup["cliUrl"]
        result["adapterListen"] = startup

        client = CopilotClient(connection=RuntimeConnection.for_uri(cli_url))
        await client.start()

        ping = await client.ping("python-live-smoke")
        status = await client.get_status()
        auth = await client.get_auth_status()
        models = await client.list_models()

        session = await client.create_session(
            model="gpt-5.4",
            reasoning_effort="high",
            working_directory=str(Path.cwd().parent),
            on_permission_request=PermissionHandler.approve_all,
        )
        session_id = session.session_id
        current_before = await session.rpc.model.get_current()
        assistant = await session.send_and_wait(
            "Reply with PYTHON_ADAPTER_TURN1_OK and nothing else.",
            timeout=60,
        )
        # This is the critical live-switch contract: update only the running
        # session's model settings, keep the same session/thread, and let the
        # next turn carry the new reasoning effort into `turn/start`.
        await session.set_model("gpt-5.4", reasoning_effort="none")
        current_after = await session.rpc.model.get_current()
        assistant_after_switch = await session.send_and_wait(
            "Reply with PYTHON_ADAPTER_TURN2_OK and nothing else.",
            timeout=60,
        )
        messages = await session.get_events()

        resumed = await client.resume_session(
            session_id,
            model="gpt-5.4",
            on_permission_request=PermissionHandler.approve_all,
        )
        resumed_session_id = resumed.session_id
        await resumed.disconnect()
        await client.delete_session(resumed.session_id)

        result["probe"] = {
            "ping": {
                "message": ping.message,
                "protocolVersion": ping.protocolVersion,
            },
            "status": {
                "version": status.version,
                "protocolVersion": status.protocolVersion,
            },
            "auth": {
                "isAuthenticated": auth.isAuthenticated,
                "authType": auth.authType,
                "loginPresent": auth.login is not None,
                "statusMessage": auth.statusMessage,
            },
            "models": {
                "count": len(models),
                "firstModelId": models[0].id if models else None,
            },
            "assistantMessage": assistant.data.content if assistant else None,
            "assistantMessageAfterSwitch": (
                assistant_after_switch.data.content
                if assistant_after_switch
                else None
            ),
            "eventTypes": sorted(event.type.value for event in messages),
            "sessionIdPresent": session_id is not None,
            "sessionId": session_id,
            "resumedSessionId": resumed_session_id,
            "rpcCurrentModelBeforeSwitch": current_before.model_id,
            "rpcCurrentModelAfterSwitch": current_after.model_id,
            "deletedSessionId": resumed.session_id,
        }
        result["status"] = "pass"
    except Exception as exc:
        result["error"] = {
            "name": exc.__class__.__name__,
            "message": str(exc),
        }
    finally:
        if client is not None:
            try:
                await client.force_stop()
            except Exception:
                pass
        await _terminate_adapter(process)

    raw_summary = json.loads(raw_summary_path.read_text()) if raw_summary_path.exists() else {}
    raw_summary_text = json.dumps(raw_summary, separators=(",", ":"))
    codex_methods = _extract_codex_methods(raw_summary)
    session_create_requests = _find_adapter_request(raw_summary, "session.create")
    session_switch_requests = _find_adapter_request(
        raw_summary, "session.model.switchTo"
    )
    thread_start_requests = _find_codex_request(raw_summary, "thread/start")
    turn_start_requests = _find_codex_request(raw_summary, "turn/start")
    first_turn_start = turn_start_requests[0] if turn_start_requests else {}
    second_turn_start = turn_start_requests[1] if len(turn_start_requests) > 1 else {}
    first_thread_id = first_turn_start.get("threadId")
    second_thread_id = second_turn_start.get("threadId")
    result["adapterSummary"] = {
        "sha256": _sha256_text(raw_summary_text) if raw_summary else None,
        "codexHomePresent": bool(
            _is_record(raw_summary.get("codex"))
            and isinstance(raw_summary["codex"].get("codexHome"), str)
        ),
        "sessionCount": len(raw_summary.get("sessions", []))
        if isinstance(raw_summary.get("sessions"), list)
        else 0,
        "codexMethods": codex_methods,
        "requiredMethodsPresent": {
            method: method in codex_methods
            for method in [
                "account/read",
                "model/list",
                "thread/start",
                "turn/start",
                "thread/resume",
                "thread/archive",
            ]
        },
        "sessionCreate": {
            "count": len(session_create_requests),
            "reasoningEffort": session_create_requests[0].get("reasoningEffort")
            if session_create_requests
            else None,
        },
        "modelSwitch": {
            "count": len(session_switch_requests),
            "sessionId": session_switch_requests[0].get("sessionId")
            if session_switch_requests
            else None,
            "modelId": session_switch_requests[0].get("modelId")
            if session_switch_requests
            else None,
            "reasoningEffort": session_switch_requests[0].get("reasoningEffort")
            if session_switch_requests
            else None,
        },
        "threadStart": {
            "count": len(thread_start_requests),
            "model": thread_start_requests[0].get("model")
            if thread_start_requests
            else None,
            "reasoningEffort": thread_start_requests[0].get("reasoningEffort")
            if thread_start_requests
            else None,
        },
        "turnStartProof": {
            "count": len(turn_start_requests),
            "first": {
                "threadId": first_thread_id,
                "model": first_turn_start.get("model"),
                "reasoningEffort": first_turn_start.get("reasoningEffort"),
            },
            "second": {
                "threadId": second_thread_id,
                "model": second_turn_start.get("model"),
                "reasoningEffort": second_turn_start.get("reasoningEffort"),
            },
            "sameThreadAcrossTurns": bool(
                first_thread_id and first_thread_id == second_thread_id
            ),
            "reasoningSwitchedHighToNone": (
                first_turn_start.get("reasoningEffort") == "high"
                and second_turn_start.get("reasoningEffort") == "none"
            ),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    return result


async def main_async() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--raw-summary-path")
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    if args.raw_summary_path:
        raw_summary_path = Path(args.raw_summary_path).resolve()
    else:
        fd, temp_path = tempfile.mkstemp(
            prefix="python-codex-adapter-live-smoke-", suffix=".json"
        )
        os.close(fd)
        raw_summary_path = Path(temp_path)

    result = await run_smoke(out_path, raw_summary_path)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
