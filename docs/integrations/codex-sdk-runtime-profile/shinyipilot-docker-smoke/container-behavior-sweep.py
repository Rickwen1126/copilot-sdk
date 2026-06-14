#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class SweepFailure(RuntimeError):
    pass


ARTIFACT_DIR = Path(os.environ.get("ARTIFACT_DIR", "/artifacts"))
APP_URL = os.environ.get("APP_URL", "http://127.0.0.1:29999")
DB_PATH = Path(os.environ.get("CHATPILOT_DB", "/runtime/chatpilot.db"))
MODEL = os.environ.get("CODEX_ADAPTER_MODEL", "gpt-5.4-mini")
TIMEOUT_SECONDS = int(os.environ.get("SWEEP_TIMEOUT_SECONDS", "360"))
TURN_TIMEOUT_SECONDS = int(os.environ.get("SWEEP_TURN_TIMEOUT_SECONDS", "240"))
RUN_ID = os.environ.get("SWEEP_RUN_ID") or datetime.now(timezone.utc).strftime(
    "%Y%m%d-%H%M%S"
)
USER_PREFIX = os.environ.get("SWEEP_USER_PREFIX", f"docker-sweep-{RUN_ID}")
MARKER = os.environ.get("SWEEP_MARKER", f"codex docker sweep marker {RUN_ID}")

SHINYIPILOT_LOG = ARTIFACT_DIR / "shinyipilot.log"
ADAPTER_SUMMARY = ARTIFACT_DIR / "adapter-summary.json"
RESULT_PATH = ARTIFACT_DIR / "behavior-sweep-result.json"

result: dict[str, Any] = {
    "status": "running",
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "model": MODEL,
    "runId": RUN_ID,
    "userPrefix": USER_PREFIX,
    "marker": MARKER,
    "appUrl": APP_URL,
    "database": str(DB_PATH),
    "steps": [],
    "checks": [],
    "pending": [
        {
            "name": "line-related flows",
            "reason": "This Docker sweep focuses on CLI/web SDK tool dispatch; LINE webhook coverage remains in the ShinyiPilot E2E lane.",
        },
        {
            "name": "custom prompt delete prefix gap",
            "reason": "Known downstream app gap: list_custom_prompts displays short IDs while delete_custom_prompt expects a full ID.",
        },
    ],
}


def write_result(status: str) -> None:
    result["status"] = status
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    RESULT_PATH.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def record_check(name: str, passed: bool, detail: Any = None) -> None:
    entry = {"name": name, "passed": passed}
    if detail is not None:
        entry["detail"] = detail
    result["checks"].append(entry)
    if not passed:
        raise SweepFailure(f"{name}: {detail}")


def run_cli(step_name: str, prompt: str, user: str) -> str:
    command = [
        "uv",
        "run",
        "--project",
        "/workspace/shinyipilot",
        "chatpilot-cli",
        "--url",
        APP_URL,
        "chat",
        prompt,
        "--user",
        user,
    ]
    started = time.time()
    completed = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=TURN_TIMEOUT_SECONDS,
        check=False,
    )
    response = completed.stdout.strip()
    step = {
        "name": step_name,
        "kind": "cli",
        "user": user,
        "routeId": f"cli:{user}",
        "prompt": prompt,
        "response": response,
        "returnCode": completed.returncode,
        "durationSeconds": round(time.time() - started, 3),
    }
    if completed.stderr.strip():
        step["stderr"] = completed.stderr.strip()[-2000:]
    result["steps"].append(step)
    (ARTIFACT_DIR / f"sweep-{len(result['steps']):02d}-{step_name}.txt").write_text(
        response + "\n", encoding="utf-8"
    )
    record_check(f"{step_name} CLI exit", completed.returncode == 0, step)
    record_check(f"{step_name} CLI response non-empty", bool(response), step)
    record_check(
        f"{step_name} CLI response not failed",
        not re.search(r"系統暫時不可用|error|failed|失敗", response, re.IGNORECASE),
        response,
    )
    return response


