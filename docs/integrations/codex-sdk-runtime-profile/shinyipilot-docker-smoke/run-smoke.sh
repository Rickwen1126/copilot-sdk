#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

IMAGE="${IMAGE:-copilot-sdk/shinyipilot-codex-smoke:local}"
CODEX_AUTH_HOME="${CODEX_AUTH_HOME:-${HOME}/.codex}"
CODEX_ADAPTER_MODEL="${CODEX_ADAPTER_MODEL:-gpt-5.4-mini}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/shinyipilot-codex-docker-smoke-$(date +%Y%m%d-%H%M%S)}"
TMP_PARENT="${TMPDIR:-/tmp}"
BUILD_CONTEXT="$(mktemp -d "${TMP_PARENT%/}/shinyipilot-codex-smoke.XXXXXX")"

cleanup() {
    rm -rf "${BUILD_CONTEXT}"
}
trap cleanup EXIT

if [[ ! -d "${CODEX_AUTH_HOME}" ]]; then
    echo "Missing CODEX_AUTH_HOME directory: ${CODEX_AUTH_HOME}" >&2
    exit 1
fi
if [[ ! -r "${CODEX_AUTH_HOME}/auth.json" ]]; then
    echo "Missing readable ${CODEX_AUTH_HOME}/auth.json. Run codex login first." >&2
    exit 1
fi

mkdir -p "${BUILD_CONTEXT}/python" "${BUILD_CONTEXT}/shinyipilot/config"

cp -a "${REPO_ROOT}/python/copilot" "${BUILD_CONTEXT}/python/copilot"
cp -a "${REPO_ROOT}/python/pyproject.toml" "${BUILD_CONTEXT}/python/pyproject.toml"
cp -a "${REPO_ROOT}/python/uv.lock" "${BUILD_CONTEXT}/python/uv.lock"
cp -a "${REPO_ROOT}/python/README.md" "${BUILD_CONTEXT}/python/README.md"

cp -a "${REPO_ROOT}/shinyipilot-spike/src" "${BUILD_CONTEXT}/shinyipilot/src"
cp -a "${REPO_ROOT}/shinyipilot-spike/pyproject.toml" "${BUILD_CONTEXT}/shinyipilot/pyproject.toml"
cp -a "${REPO_ROOT}/shinyipilot-spike/uv.lock" "${BUILD_CONTEXT}/shinyipilot/uv.lock"
cp -a "${REPO_ROOT}/shinyipilot-spike/README.md" "${BUILD_CONTEXT}/shinyipilot/README.md"
cp -a "${REPO_ROOT}/shinyipilot-spike/config/route_settings.example.yaml" \
    "${BUILD_CONTEXT}/shinyipilot/config/route_settings.example.yaml"
cp -a "${REPO_ROOT}/shinyipilot-spike/config/route_bindings.example.yaml" \
    "${BUILD_CONTEXT}/shinyipilot/config/route_bindings.example.yaml"

cp -a "${SCRIPT_DIR}/Dockerfile" "${BUILD_CONTEXT}/Dockerfile"
cp -a "${SCRIPT_DIR}/container-smoke.sh" "${BUILD_CONTEXT}/container-smoke.sh"
cp -a "${SCRIPT_DIR}/container-behavior-sweep.py" \
    "${BUILD_CONTEXT}/container-behavior-sweep.py"
cp -a "${SCRIPT_DIR}/container-production-line.sh" \
    "${BUILD_CONTEXT}/container-production-line.sh"
cp -a "${SCRIPT_DIR}/container-line-shadow-preflight.py" \
    "${BUILD_CONTEXT}/container-line-shadow-preflight.py"

mkdir -p "${ARTIFACT_DIR}"

docker build -t "${IMAGE}" "${BUILD_CONTEXT}"

docker run --rm \
    --name "shinyipilot-codex-smoke-$(date +%s)" \
    --mount "type=bind,src=${CODEX_AUTH_HOME},dst=/host-codex-home,readonly" \
    --mount "type=bind,src=${ARTIFACT_DIR},dst=/artifacts" \
    -e "CODEX_ADAPTER_MODEL=${CODEX_ADAPTER_MODEL}" \
    -e "SMOKE_MARKER=${SMOKE_MARKER:-codex docker smoke marker $(date +%Y%m%d-%H%M%S)}" \
    "${IMAGE}"

echo "Artifacts written to ${ARTIFACT_DIR}"
