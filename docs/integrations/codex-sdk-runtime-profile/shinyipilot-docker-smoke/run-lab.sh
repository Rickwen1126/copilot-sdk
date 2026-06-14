#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

IMAGE="${IMAGE:-copilot-sdk/shinyipilot-codex-smoke:local}"
CONTAINER_NAME="${CONTAINER_NAME:-shinyipilot-codex-lab}"
CODEX_AUTH_HOME="${CODEX_AUTH_HOME:-${HOME}/.codex}"
CODEX_ADAPTER_MODEL="${CODEX_ADAPTER_MODEL:-gpt-5.4-mini}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/shinyipilot-codex-docker-lab-$(date +%Y%m%d-%H%M%S)}"
TMP_PARENT="${TMPDIR:-/tmp}"
BUILD_CONTEXT="$(mktemp -d "${TMP_PARENT%/}/shinyipilot-codex-lab.XXXXXX")"

cleanup() {
    rm -rf "${BUILD_CONTEXT}"
}
trap cleanup EXIT

if docker ps -a --format '{{.Names}}' | grep -Fx "${CONTAINER_NAME}" >/dev/null; then
    echo "Container already exists: ${CONTAINER_NAME}" >&2
    echo "Inspect it with: docker ps -a --filter name=${CONTAINER_NAME}" >&2
    exit 1
fi

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

mkdir -p "${ARTIFACT_DIR}"

docker build -t "${IMAGE}" "${BUILD_CONTEXT}"

docker run -d \
    --name "${CONTAINER_NAME}" \
    --mount "type=bind,src=${CODEX_AUTH_HOME},dst=/host-codex-home,readonly" \
    --mount "type=bind,src=${ARTIFACT_DIR},dst=/artifacts" \
    -e "CODEX_ADAPTER_MODEL=${CODEX_ADAPTER_MODEL}" \
    -e "SHINYIPILOT_DOCKER_MODE=lab" \
    "${IMAGE}" >/dev/null

deadline=$((SECONDS + 120))
until [[ -f "${ARTIFACT_DIR}/lab-ready.json" ]]; do
    if ! docker ps --format '{{.Names}}' | grep -Fx "${CONTAINER_NAME}" >/dev/null; then
        echo "Container exited before becoming ready: ${CONTAINER_NAME}" >&2
        docker logs "${CONTAINER_NAME}" >&2 || true
        exit 1
    fi
    if (( SECONDS >= deadline )); then
        echo "Timed out waiting for ${ARTIFACT_DIR}/lab-ready.json" >&2
        docker logs "${CONTAINER_NAME}" >&2 || true
        exit 1
    fi
    sleep 1
done

echo "Container: ${CONTAINER_NAME}"
echo "Artifacts: ${ARTIFACT_DIR}"
cat "${ARTIFACT_DIR}/lab-ready.json"
echo
echo "CLI example:"
echo "docker exec ${CONTAINER_NAME} uv run --project /workspace/shinyipilot chatpilot-cli --url http://127.0.0.1:29999 chat '你好，請回覆 lab-ready' --user lab-user"
