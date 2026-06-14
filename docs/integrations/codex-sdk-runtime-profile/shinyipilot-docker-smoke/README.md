# ShinyiPilot Codex Docker Smoke

Created: 2026-06-15 00:42
Last Updated: 2026-06-15 00:52
Status: Active production-smoke lane

This folder contains the containerized state-changing smoke for the
ShinyiPilot Codex adapter lane.

The smoke keeps the app and adapter inside one Docker container. It does not
publish `4873` or `29999` to the host. The host only supplies a read-only Codex
auth home and receives artifacts.

## Boundary

- Host `~/.codex` is mounted read-only at `/host-codex-home`.
- The adapter receives `CODEX_ADAPTER_CODEX_HOME=/host-codex-home` and
  `CODEX_ADAPTER_ISOLATE_CODEX_HOME=true`.
- `gateway.py` copies the required Codex home files into a container-local
  isolated temp home before starting `codex app-server`.
- ShinyiPilot runtime state is container-local under `/runtime`.
- Logs, adapter summary, CLI response, and smoke result are written to
  `/artifacts`, which is the only host-writable mount.

This lets state-changing Codex turns exercise workspace-write behavior without
writing app DBs, runtime session stores, or Codex app-server state into the host
environment.

## Default Model

The default model is `gpt-5.4-mini`.

This is a Codex runtime decision. It is not constrained by the ShinyiPilot
Copilot CLI / GitHub Copilot SDK notes about `list_models()`. The smoke proves
the model by running an actual Codex turn through the adapter and checking the
resulting DB/log/adapter side effects.

## Latest Verified Proof

The latest passing artifact is
`/tmp/shinyipilot-codex-docker-smoke-20260615-0053`.

That run used `gpt-5.4-mini`, returned CLI response `saved`, copied
`chatpilot.db` to the artifact directory, and read one matching
`memory_memos` row back from the copied DB.

## Run

```sh
docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-smoke.sh
```

Optional overrides:

```sh
CODEX_AUTH_HOME="$HOME/.codex" \
CODEX_ADAPTER_MODEL=gpt-5.4-mini \
ARTIFACT_DIR=/tmp/shinyipilot-codex-docker-smoke \
docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-smoke.sh
```

The host runner builds a temporary Docker context under `/tmp`. It copies only:

- parent SDK `python/copilot`, `python/pyproject.toml`, `python/uv.lock`
- ShinyiPilot `src`, `pyproject.toml`, `uv.lock`, and example route configs
- this folder's Dockerfile and container smoke script

It does not copy ShinyiPilot `.env`, `data/`, `log/`, `.progress/`, `.venv/`,
or live route config files.

## Pass Criteria

The smoke fails unless all of these are true:

- ShinyiPilot `/health` is reachable inside the container.
- `chatpilot-cli` returns a non-empty, non-error response.
- SQLite contains exactly one matching `memory_memos` row for the smoke marker.
- The copied `chatpilot.db` artifact also reads back exactly one matching row.
- ShinyiPilot log contains `[tool_call] save_memo`.
- ShinyiPilot log contains `[tool_result] save_memo ... status=success`.
- Adapter summary contains semantic log entries for session creation, turn
  start, tool routing, SDK tool dispatch, and SDK tool result.

Artifacts:

- `adapter.log`
- `adapter-summary.json`
- `shinyipilot.log`
- `cli-response.txt`
- `smoke-result.json`
- `chatpilot.db`
