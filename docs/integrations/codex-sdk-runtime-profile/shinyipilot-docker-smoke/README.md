# ShinyiPilot Codex Docker Smoke

Created: 2026-06-15 00:42
Last Updated: 2026-06-15 01:26
Status: Active production-smoke lane

This folder contains the containerized state-changing smoke for the
ShinyiPilot Codex adapter lane.

The smoke keeps the app and adapter inside one Docker container. It does not
publish `4873` or `29999` to the host. The host only supplies a read-only Codex
auth home and receives artifacts.

## Boundary

- Host `~/.codex` is mounted read-only at `/host-codex-home`.
- The smoke copies only auth-required files from `/host-codex-home` into a
  container-local clean source home under `/runtime/codex-clean-home`.
- The smoke generates a minimal `config.toml` in that clean source home. Host
  `config.toml` is intentionally not copied, so host MCP/plugin/skill settings
  do not enter this lane.
- The adapter receives `CODEX_ADAPTER_CODEX_HOME=/runtime/codex-clean-home` and
  `CODEX_ADAPTER_ISOLATE_CODEX_HOME=true`.
- `gateway.py` then copies the clean source home files into a second
  container-local isolated temp home before starting `codex app-server`.
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
`/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107`.

That run used `gpt-5.4-mini`, reported `codexHomeMode=clean-minimal-config`,
returned CLI response `saved`, copied `chatpilot.db` to the artifact directory,
and read one matching `memory_memos` row back from the copied DB. The artifact
`codex-config.toml` contains only the generated minimal smoke config, not host
MCP/plugin/skill settings.

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

## Lab Mode

Use lab mode when you want the adapter and ShinyiPilot app to stay running while
you send repeated CLI prompts through the SDK + Codex adapter path.

```sh
docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-lab.sh
```

The lab container does not publish host ports. Run CLI probes inside the
container:

```sh
docker exec shinyipilot-codex-lab \
  uv run --project /workspace/shinyipilot chatpilot-cli \
  --url http://127.0.0.1:29999 \
  chat "你好，請回覆 lab-ready" --user lab-user
```

Stop the lab container with:

```sh
docker stop shinyipilot-codex-lab
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
- `codex-config.toml`

Lab-mode artifacts additionally include:

- `lab-ready.json`

## Latest Lab Probe

The 2026-06-15 01:24 lab used container `shinyipilot-codex-lab`, with
artifacts at `/tmp/shinyipilot-codex-docker-lab-live-20260615-0124`.

The lab probe exercised natural-language CLI turns through ShinyiPilot, the
Python SDK client, the Python Codex adapter, and Codex app-server using
`gpt-5.4-mini`. It verified data-level DB side effects and SDK tool
observability for:

- `save_memo`, `list_memos`, and `delete_memo`
- `add_reminder`, `schedule_task_cron`, `list_schedules`, and `cancel_schedule`
- `save_custom_prompt` and `list_custom_prompts`

The live adapter summary is periodically flushed while the adapter runs, so
`adapter-summary.json` can be inspected before shutdown. In the 01:24 lab,
`semanticLog` recorded session lifecycle, turn lifecycle, assistant completion,
tool routing, SDK tool dispatch, and SDK tool result entries. The ShinyiPilot
log remains the source for business payload details such as tool arguments,
tool result text, and DB save/delete messages.

Known app-level gap from the probe: `list_custom_prompts` displays only the
first 8 characters of the prompt ID, but `delete_custom_prompt` currently
requires the full ID. A natural user request to list and delete the preference
therefore produced an adapter-visible `tool.sdk_result success=false` and a
ShinyiPilot tool result of "找不到 ID 為 f4663078 的偏好設定". Track this as a
ShinyiPilot tool usability fix, not as a Codex adapter failure.
