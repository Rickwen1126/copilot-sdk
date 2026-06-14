#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
RUNTIME_DIR="${RUNTIME_DIR:-/runtime}"
CODEX_AUTH_SOURCE="${CODEX_AUTH_SOURCE:-/host-codex-home}"
MODEL="${CODEX_ADAPTER_MODEL:-gpt-5.4-mini}"
SMOKE_USER="${SMOKE_USER:-codex-docker-smoke}"
SMOKE_MARKER="${SMOKE_MARKER:-codex docker smoke marker $(date +%Y%m%d-%H%M%S)}"
APP_PORT="${APP_PORT:-29999}"
ADAPTER_PORT="${CODEX_ADAPTER_PORT:-4873}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-240}"

ADAPTER_PID=""
APP_PID=""

cleanup() {
    if [[ -n "${APP_PID}" ]]; then
        kill "${APP_PID}" 2>/dev/null || true
        wait "${APP_PID}" 2>/dev/null || true
    fi
    if [[ -n "${ADAPTER_PID}" ]]; then
        kill "${ADAPTER_PID}" 2>/dev/null || true
        wait "${ADAPTER_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    if [[ -f "${ARTIFACT_DIR}/shinyipilot.log" ]]; then
        echo "---- shinyipilot.log tail ----" >&2
        tail -n 80 "${ARTIFACT_DIR}/shinyipilot.log" >&2 || true
    fi
    if [[ -f "${ARTIFACT_DIR}/adapter.log" ]]; then
        echo "---- adapter.log tail ----" >&2
        tail -n 80 "${ARTIFACT_DIR}/adapter.log" >&2 || true
    fi
    exit 1
}

wait_for_tcp() {
    local host="$1"
    local port="$2"
    local label="$3"
    python - "$host" "$port" "$label" <<'PY'
import socket
import sys
import time

host, port, label = sys.argv[1], int(sys.argv[2]), sys.argv[3]
deadline = time.time() + 60
last_error = None
while time.time() < deadline:
    try:
        with socket.create_connection((host, port), timeout=1):
            sys.exit(0)
    except OSError as exc:
        last_error = exc
        time.sleep(0.5)
raise SystemExit(f"{label} did not accept TCP connections: {last_error}")
PY
}

wait_for_http() {
    local url="$1"
    local label="$2"
    local deadline=$((SECONDS + 90))
    until curl -fsS "${url}" >/dev/null; do
        if (( SECONDS >= deadline )); then
            fail "${label} did not become healthy at ${url}"
        fi
        sleep 1
    done
}

mkdir -p "${ARTIFACT_DIR}" "${RUNTIME_DIR}" "${RUNTIME_DIR}/codex-workspaces"

if [[ ! -r "${CODEX_AUTH_SOURCE}/auth.json" ]]; then
    fail "missing readable Codex auth at ${CODEX_AUTH_SOURCE}/auth.json; mount a logged-in Codex home read-only"
fi

export ROUTE_SETTINGS_PATH="${RUNTIME_DIR}/route_settings.codex.yaml"
export ROUTE_BINDINGS_PATH="${RUNTIME_DIR}/route_bindings.codex.yaml"
export CHATPILOT_DB="${RUNTIME_DIR}/chatpilot.db"
export CHATPILOT_TASK_DB="${RUNTIME_DIR}/tasks.db"
export CHATPILOT_FILES_DB="${RUNTIME_DIR}/files.db"
export CHATPILOT_RUNTIME_BACKEND="codex-adapter"
export CHATPILOT_COPILOT_CLI_URL="127.0.0.1:${ADAPTER_PORT}"
export CODEX_ADAPTER_MODEL="${MODEL}"
export PORT="${APP_PORT}"

uv run --project /workspace/shinyipilot python - <<'PY'
import os
from pathlib import Path

import yaml

model = os.environ["CODEX_ADAPTER_MODEL"]
settings_src = Path("/workspace/shinyipilot/config/route_settings.example.yaml")
settings_dst = Path(os.environ["ROUTE_SETTINGS_PATH"])
bindings_src = Path("/workspace/shinyipilot/config/route_bindings.example.yaml")
bindings_dst = Path(os.environ["ROUTE_BINDINGS_PATH"])

