#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
RUNTIME_DIR="${RUNTIME_DIR:-/runtime}"
CONTAINER_STATE_DIR="${CONTAINER_STATE_DIR:-/container-state}"
CODEX_AUTH_SOURCE="${CODEX_AUTH_SOURCE:-/host-codex-home}"
CODEX_CLEAN_HOME="${CODEX_CLEAN_HOME:-${CONTAINER_STATE_DIR}/codex-clean-home}"
MODEL="${CODEX_ADAPTER_MODEL:-gpt-5.4-mini}"
PRODUCTION_LINE_MODE="${PRODUCTION_LINE_MODE:-shadow}"
APP_PORT="${APP_PORT:-29999}"
ADAPTER_PORT="${CODEX_ADAPTER_PORT:-4873}"

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

mkdir -p \
    "${ARTIFACT_DIR}" \
    "${RUNTIME_DIR}" \
    "${CONTAINER_STATE_DIR}" \
    "${CONTAINER_STATE_DIR}/uv-cache" \
    "${RUNTIME_DIR}/codex-workspaces" \
    "${CODEX_CLEAN_HOME}"

export UV_CACHE_DIR="${CONTAINER_STATE_DIR}/uv-cache"

if [[ ! -r "${CODEX_AUTH_SOURCE}/auth.json" ]]; then
    fail "missing readable Codex auth at ${CODEX_AUTH_SOURCE}/auth.json; mount a logged-in Codex home read-only"
fi
if [[ ! -r "/host-config/route_settings.yaml" ]]; then
    fail "missing mounted route settings: /host-config/route_settings.yaml"
fi
if [[ ! -r "/host-config/route_bindings.yaml" ]]; then
    fail "missing mounted route bindings: /host-config/route_bindings.yaml"
fi

cp -a "${CODEX_AUTH_SOURCE}/auth.json" "${CODEX_CLEAN_HOME}/auth.json"
for filename in "installation_id" "models_cache.json"; do
    if [[ -f "${CODEX_AUTH_SOURCE}/${filename}" ]]; then
        cp -a "${CODEX_AUTH_SOURCE}/${filename}" "${CODEX_CLEAN_HOME}/${filename}"
    fi
done
cat > "${CODEX_CLEAN_HOME}/config.toml" <<EOF
# Minimal Codex config generated inside the ShinyiPilot production-line container.
# Host config.toml is intentionally not copied into this lane.
EOF
cp -a "${CODEX_CLEAN_HOME}/config.toml" "${ARTIFACT_DIR}/codex-config.toml"

if [[ -L "/workspace/shinyipilot/data" ]]; then
    rm "/workspace/shinyipilot/data"
elif [[ -d "/workspace/shinyipilot/data" ]]; then
    rmdir "/workspace/shinyipilot/data" 2>/dev/null \
        || fail "/workspace/shinyipilot/data exists and is not an empty image-owned directory"
fi
ln -s "${RUNTIME_DIR}" "/workspace/shinyipilot/data"

export ROUTE_SETTINGS_PATH="/host-config/route_settings.yaml"
export ROUTE_BINDINGS_PATH="/host-config/route_bindings.yaml"
export CHATPILOT_DB="${RUNTIME_DIR}/chatpilot.db"
export CHATPILOT_TASK_DB="${RUNTIME_DIR}/tasks.db"
export CHATPILOT_FILES_DB="${RUNTIME_DIR}/files.db"
export CHATPILOT_FILE_ASSETS_DIR="${RUNTIME_DIR}/file_assets"
export CHATPILOT_RUNTIME_BACKEND="codex-adapter"
export CHATPILOT_COPILOT_CLI_URL="127.0.0.1:${ADAPTER_PORT}"
export CODEX_ADAPTER_MODEL="${MODEL}"
export PORT="${APP_PORT}"