def db_scalar(sql: str, params: tuple[Any, ...] = ()) -> Any:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def db_row(sql: str, params: tuple[Any, ...] = ()) -> tuple[Any, ...] | None:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(sql, params).fetchone()


def wait_until(name: str, predicate, timeout: float = 45.0, interval: float = 0.5) -> Any:
    deadline = time.time() + timeout
    last_value: Any = None
    while time.time() < deadline:
        last_value = predicate()
        if last_value:
            record_check(name, True, last_value)
            return last_value
        time.sleep(interval)
    record_check(name, False, last_value)
    return None


def log_contains(pattern: str) -> bool:
    if not SHINYIPILOT_LOG.exists():
        return False
    return re.search(pattern, SHINYIPILOT_LOG.read_text(encoding="utf-8", errors="replace")) is not None


def wait_log(name: str, pattern: str) -> None:
    wait_until(name, lambda: pattern if log_contains(pattern) else None)


def load_summary() -> dict[str, Any]:
    if not ADAPTER_SUMMARY.exists():
        return {}
    try:
        return json.loads(ADAPTER_SUMMARY.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def semantic_tool_entries(tool_name: str, category: str, event: str | None = None) -> list[dict[str, Any]]:
    summary = load_summary()
    entries = []
    for entry in summary.get("semanticLog", []):
        data = entry.get("data") if isinstance(entry.get("data"), dict) else {}
        if entry.get("category") != category:
            continue
        if event is not None and entry.get("event") != event:
            continue
        if data.get("toolName") == tool_name:
            entries.append(entry)
    return entries


def wait_semantic_tool(tool_name: str, category: str, event: str | None = None) -> None:
    wait_until(
        f"adapter semanticLog {category} {tool_name}",
        lambda: semantic_tool_entries(tool_name, category, event)[-1:]
        or None,
        timeout=60,
    )


def wait_semantic_success(tool_name: str) -> None:
    def latest_success() -> Any:
        entries = semantic_tool_entries(tool_name, "tool.sdk_result", "received")
        for entry in reversed(entries):
            data = entry.get("data") if isinstance(entry.get("data"), dict) else {}
            if data.get("success") is True:
                return {
                    "toolName": tool_name,
                    "at": entry.get("at"),
                    "resultPreview": data.get("resultPreview"),
                }
        return None

    wait_until(f"adapter semanticLog tool.sdk_result success {tool_name}", latest_success, timeout=60)


def post_json(path: str, payload: dict[str, Any], timeout: int = 60) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        APP_URL + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_memo_flow() -> None:
    user = f"{USER_PREFIX}-memo"
    route_id = f"cli:{user}"
    run_cli(
        "memo-save",
        f"請呼叫 save_memo 工具，把 memo 內容存成：{MARKER}。工具成功後只回覆 saved。不要只用文字承諾。",
        user,
    )
    wait_until(
        "memo row saved",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_memos WHERE route_id = ? AND text LIKE ?",
            (route_id, f"%{MARKER}%"),
        )
        == 1,
    )
    memo_row = db_row(
        "SELECT id, text FROM memory_memos WHERE route_id = ? AND text LIKE ? ORDER BY created_at DESC LIMIT 1",
        (route_id, f"%{MARKER}%"),
    )
    record_check("memo id captured", memo_row is not None, memo_row)
    memo_id = str(memo_row[0])
    wait_log("save_memo tool call logged", rf"\[tool_call\] tool=save_memo .*route_id={re.escape(route_id)}")
    wait_log(
        "save_memo tool result logged",
        rf"\[tool_result\] tool=save_memo .*route_id={re.escape(route_id)}.*status=success",
    )
    wait_semantic_tool("save_memo", "tool.routing", "requested")
    wait_semantic_success("save_memo")

    run_cli("memo-list", "請呼叫 list_memos 工具列出目前記憶。完成後只回覆 list-done。", user)
    wait_log("list_memos tool call logged", rf"\[tool_call\] tool=list_memos .*route_id={re.escape(route_id)}")
    wait_semantic_success("list_memos")

    run_cli(
        "memo-delete",
        f"請呼叫 delete_memo 工具刪除 memo_id={memo_id}。工具成功後只回覆 deleted。",
        user,
    )
    wait_until(
        "memo row deleted",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_memos WHERE route_id = ? AND id = ?",
            (route_id, memo_id),
        )
        == 0,
    )
    wait_log(
        "delete_memo tool result logged",
        rf"\[tool_result\] tool=delete_memo .*route_id={re.escape(route_id)}.*status=success",
    )
    wait_semantic_success("delete_memo")


