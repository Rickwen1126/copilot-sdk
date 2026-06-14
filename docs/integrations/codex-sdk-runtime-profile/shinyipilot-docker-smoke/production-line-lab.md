# ShinyiPilot Production LINE Docker Lab

Created: 2026-06-15 02:26
Last Updated: 2026-06-15 03:03
Status: Shadow preflight passed; host 2999 cutover pending

This document records the short-term source of truth for running ShinyiPilot
through the Python Codex adapter as a production-like LINE service.

## Ownership

The experiment documentation lives in this `copilot-sdk` branch.

`shinyipilot-spike/` is a nested worktree and an experiment target. The parent
repo cannot track that worktree's internal files as normal source, so adapter
deployment decisions, Docker runner policy, config mount rules, and state
handling notes must stay in this parent repo until the lane becomes accepted
ShinyiPilot product deployment guidance.

The split is:

- `copilot-sdk` owns the Codex adapter, Docker harness, Codex home isolation,
  semantic logs, evidence artifacts, and this production-line experiment
  runbook.
- ShinyiPilot owns LINE route semantics, webhook behavior, app tool contracts,
  SQLite schema, and the final accepted production deployment docs.

After this lane is proven, stable product-owned instructions can be copied into
`~/code/shinyipilot/docs/`. Until then, do not scatter deployment decisions into
the nested worktree.

## Target Shape

The production LINE lab is different from smoke, sweep, and the existing lab:

- Smoke/sweep/lab currently use `shinyipilot-spike` source and example config.
- Production LINE lab should use the real `~/code/shinyipilot` source and real
  route config.
- The container may publish host `127.0.0.1:2999` to container `29999` only
  after shadow preflight passes.
- Cloudflare tunnel can continue to target the host `2999` endpoint once the
  Docker container owns that host port.
- The old host-local `2999` service may be stopped for cutover, but its data
  must not be modified or deleted as part of the stop.

## Mounts And Inputs

The image should contain code and runner scripts, not live mutable state.

Required production-line inputs:

- ShinyiPilot source: local `~/code/shinyipilot`, selected at runner time.
- ShinyiPilot route settings: real `config/route_settings.yaml`, mounted
  read-only or copied into container runtime from a read-only source.
- ShinyiPilot route bindings: real `config/route_bindings.yaml`, mounted
  read-only or copied into container runtime from a read-only source.
- ShinyiPilot secrets: provided through an explicit env file or secret mount;
  never copied into the Docker build context and never written to artifacts.
- Codex auth source: host `~/.codex` mounted read-only, then copied into a
  container-local clean Codex source home as in the smoke lane.
- Artifacts: host bind mount for logs, summaries, preflight reports, and backup
  manifests.

Do not bake these into the image:

- `.env`
- live route config files
- SQLite DB files
- host `~/.codex/config.toml`
- ShinyiPilot `data/`, `log/`, `.progress/`, `.venv/`, or local caches

## Persistent State

For production-like LINE experiments, `/runtime` must be a host-backed
persistent state directory. It must not be container-only state.

Recommended host layout:

```text
~/.local/state/shinyipilot-codex-line/
  runtime/
    chatpilot.db
    tasks.db
    files.db
    codex-runtime-sessions.json
    codex-workspaces/
  backups/
    YYYYMMDD-HHMMSS/
      chatpilot.db
      tasks.db
      files.db
      manifest.json
  artifacts/
    YYYYMMDD-HHMMSS/
      adapter-summary.json
      adapter.log
      shinyipilot.log
      preflight-result.json
```

Container view:

```text
/runtime/chatpilot.db
/runtime/tasks.db
/runtime/files.db
```

The database lifecycle belongs to the host. Containers and images can be
discarded; the host-backed `/runtime` directory cannot be treated as
discardable.

## Backup Policy

Before any container starts with a writable production-like `/runtime`, the
runner must create a SQLite-aware backup.

Minimum backup sequence:

