#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

IMAGE="${IMAGE:-copilot-sdk/shinyipilot-codex-production-line:local}"
TIMESTAMP="${TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"
PRODUCTION_LINE_MODE="${PRODUCTION_LINE_MODE:-shadow}"
CODEX_AUTH_HOME="${CODEX_AUTH_HOME:-${HOME}/.codex}"
CODEX_ADAPTER_MODEL="${CODEX_ADAPTER_MODEL:-gpt-5.4-mini}"
SHINYIPILOT_SOURCE="${SHINYIPILOT_SOURCE:-${HOME}/code/shinyipilot}"
SHINYIPILOT_ADAPTER_COMPAT_SOURCE="${SHINYIPILOT_ADAPTER_COMPAT_SOURCE:-${REPO_ROOT}/shinyipilot-spike}"
ROUTE_SETTINGS_SOURCE="${ROUTE_SETTINGS_SOURCE:-${SHINYIPILOT_SOURCE}/config/route_settings.yaml}"
ROUTE_BINDINGS_SOURCE="${ROUTE_BINDINGS_SOURCE:-${SHINYIPILOT_SOURCE}/config/route_bindings.yaml}"
STATE_ROOT="${STATE_ROOT:-${HOME}/.local/state/shinyipilot-codex-line}"
RUNTIME_DIR="${RUNTIME_DIR:-${STATE_ROOT}/runtime}"
BACKUP_ROOT="${BACKUP_ROOT:-${STATE_ROOT}/backups}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:-${STATE_ROOT}/artifacts}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${ARTIFACT_ROOT}/${TIMESTAMP}-production-line-${PRODUCTION_LINE_MODE}}"
ENV_FILE="${SHINYIPILOT_ENV_FILE:-${SHINYIPILOT_SOURCE}/.env}"
TMP_PARENT="${TMPDIR:-/tmp}"
BUILD_CONTEXT="$(mktemp -d "${TMP_PARENT%/}/shinyipilot-codex-production-line.XXXXXX")"
CONTAINER_NAME="${CONTAINER_NAME:-shinyipilot-codex-line-${PRODUCTION_LINE_MODE}-${TIMESTAMP}}"

cleanup() {
    rm -rf "${BUILD_CONTEXT}"
}
trap cleanup EXIT

case "${PRODUCTION_LINE_MODE}" in
    shadow|serve|cutover) ;;
    *)
        echo "Unsupported PRODUCTION_LINE_MODE=${PRODUCTION_LINE_MODE}; expected shadow, serve, or cutover" >&2
        exit 1
        ;;
esac

if [[ "${PRODUCTION_LINE_MODE}" == "cutover" ]]; then
    if [[ "${ALLOW_HOST_2999_CUTOVER:-}" != "YES" ]]; then
        echo "Refusing cutover without ALLOW_HOST_2999_CUTOVER=YES" >&2
        exit 1
    fi
    if lsof -nP -iTCP:2999 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "Host 2999 already has a listener. Stop the old service intentionally before cutover." >&2
        exit 1
    fi
fi

if docker ps -a --format '{{.Names}}' | grep -Fx "${CONTAINER_NAME}" >/dev/null; then
    echo "Container already exists: ${CONTAINER_NAME}" >&2
    echo "Inspect it with: docker ps -a --filter name=${CONTAINER_NAME}" >&2
    exit 1
fi

for path in \
    "${CODEX_AUTH_HOME}" \
    "${SHINYIPILOT_SOURCE}" \
    "${RUNTIME_DIR}"; do
    if [[ ! -d "${path}" ]]; then
        echo "Missing directory: ${path}" >&2
        exit 1
    fi
done
for path in \
    "${CODEX_AUTH_HOME}/auth.json" \
    "${ROUTE_SETTINGS_SOURCE}" \
    "${ROUTE_BINDINGS_SOURCE}" \
    "${SHINYIPILOT_SOURCE}/src" \
    "${SHINYIPILOT_SOURCE}/pyproject.toml" \
    "${SHINYIPILOT_SOURCE}/uv.lock"; do
    if [[ ! -r "${path}" ]]; then
        echo "Missing readable input: ${path}" >&2
        exit 1
    fi
done

mkdir -p "${BUILD_CONTEXT}/python" "${BUILD_CONTEXT}/shinyipilot" "${ARTIFACT_DIR}" "${BACKUP_ROOT}"

python3 "${SCRIPT_DIR}/production-runtime-backup.py" \
    --runtime-dir "${RUNTIME_DIR}" \
    --backup-root "${BACKUP_ROOT}" \
    --artifact-dir "${ARTIFACT_DIR}" \
    --timestamp "${TIMESTAMP}"

cp -a "${REPO_ROOT}/python/copilot" "${BUILD_CONTEXT}/python/copilot"
cp -a "${REPO_ROOT}/python/pyproject.toml" "${BUILD_CONTEXT}/python/pyproject.toml"
cp -a "${REPO_ROOT}/python/uv.lock" "${BUILD_CONTEXT}/python/uv.lock"
cp -a "${REPO_ROOT}/python/README.md" "${BUILD_CONTEXT}/python/README.md"