def run_reminder_flow() -> None:
    user = f"{USER_PREFIX}-reminder"
    route_id = f"cli:{user}"
    text = f"{MARKER} reminder"
    run_cli(
        "reminder-add",
        (
            "請呼叫 add_reminder 工具。"
            f"text 設為「{text}」，due_at 設為 2099-01-01T00:00:00+00:00。"
            "工具成功後只回覆 reminder-added。"
        ),
        user,
    )
    wait_until(
        "reminder row saved",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_reminders WHERE route_id = ? AND text = ?",
            (route_id, text),
        )
        == 1,
    )
    wait_semantic_success("add_reminder")
    run_cli("reminder-list", "請呼叫 list_schedules 工具列出目前提醒。完成後只回覆 schedules-listed。", user)
    wait_semantic_success("list_schedules")
    run_cli("reminder-cancel", "請呼叫 cancel_schedule 工具取消第 1 筆。工具成功後只回覆 reminder-cancelled。", user)
    wait_until(
        "reminder row cancelled",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_reminders WHERE route_id = ? AND text = ?",
            (route_id, text),
        )
        == 0,
    )
    wait_semantic_success("cancel_schedule")


def run_schedule_flow() -> None:
    user = f"{USER_PREFIX}-schedule"
    route_id = f"cli:{user}"
    description = f"{MARKER} schedule"
    run_cli(
        "schedule-add",
        (
            "請呼叫 schedule_task_cron 工具。"
            "cron_expr 設為 interval 30m，"
            f"description 設為「{description}」。"
            "工具成功後只回覆 schedule-added。"
        ),
        user,
    )
    wait_until(
        "schedule row saved",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_schedules WHERE route_id = ? AND input_data LIKE ?",
            (route_id, f"%{description}%"),
        )
        == 1,
    )
    wait_semantic_success("schedule_task_cron")
    run_cli("schedule-list", "請呼叫 list_schedules 工具列出目前排程。完成後只回覆 schedules-listed。", user)
    wait_semantic_success("list_schedules")
    run_cli("schedule-cancel", "請呼叫 cancel_schedule 工具取消第 1 筆。工具成功後只回覆 schedule-cancelled。", user)
    wait_until(
        "schedule row cancelled",
        lambda: db_scalar(
            "SELECT count(*) FROM memory_schedules WHERE route_id = ? AND input_data LIKE ?",
            (route_id, f"%{description}%"),
        )
        == 0,
    )
    wait_semantic_success("cancel_schedule")