settings = yaml.safe_load(settings_src.read_text(encoding="utf-8"))
for chatbot in settings.get("chatbots", {}).values():
    chatbot["model"] = model

settings_dst.parent.mkdir(parents=True, exist_ok=True)
settings_dst.write_text(
    yaml.safe_dump(settings, sort_keys=False, allow_unicode=True),
    encoding="utf-8",
)
bindings_dst.write_text(bindings_src.read_text(encoding="utf-8"), encoding="utf-8")
PY

CODEX_ADAPTER_HOST="127.0.0.1" \
CODEX_ADAPTER_PORT="${ADAPTER_PORT}" \
CODEX_ADAPTER_PROTOCOL_VERSION="2" \
CODEX_ADAPTER_CODEX_HOME="${CODEX_AUTH_SOURCE}" \
CODEX_ADAPTER_ISOLATE_CODEX_HOME="true" \
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="${RUNTIME_DIR}/codex-runtime-sessions.json" \
CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT="${RUNTIME_DIR}/codex-workspaces" \
CODEX_ADAPTER_MODEL="${MODEL}" \
CODEX_ADAPTER_APPROVAL_POLICY="on-request" \
CODEX_ADAPTER_APPROVALS_REVIEWER="auto_review" \
CODEX_ADAPTER_SANDBOX_MODE="workspaceWrite" \
CODEX_ADAPTER_NETWORK_ACCESS="false" \
CODEX_ADAPTER_REQUEST_TIMEOUT_MS="45000" \
CODEX_ADAPTER_TRANSCRIPT_LIMIT="800" \
CODEX_ADAPTER_CLIENT_NAME="shinyipilot-docker-smoke" \
CODEX_ADAPTER_CLIENT_TITLE="ShinyiPilot Docker Smoke" \
uv run --project /workspace/shinyipilot copilot-codex-adapter \
    --summary-path "${ARTIFACT_DIR}/adapter-summary.json" \
    > "${ARTIFACT_DIR}/adapter.log" 2>&1 &
ADAPTER_PID="$!"
wait_for_tcp "127.0.0.1" "${ADAPTER_PORT}" "codex adapter"

uv run --project /workspace/shinyipilot uvicorn chatpilot.server:create_app \
    --factory --host 127.0.0.1 --port "${APP_PORT}" \
    > "${ARTIFACT_DIR}/shinyipilot.log" 2>&1 &
APP_PID="$!"
wait_for_http "http://127.0.0.1:${APP_PORT}/health" "ShinyiPilot"

PROMPT="請呼叫 save_memo 工具，把 memo 內容存成：${SMOKE_MARKER}。工具成功後只回覆 saved。不要只用文字承諾。"
timeout "${SMOKE_TIMEOUT_SECONDS}" \
    uv run --project /workspace/shinyipilot chatpilot-cli \
        --url "http://127.0.0.1:${APP_PORT}" \
        chat "${PROMPT}" --user "${SMOKE_USER}" \
    > "${ARTIFACT_DIR}/cli-response.txt"

if [[ ! -s "${ARTIFACT_DIR}/cli-response.txt" ]]; then
    fail "empty CLI response"
fi
if grep -En "系統暫時不可用|error|failed|失敗" "${ARTIFACT_DIR}/cli-response.txt" >/dev/null; then
    fail "CLI response looks failed: $(cat "${ARTIFACT_DIR}/cli-response.txt")"
fi

MEMO_COUNT="$(
    sqlite3 "${CHATPILOT_DB}" \
        "SELECT count(*) FROM memory_memos WHERE route_id LIKE '%${SMOKE_USER}%' AND text LIKE '%${SMOKE_MARKER}%';"
)"
if [[ "${MEMO_COUNT}" != "1" ]]; then
    fail "expected exactly one matching memo row, got ${MEMO_COUNT}"