CODEX_ADAPTER_HOST="127.0.0.1" \
CODEX_ADAPTER_PORT="${ADAPTER_PORT}" \
CODEX_ADAPTER_PROTOCOL_VERSION="2" \
CODEX_ADAPTER_CODEX_HOME="${CODEX_CLEAN_HOME}" \
CODEX_ADAPTER_ISOLATE_CODEX_HOME="true" \
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="${RUNTIME_DIR}/codex-runtime-sessions.json" \
CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT="${RUNTIME_DIR}/codex-workspaces" \
CODEX_ADAPTER_MODEL="${MODEL}" \
CODEX_ADAPTER_APPROVAL_POLICY="${CODEX_ADAPTER_APPROVAL_POLICY:-on-request}" \
CODEX_ADAPTER_APPROVALS_REVIEWER="${CODEX_ADAPTER_APPROVALS_REVIEWER:-auto_review}" \
CODEX_ADAPTER_SANDBOX_MODE="${CODEX_ADAPTER_SANDBOX_MODE:-workspaceWrite}" \
CODEX_ADAPTER_NETWORK_ACCESS="${CODEX_ADAPTER_NETWORK_ACCESS:-false}" \
CODEX_ADAPTER_REQUEST_TIMEOUT_MS="${CODEX_ADAPTER_REQUEST_TIMEOUT_MS:-45000}" \
CODEX_ADAPTER_TRANSCRIPT_LIMIT="${CODEX_ADAPTER_TRANSCRIPT_LIMIT:-800}" \
CODEX_ADAPTER_CLIENT_NAME="shinyipilot-production-line" \
CODEX_ADAPTER_CLIENT_TITLE="ShinyiPilot Production LINE Lab" \
/workspace/shinyipilot/.venv/bin/copilot-codex-adapter \
    --summary-path "${ARTIFACT_DIR}/adapter-summary.json" \
    > "${ARTIFACT_DIR}/adapter.log" 2>&1 &
ADAPTER_PID="$!"
wait_for_tcp "127.0.0.1" "${ADAPTER_PORT}" "codex adapter"

/workspace/shinyipilot/.venv/bin/uvicorn chatpilot.server:create_app \
    --factory --host 127.0.0.1 --port "${APP_PORT}" \
    > "${ARTIFACT_DIR}/shinyipilot.log" 2>&1 &
APP_PID="$!"
wait_for_http "http://127.0.0.1:${APP_PORT}/health" "ShinyiPilot"

if [[ "${PRODUCTION_LINE_MODE}" == "shadow" ]]; then
    ARTIFACT_DIR="${ARTIFACT_DIR}" \
    RUNTIME_DIR="${RUNTIME_DIR}" \
    APP_URL="http://127.0.0.1:${APP_PORT}" \
    ROUTE_SETTINGS_PATH="${ROUTE_SETTINGS_PATH}" \
    ROUTE_BINDINGS_PATH="${ROUTE_BINDINGS_PATH}" \
    CHATPILOT_DB="${CHATPILOT_DB}" \
    CHATPILOT_RUNTIME_BACKEND="${CHATPILOT_RUNTIME_BACKEND}" \
    CODEX_ADAPTER_MODEL="${MODEL}" \
    python /usr/local/bin/shinyipilot-line-shadow-preflight

    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
    APP_PID=""
    kill "${ADAPTER_PID}" 2>/dev/null || true
    wait "${ADAPTER_PID}" 2>/dev/null || true
    ADAPTER_PID=""

    echo "PASS: ShinyiPilot production-line shadow preflight"
    echo "model=${MODEL}"
    echo "artifacts=${ARTIFACT_DIR}"
    exit 0
fi

if [[ "${PRODUCTION_LINE_MODE}" != "serve" && "${PRODUCTION_LINE_MODE}" != "cutover" ]]; then
    fail "unknown PRODUCTION_LINE_MODE=${PRODUCTION_LINE_MODE}"
fi

MODEL="${MODEL}" \
APP_PORT="${APP_PORT}" \
ADAPTER_PORT="${ADAPTER_PORT}" \
PRODUCTION_LINE_MODE="${PRODUCTION_LINE_MODE}" \
python - "${ARTIFACT_DIR}/production-line-ready.json" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "status": "ready",
            "mode": os.environ["PRODUCTION_LINE_MODE"],
            "model": os.environ["MODEL"],
            "appUrl": f"http://127.0.0.1:{os.environ['APP_PORT']}",
            "adapterUrl": f"127.0.0.1:{os.environ['ADAPTER_PORT']}",
            "readyAt": datetime.now(timezone.utc).isoformat(),
        },
        indent=2,
        ensure_ascii=False,
    )
    + "\n",
    encoding="utf-8",
)
PY

echo "READY: ShinyiPilot production-line ${PRODUCTION_LINE_MODE}"
echo "model=${MODEL}"
echo "artifacts=${ARTIFACT_DIR}"
wait -n "${ADAPTER_PID}" "${APP_PID}"
exit 1