def run_web_facade_flow() -> None:
    route_id = f"web:workproof-{USER_PREFIX}"
    initial = post_json(
        "/web/chat",
        {
            "route_id": route_id,
            "chatbot": "buddy",
            "message": "請用一句話回覆 web route 收到",
            "context": {"app": "workproof", "surface": "payroll"},
        },
        timeout=120,
    )
    result["steps"].append({"name": "web-initial-chat", "kind": "web", "routeId": route_id, "response": initial})
    record_check("web initial route_id", initial.get("route_id") == route_id, initial)

    chat_result: dict[str, Any] = {}
    chat_error: dict[str, Any] = {}

    def run_chat() -> None:
        try:
            chat_result.update(
                post_json(
                    "/web/chat",
                    {
                        "route_id": route_id,
                        "chatbot": "buddy",
                        "message": (
                            "請先呼叫 getCurrentContext 工具，接著呼叫 operate 工具一次，"
                            "actionId 使用 workproof.payroll.calendar.openDayDetail，"
                            'variables 使用 {"date":"2026-04-15"}，'
                            "expectedContext 使用 getCurrentContext 回傳的 currentContext。"
                            "最後用一句話說日期明細已打開。"
                        ),
                        "context": {"app": "workproof", "surface": "payroll", "month": "2026-04"},
                    },
                    timeout=180,
                )
            )
        except Exception as exc:  # pragma: no cover - serialized into artifact
            chat_error["error"] = repr(exc)

    thread = threading.Thread(target=run_chat, daemon=True)
    thread.start()

    handled_context = False
    handled_operate = False
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline and thread.is_alive():
        poll = post_json(
            "/web/client/poll",
            {"route_id": route_id, "timeout_seconds": 5},
            timeout=15,
        )
        request = poll.get("request")
        if not request:
            continue
        tool = request.get("tool")
        if tool == "getCurrentContext":
            tool_result = {
                "status": "ok",
                "currentContext": {
                    "clientInstanceId": "docker-sweep-tab",
                    "contextToken": "dashboard.payroll:2026-04:none:1",
                    "route": "/dashboard/payroll",
                    "title": "月結算薪",
                    "facts": {"month": "2026-04"},
                },
            }
            handled_context = True
        elif tool == "listCapabilities":
            tool_result = {
                "status": "ok",
                "currentContext": {
                    "clientInstanceId": "docker-sweep-tab",
                    "contextToken": "dashboard.payroll:2026-04:none:1",
                    "route": "/dashboard/payroll",
                    "title": "月結算薪",
                    "facts": {"month": "2026-04"},
                },
                "capabilities": [
                    {
                        "actionId": "workproof.payroll.calendar.openDayDetail",
                        "family": "operate",
                        "sideEffect": "view_state_only",
                        "label": "打開日期明細",
                    }
                ],
            }
        elif tool == "operate":
            tool_result = {
                "status": "ok",
                "applied": True,
                "actionResult": {
                    "actionId": "workproof.payroll.calendar.openDayDetail",
                    "status": "ok",
                    "sideEffect": "view_state_only",
                    "sideEffectApplied": True,
                    "message": "已打開 2026-04-15 日期明細。",
                    "resultSnapshot": {
                        "date": "2026-04-15",
                        "visibleSummary": "日期明細已打開，來源 anchor 可見。",
                    },
                },
                "currentContext": {
                    "clientInstanceId": "docker-sweep-tab",
                    "contextToken": "dashboard.payroll:2026-04:day-detail:2",
                    "route": "/dashboard/payroll",
                    "title": "薪資日期明細",
                    "facts": {"month": "2026-04", "date": "2026-04-15"},
                },
            }
            handled_operate = True
        else:
            raise SweepFailure(f"unexpected web tool request: {request}")
        post_json(
            "/web/client/tool-result",
            {"route_id": route_id, "request_id": request["request_id"], "result": tool_result},
            timeout=15,
        )
        if handled_context and handled_operate:
            break

    thread.join(timeout=180)
    web_step = {
        "name": "web-tools",
        "kind": "web",
        "routeId": route_id,
        "handledContext": handled_context,
        "handledOperate": handled_operate,
        "chat": chat_result,
        "error": chat_error,
    }
    result["steps"].append(web_step)
    record_check("web getCurrentContext handled", handled_context, web_step)
    record_check("web operate handled", handled_operate, web_step)
    record_check("web chat no error", not chat_error, web_step)
    wait_log("web getCurrentContext tool call logged", rf"\[tool_call\] tool=getCurrentContext route_id={re.escape(route_id)}")
    wait_log("web operate tool call logged", rf"\[tool_call\] tool=operate route_id={re.escape(route_id)}")
    wait_semantic_success("getCurrentContext")
    wait_semantic_success("operate")


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + TIMEOUT_SECONDS
    try:
        run_memo_flow()
        run_reminder_flow()
        run_schedule_flow()
        run_web_facade_flow()
        if time.time() > deadline:
            raise SweepFailure("sweep exceeded configured timeout")
        summary = load_summary()
        result["adapterSemanticEntryCount"] = len(summary.get("semanticLog", []))
        result["adapterSessionCount"] = len(summary.get("sessions", []))
        write_result("pass")
    except Exception as exc:
        result["error"] = repr(exc)
        write_result("fail")
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