fi

grep -En "\\[tool_call\\].*save_memo" "${ARTIFACT_DIR}/shinyipilot.log" >/dev/null \
    || fail "missing ShinyiPilot save_memo tool_call log"
grep -En "\\[tool_result\\].*save_memo.*status=success" "${ARTIFACT_DIR}/shinyipilot.log" >/dev/null \
    || fail "missing ShinyiPilot save_memo success tool_result log"

kill "${APP_PID}" 2>/dev/null || true
wait "${APP_PID}" 2>/dev/null || true
APP_PID=""
kill "${ADAPTER_PID}" 2>/dev/null || true
wait "${ADAPTER_PID}" 2>/dev/null || true
ADAPTER_PID=""

sqlite3 "${CHATPILOT_DB}" "PRAGMA wal_checkpoint(FULL);" >/dev/null || true
cp -a "${CHATPILOT_DB}" "${ARTIFACT_DIR}/chatpilot.db"
for suffix in "-wal" "-shm"; do
    if [[ -f "${CHATPILOT_DB}${suffix}" ]]; then
        cp -a "${CHATPILOT_DB}${suffix}" "${ARTIFACT_DIR}/chatpilot.db${suffix}"
    fi
done

ARTIFACT_MEMO_COUNT="$(
    sqlite3 "${ARTIFACT_DIR}/chatpilot.db" \
        "SELECT count(*) FROM memory_memos WHERE route_id LIKE '%${SMOKE_USER}%' AND text LIKE '%${SMOKE_MARKER}%';"
)"
if [[ "${ARTIFACT_MEMO_COUNT}" != "1" ]]; then
    fail "copied chatpilot.db artifact lost memo row; expected 1, got ${ARTIFACT_MEMO_COUNT}"
fi

MODEL="${MODEL}" \
SMOKE_MARKER="${SMOKE_MARKER}" \
SMOKE_USER="${SMOKE_USER}" \
MEMO_COUNT="${MEMO_COUNT}" \
ARTIFACT_MEMO_COUNT="${ARTIFACT_MEMO_COUNT}" \
python - "${ARTIFACT_DIR}/adapter-summary.json" "${ARTIFACT_DIR}/smoke-result.json" "${ARTIFACT_DIR}/cli-response.txt" <<'PY'
import json
import os
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
result_path = Path(sys.argv[2])
cli_response_path = Path(sys.argv[3])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
semantic_events = {
    (entry.get("category"), entry.get("event"))
    for entry in summary.get("semanticLog", [])
}
required = {
    ("session.lifecycle", "created"),
    ("turn.lifecycle", "started"),
    ("tool.routing", "requested"),
    ("tool.sdk_call", "dispatched"),
    ("tool.sdk_result", "received"),
}
missing = sorted(required - semantic_events)
if missing:
    raise SystemExit(f"adapter semanticLog missing required events: {missing}")
result_path.write_text(
    json.dumps(
        {
            "status": "pass",
            "model": os.environ["MODEL"],
            "smokeUser": os.environ["SMOKE_USER"],
            "marker": os.environ["SMOKE_MARKER"],
            "cliResponse": cli_response_path.read_text(encoding="utf-8").strip(),
            "sqlite": {
                "databaseArtifact": "chatpilot.db",
                "matchingMemoryMemoRows": int(os.environ["MEMO_COUNT"]),
                "artifactReadbackMemoryMemoRows": int(os.environ["ARTIFACT_MEMO_COUNT"]),
            },
            "shinyipilotLogChecks": {
                "saveMemoToolCall": True,
                "saveMemoToolResultSuccess": True,
            },
            "semanticEventsChecked": sorted([f"{a}:{b}" for a, b in required]),
        },
        indent=2,
        ensure_ascii=False,
    )
    + "\n",
    encoding="utf-8",
)
PY

echo "PASS: ShinyiPilot Codex Docker smoke"
echo "model=${MODEL}"
echo "marker=${SMOKE_MARKER}"
echo "artifacts=${ARTIFACT_DIR}"