1. Locate each configured SQLite DB path.
2. Run a WAL checkpoint for each existing DB.
3. Use SQLite `.backup` or an equivalent consistent-copy method.
4. Copy matching `-wal` and `-shm` files only when needed for recovery.
5. Write `manifest.json` with source path, backup path, byte size, sha256, row
   counts for key tables, timestamp, and runner version.
6. Abort startup if backup fails.

This applies before shadow mode and before host port cutover.

## Shadow Preflight

Shadow mode must not publish host `2999`.

It should prove:

- Real ShinyiPilot config loads.
- LINE adapter channels are present when required env vars are provided.
- Route binding counts and platform names match the expected production config.
- `CHATPILOT_RUNTIME_BACKEND=codex-adapter`.
- The adapter starts with `CODEX_ADAPTER_MODEL=gpt-5.4-mini` unless explicitly
  overridden.
- `/health` passes inside the container.
- A synthetic LINE webhook request reaches the webhook handler and produces the
  expected route id, binding policy, source-message capture, identity registry
  update, and log entries.
- Adapter `semanticLog` and ShinyiPilot logs can be read from artifacts without
  exposing secret values.

Shadow mode can use synthetic webhook payloads and safe canary route ids. It
should not send uncontrolled replies to real LINE users.

Current proof:

- Runner: `run-production-line.sh`
- Artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-030207-production-line-shadow`
- Startup backup:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-030207-production-line-startup`
- Result file: `line-shadow-preflight-result.json`
- Source shape: real `/Users/rickwen/code/shinyipilot` source/config/env, with
  only `src/chatpilot/sdk/session.py` and `src/chatpilot/tools/factory.py`
  overlaid from `shinyipilot-spike` inside the temporary Docker build context.
- Runtime shape:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime:/runtime`.
- Pass evidence: `/health` returned `status=ok`; `runtimeBackend` was
  `codex-adapter`; model was `gpt-5.4-mini`; LINE channel env names were present;
  the selected real route used `observer_capture_only` and
  `suppress_origin_delivery`; SQLite read-back found one matching
  `source_messages` row with `capture_policy=observer` and one route identity
  row; ShinyiPilot log contained the line ingress handled marker.
- Host boundary: no host `2999` listener was published.

## Host Port Cutover

Cutover may publish:

```text
127.0.0.1:2999 -> container:29999
```

Cutover prerequisites:

- Old host-local `2999` service has been intentionally stopped.
- Stopping the old service did not edit, delete, or migrate any data.
- Persistent `/runtime` backup passed immediately before startup.
- Shadow preflight passed against the same source/config/env/runtime set.
- The container health endpoint is passing.
- Cloudflare tunnel still targets host `2999`.

Backout is:

1. Stop the Docker container.
2. Keep the persistent `/runtime` directory intact.
3. Restore from the latest backup only if the experiment corrupted state.
4. Restart the old host-local service if needed.

Do not run automatic destructive cleanup against the persistent runtime
directory.

## Acceptance Gates

The first accepted production-line lab proof must include:

- Docker start command and image tag.
- Host source path and config path summary.
- Backup manifest.
- Health proof.
- Synthetic LINE webhook proof.
- One real LINE canary proof, only after shadow mode passes.
- SQLite read-back for any written state.
- ShinyiPilot `[tool_call]` / `[tool_result]` log evidence when SDK tools run.
- Adapter `semanticLog` evidence for session lifecycle, turn lifecycle, tool
  routing, SDK dispatch, SDK result, and assistant completion.
- Confirmation that no host `4800`, `4801`, or `4811` service was touched.

## Open Work

- Decide whether the two adapter compatibility overlays should be copied into
  `~/code/shinyipilot` as accepted product code before cutover, or kept as a
  parent-runner overlay for this experimental branch.
- Decide the long-running Codex auth persistence strategy.
- Prepare the host `2999` cutover and backout checklist.
- Decide whether `~/code/shinyipilot` product docs should receive the accepted
  subset after the first successful LINE canary.