cp -a "${SHINYIPILOT_SOURCE}/src" "${BUILD_CONTEXT}/shinyipilot/src"
cp -a "${SHINYIPILOT_SOURCE}/pyproject.toml" "${BUILD_CONTEXT}/shinyipilot/pyproject.toml"
cp -a "${SHINYIPILOT_SOURCE}/uv.lock" "${BUILD_CONTEXT}/shinyipilot/uv.lock"
if [[ -r "${SHINYIPILOT_SOURCE}/README.md" ]]; then
    cp -a "${SHINYIPILOT_SOURCE}/README.md" "${BUILD_CONTEXT}/shinyipilot/README.md"
fi

if [[ ! -d "${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}" ]]; then
    echo "Missing adapter compatibility source: ${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}" >&2
    echo "Set SHINYIPILOT_ADAPTER_COMPAT_SOURCE to a ShinyiPilot worktree with Codex adapter patches." >&2
    exit 1
fi
ADAPTER_COMPAT_FILE_LIST="src/chatpilot/sdk/session.py src/chatpilot/tools/factory.py"
for rel in ${ADAPTER_COMPAT_FILE_LIST}; do
    if [[ ! -r "${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}/${rel}" ]]; then
        echo "Missing adapter compatibility file: ${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}/${rel}" >&2
        exit 1
    fi
    cp -a "${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}/${rel}" "${BUILD_CONTEXT}/shinyipilot/${rel}"
done
python3 - "${ARTIFACT_DIR}/source-overlay-manifest.json" \
    "${SHINYIPILOT_SOURCE}" \
    "${SHINYIPILOT_ADAPTER_COMPAT_SOURCE}" \
    ${ADAPTER_COMPAT_FILE_LIST} <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

out = Path(sys.argv[1])
source_root = Path(sys.argv[2])
compat_root = Path(sys.argv[3])
files = sys.argv[4:]

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

out.write_text(
    json.dumps(
        {
            "status": "applied",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sourceMode": "real-shinyipilot-source-with-adapter-compat-overlay",
            "shinyipilotSource": str(source_root),
            "adapterCompatSource": str(compat_root),
            "overlays": [
                {
                    "path": rel,
                    "sourceSha256": sha256(source_root / rel),
                    "overlaySha256": sha256(compat_root / rel),
                }
                for rel in files
            ],
        },
        indent=2,
        ensure_ascii=False,
    )
    + "\n",
    encoding="utf-8",
)
PY

cp -a "${SCRIPT_DIR}/Dockerfile" "${BUILD_CONTEXT}/Dockerfile"
cp -a "${SCRIPT_DIR}/container-smoke.sh" "${BUILD_CONTEXT}/container-smoke.sh"
cp -a "${SCRIPT_DIR}/container-behavior-sweep.py" "${BUILD_CONTEXT}/container-behavior-sweep.py"
cp -a "${SCRIPT_DIR}/container-production-line.sh" "${BUILD_CONTEXT}/container-production-line.sh"
cp -a "${SCRIPT_DIR}/container-line-shadow-preflight.py" "${BUILD_CONTEXT}/container-line-shadow-preflight.py"

docker build -t "${IMAGE}" "${BUILD_CONTEXT}"

ENV_ARGS=()
if [[ -n "${SHINYIPILOT_ENV_FILE:-}" || -f "${ENV_FILE}" ]]; then
    if [[ ! -r "${ENV_FILE}" ]]; then
        echo "SHINYIPILOT_ENV_FILE is set but not readable: ${ENV_FILE}" >&2
        exit 1
    fi
    ENV_ARGS+=(--env-file "${ENV_FILE}")
fi

PORT_ARGS=()
RUN_ARGS=(--rm)
if [[ "${PRODUCTION_LINE_MODE}" == "cutover" ]]; then
    PORT_ARGS=(-p "127.0.0.1:2999:29999")
    RUN_ARGS=(-d)
elif [[ "${PRODUCTION_LINE_MODE}" == "serve" ]]; then
    RUN_ARGS=(-d)
fi

set +e +u
docker run "${RUN_ARGS[@]}" \
    --name "${CONTAINER_NAME}" \
    "${PORT_ARGS[@]}" \
    --mount "type=bind,src=${CODEX_AUTH_HOME},dst=/host-codex-home,readonly" \
    --mount "type=bind,src=${RUNTIME_DIR},dst=/runtime" \
    --mount "type=bind,src=${ARTIFACT_DIR},dst=/artifacts" \
    --mount "type=bind,src=${ROUTE_SETTINGS_SOURCE},dst=/host-config/route_settings.yaml,readonly" \
    --mount "type=bind,src=${ROUTE_BINDINGS_SOURCE},dst=/host-config/route_bindings.yaml,readonly" \
    "${ENV_ARGS[@]}" \
    -e "CODEX_ADAPTER_MODEL=${CODEX_ADAPTER_MODEL}" \
    -e "PRODUCTION_LINE_MODE=${PRODUCTION_LINE_MODE}" \
    --entrypoint /usr/local/bin/shinyipilot-codex-production-line \
    "${IMAGE}"
DOCKER_RUN_STATUS=$?
set -euo pipefail
if (( DOCKER_RUN_STATUS != 0 )); then
    exit "${DOCKER_RUN_STATUS}"
fi

echo "Container: ${CONTAINER_NAME}"
echo "Artifacts: ${ARTIFACT_DIR}"
if [[ -f "${ARTIFACT_DIR}/line-shadow-preflight-result.json" ]]; then
    cat "${ARTIFACT_DIR}/line-shadow-preflight-result.json"
elif [[ -f "${ARTIFACT_DIR}/production-line-ready.json" ]]; then
    cat "${ARTIFACT_DIR}/production-line-ready.json"
fi
