# Completed Todo Archive

Created: 2026-05-16
Last Updated: 2026-06-15 10:50
Status: Archived

This archive was bootstrapped from session continuity and live adapter work. Missing historical links mean the older notes did not record them, not that the retention rule is optional.

## Completed: ShinyiPilot Host 2999 Codex Cutover @2026-06-15-1050

Section source:

- Spec: [docs/spec.md](./spec.md)
- Active follow-up: [docs/todo.md](./todo.md#p1-shinyipilot-deployment-ownership-transition-2026-06-15-0932)
- Cutover checklist: [host-2999-cutover-checklist.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/host-2999-cutover-checklist.md)
- Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), [container-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-production-line.sh), ShinyiPilot `config/route_settings.yaml`, ShinyiPilot `config/route_settings.example.yaml`
- ShinyiPilot commits: `0946d0b feat: support codex adapter runtime backend`, `0dc74d4 chore: default route models to codex compatible model`
- `copilot-sdk` commit: `afe3599 fix: bind shinyipilot cutover app externally`
- Cutover artifact directory: `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0958-production-line-cutover`
- Startup backup: `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0958-production-line-startup`
- Runtime DB: `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime/chatpilot.db`
- Source: user explicitly approved replacing the old host `2999` service with the Docker-backed Codex production-line container and tested LINE canaries.

- [x] Ran a fresh no-overlay shadow proof immediately before cutover.
      Completion evidence: `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0950-production-line-shadow` passed with `sourceMode=real-shinyipilot-source-no-overlay`, startup backup `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0950-production-line-startup`, synthetic LINE message `codex-line-shadow-20260615-023848`, and SQLite/log read-back.
- [x] Started the Docker cutover container on host `2999`.
      Completion evidence: `production-line-ready.json` reports `mode=cutover`, `model=gpt-5.4-mini`, `appBindHost=0.0.0.0`, `containerAppUrl=http://127.0.0.1:29999`, and `adapterUrl=127.0.0.1:4873`; `curl http://127.0.0.1:2999/health` returned `{"status":"ok","version":"0.2.0",...}`; `docker ps` showed `shinyipilot-codex-line-cutover-20260615-0958` publishing `127.0.0.1:2999->29999/tcp`; `lsof` showed Docker owning `127.0.0.1:2999`.
- [x] Fixed the cutover bind-host bug in the parent runner.
      Completion evidence: the first cutover attempt bound uvicorn to container-local `127.0.0.1`, making host `2999` return an empty reply. The failed container was stopped without deleting runtime state. `container-production-line.sh` now binds `0.0.0.0` for `serve` and `cutover`, keeps internal health checks on `127.0.0.1`, and writes `appBindHost` into `production-line-ready.json`.
- [x] Corrected ShinyiPilot's Codex-compatible model policy.
      Completion evidence: the first real LINE canary reached the Docker-backed service and wrote `source_messages`, but the chatbot session used `model=gemini-3-flash`; adapter summary recorded Codex app-server rejecting it with `The 'gemini-3-flash' model is not supported when using Codex with a ChatGPT account.` The ignored production `config/route_settings.yaml` was updated locally to use `gpt-5.4-mini` for all eight chatbot profiles, the tracked `config/route_settings.example.yaml` default was committed in ShinyiPilot at `0dc74d4`, and `POST /cli/reload` returned `{"status":"reloaded"}`.
- [x] Verified real LINE canaries after reload.
      Completion evidence: SQLite read-back showed real LINE rows at `2026-06-15T02:48:42.675176+00:00`, `2026-06-15T02:49:40.666339+00:00`, and `2026-06-15T02:50:07.063516+00:00` for route `line:shinyipaint:C0069917b022d280805149bf9a8709453`. ShinyiPilot logs showed `model=gpt-5.4-mini`, assistant responses, server `[response]` lines, and `IDLE` transitions. The successful replies included `小奇你好，有什麼要我幫忙的？`, `有聽到啦，我現在就是用 Codex 幫忙回你。...`, and `有啦，今天蠻順的...`.
- [x] Kept persistent runtime state intact.
      Completion evidence: the cutover used host-backed `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, startup backup manifests were preserved, no DB restore was used, and no destructive cleanup was performed. The cutover container remains running for production-like LINE testing.

## Completed: ShinyiPilot No-Overlay Production-Line Gate @2026-06-15-0942

Section source:

- Spec: [docs/spec.md](./spec.md)
- Ownership transition plan: [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md)
- Production LINE lab plan: [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), ShinyiPilot `/Users/rickwen/code/shinyipilot/src/chatpilot/sdk/session.py`, ShinyiPilot `/Users/rickwen/code/shinyipilot/src/chatpilot/tools/factory.py`
- ShinyiPilot commit: `0946d0b feat: support codex adapter runtime backend`
- Artifact directory: `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0938-production-line-shadow`
- Startup backup: `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0938-production-line-startup`
- Source: user clarified that transition builds must not silently patch app code; `copilot-sdk` owns Docker/Codex/E2E during transition while ShinyiPilot owns the minimal app compatibility and product config.

- [x] Ported the accepted adapter compatibility subset into `~/code/shinyipilot`.
      Completion evidence: ShinyiPilot commit `0946d0b` adds `CHATPILOT_RUNTIME_BACKEND=codex-adapter` / `CHATPILOT_COPILOT_CLI_URL` support in `src/chatpilot/sdk/session.py`, normalizes SDK `ToolInvocation` objects in `src/chatpilot/tools/factory.py`, and adds unit coverage. Targeted ShinyiPilot tests passed: `uv run pytest tests/unit/test_sdk_session.py tests/unit/test_tool_factory.py` with 14 tests passing.
- [x] Made production-line builds no-overlay by default.
      Completion evidence: `run-production-line.sh` defaults `ALLOW_SHINYIPILOT_COMPAT_OVERLAY=NO`, writes `source-overlay-manifest.json` on every run, validates real-source compatibility markers, leaves overlay available only with `ALLOW_SHINYIPILOT_COMPAT_OVERLAY=YES`, and refuses overlay-enabled `cutover` mode.
- [x] Produced a no-overlay production-line shadow proof.
      Completion evidence: `source-overlay-manifest.json` reports `status=not_applied` and `sourceMode=real-shinyipilot-source-no-overlay`; `line-shadow-preflight-result.json` reports `status=pass`, `/health status=ok`, `runtimeBackend=codex-adapter`, `model=gpt-5.4-mini`, signed synthetic LINE webhook HTTP 200, SQLite `source_messages` read-back with `capture_policy=observer` and `retention_class=long`, route identity read-back, and ShinyiPilot line-ingress log proof.
- [x] Kept the host boundary clean.
      Completion evidence: shadow mode published no host `2999`; post-run `lsof -nP -iTCP:2999 -sTCP:LISTEN` returned no listener, and the shadow container was removed by `--rm`.
- [x] Prepared the host `2999` cutover and backout checklist.
      Completion evidence: [host-2999-cutover-checklist.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/host-2999-cutover-checklist.md) records pre-cutover checks, fresh no-overlay shadow proof requirements, old-service stop boundary, cutover start command, health/Cloudflare/canary evidence, and non-destructive backout rules. Actual cutover remains an active todo requiring explicit user approval.

## Completed: ShinyiPilot Production LINE Shadow Runner @2026-06-15-0303

Section source:

- Spec: [docs/spec.md](./spec.md)
- Production LINE lab plan: [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), [production-runtime-backup.py](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-runtime-backup.py), [container-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-production-line.sh), [container-line-shadow-preflight.py](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-line-shadow-preflight.py)
- Artifact directory: `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-030207-production-line-shadow`
- Startup backup: `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-030207-production-line-startup`
- Source: user approved keeping production-line deployment policy in parent `copilot-sdk`, copying latest ShinyiPilot DB/runtime assets into host-backed state, and using NAS backup as the external safety copy before production-like experiments.

- [x] Added the dedicated production-line Docker runner.
      Completion evidence: `run-production-line.sh` builds from real `/Users/rickwen/code/shinyipilot` source, mounts real route settings/bindings read-only, mounts host Codex auth read-only, writes artifacts under host state, and defaults to shadow mode without publishing host ports.
- [x] Added startup backup and manifest verification.
      Completion evidence: `production-runtime-backup.py` ran before startup and wrote `startup-backup-manifest.json` with SQLite integrity `ok`, DB byte sizes, DB hashes, row-count summaries, and allowlisted runtime asset hashes. The latest startup backup captured `chatpilot.db` with `source_messages=953` before the synthetic webhook added the next row.
- [x] Added synthetic LINE webhook shadow preflight.
      Completion evidence: `line-shadow-preflight-result.json` reports `status=pass`, `/health status=ok`, `runtimeBackend=codex-adapter`, `model=gpt-5.4-mini`, LINE secret/token env presence booleans, selected real route policy `observer_capture_only` + `suppress_origin_delivery`, HTTP 200 from `/webhook/line`, one SQLite `source_messages` row with `capture_policy=observer`, one route identity row, and ShinyiPilot line-ingress log proof.
- [x] Kept the host boundary clean.
      Completion evidence: the passing shadow container ran with `--rm`, published no host ports, and post-run `lsof -nP -iTCP:2999 -sTCP:LISTEN` returned no listener. The original `/Users/rickwen/code/shinyipilot` checkout was not modified; the runner records a build-context-only overlay manifest for `src/chatpilot/sdk/session.py` and `src/chatpilot/tools/factory.py`.

## Completed: ShinyiPilot Codex Docker Behavior Sweep @2026-06-15-0151

Section source:

- Spec: [docs/spec.md](./spec.md)
- Docker lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [container-behavior-sweep.py](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-behavior-sweep.py), [container-smoke.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-smoke.sh), [run-sweep.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-sweep.sh)
- Artifact directory: `/tmp/shinyipilot-codex-docker-sweep-dev-20260615-014939`
- Source: user asked to make the Codex + SDK lane Docker-friendly enough for broader testing without fearing host-environment damage.

- [x] Added a repeatable Docker behavior sweep mode.
      Completion evidence: `run-sweep.sh` builds the same narrow Docker context as smoke/lab mode, starts one container with no host port publishing, sets `SHINYIPILOT_DOCKER_MODE=sweep`, and writes artifacts under `/artifacts`.
- [x] Covered representative ShinyiPilot SDK tool behavior through real Codex turns.
      Completion evidence: `/tmp/shinyipilot-codex-docker-sweep-dev-20260615-014939/behavior-sweep-result.json` reports `status=pass`, `model=gpt-5.4-mini`, 11 steps, 56 passing checks, 68 adapter semantic entries, and 4 adapter sessions. Steps covered memo save/list/delete, reminder add/list/cancel, schedule add/list/cancel, web initial chat, and web getCurrentContext/operate.
- [x] Verified data-level side effects and cleanup from the copied DB artifact.
      Completion evidence: `/tmp/shinyipilot-codex-docker-sweep-dev-20260615-014939/chatpilot.db` reads back zero remaining sweep `memory_memos`, `memory_reminders`, and `memory_schedules` rows after the sweep cleaned up the created state.
- [x] Verified app and adapter observability for the exercised tools.
      Completion evidence: `shinyipilot.log` contains `[tool_call]` / `[tool_result]` pairs for `save_memo`, `list_memos`, `delete_memo`, `add_reminder`, `list_schedules`, `cancel_schedule`, `schedule_task_cron`, `getCurrentContext`, and `operate`; `adapter-summary.json` contains successful `tool.sdk_result` semantic entries for the same exercised tool set.

## Completed: Python Codex Adapter Redacted Tool Preview Observability @2026-06-15-0133

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Code/Surface: [python/copilot/experimental/codex_adapter/server.py](../python/copilot/experimental/codex_adapter/server.py), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py)
- Artifact directory: `/tmp/shinyipilot-codex-docker-smoke-redacted-preview-20260615-0129`
- Source: user asked to add redacted args/result preview to adapter `semanticLog` after the Docker lab proved the current observability split was useful.

- [x] Added bounded argument previews to adapter semantic tool routing events.
      Completion evidence: `tool.routing:requested` records `argumentsPreview`, `argumentsPreviewRedacted`, and `argumentsPreviewTruncated`.
- [x] Added bounded result previews to adapter semantic tool result events.
      Completion evidence: `tool.sdk_result:received` records `resultPreview`, `resultPreviewRedacted`, and `resultPreviewTruncated`.
- [x] Redacted common secret-bearing payloads.
      Completion evidence: tests cover token-like argument keys and long payload truncation; the helper redacts common password/token/secret/cookie/credential/API-key fields and opaque token-like strings.
- [x] Proved the change in a real ShinyiPilot Docker smoke.
      Completion evidence: `/tmp/shinyipilot-codex-docker-smoke-redacted-preview-20260615-0129/smoke-result.json` reports `status=pass`, `model=gpt-5.4-mini`, `sqlite.matchingMemoryMemoRows=1`, and `sqlite.artifactReadbackMemoryMemoRows=1`; `adapter-summary.json` shows `argumentsPreview.text` and `resultPreview.textResultForLlm` for the real `save_memo` tool call.

## Completed: ShinyiPilot Codex Docker Lab Mode And Live Observability Probe @2026-06-15-0126

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker lab lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Active app-level follow-up: [docs/todo.md](./todo.md#p2-shinyipilot-custom-prompt-prefix-delete-gap-2026-06-15-0126)
- Artifact directory: `/tmp/shinyipilot-codex-docker-lab-live-20260615-0124`
- Source: user asked to keep Docker running and probe ShinyiPilot's DB-backed tools from a user perspective through CLI + SDK + Codex, while inspecting adapter observability.

- [x] Added a persistent Docker lab mode for repeated CLI probes.
      Completion evidence: `run-lab.sh` starts `shinyipilot-codex-lab` detached with no host port publishing; `container-smoke.sh` writes `lab-ready.json` and keeps adapter/app processes running in lab mode.
- [x] Made adapter summary observable while the process is still running.
      Completion evidence: `python/copilot/experimental/codex_adapter/cli.py` periodically flushes `adapter-summary.json` when `--summary-path` is set, then writes a final summary at shutdown.
- [x] Proved natural-language DB-backed SDK tool calls in the lab.
      Completion evidence: CLI turns through `gpt-5.4-mini` successfully called `save_memo`, `list_memos`, `delete_memo`, `add_reminder`, `schedule_task_cron`, `list_schedules`, `cancel_schedule`, `save_custom_prompt`, and `list_custom_prompts`; DB read-back confirmed memo/reminder/schedule/custom-prompt mutations and cleanup state.
- [x] Proved live control-plane observability is useful.
      Completion evidence: `adapter-summary.json` recorded 80 semantic entries across session lifecycle, turn lifecycle, tool routing, SDK tool dispatch, SDK tool result, and assistant completion; ShinyiPilot logs supplied tool arguments, result text, and DB mutation messages.
- [x] Identified one app-level product tool gap without misclassifying it as adapter failure.
      Completion evidence: a natural list-and-delete preference turn called `list_custom_prompts` then `delete_custom_prompt` with the displayed 8-character ID and received `success=false`; the active follow-up now tracks the ShinyiPilot prefix/full-ID mismatch.

## Completed: ShinyiPilot Codex Docker Clean Config Smoke Proof @2026-06-15-0108

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Pending auth strategy: [docs/todo.md](./todo.md#p2-pending-codex-container-auth-persistence-strategy-2026-06-15-0106)
- Artifact directory: `/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107`
- Source: user asked to keep auth strategy pending but move Docker Codex config to a clean minimal state before testing Codex + Copilot SDK.

- [x] Removed host `config.toml` from the Docker smoke lane.
      Completion evidence: `container-smoke.sh` now creates `/runtime/codex-clean-home`, copies only auth-required files, and generates a minimal `config.toml`; the adapter receives that clean home with `CODEX_ADAPTER_ISOLATE_CODEX_HOME=true`.
- [x] Proved Codex + Copilot SDK still dispatches ShinyiPilot `save_memo` with the clean config.
      Completion evidence: `/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107/smoke-result.json` reports `status=pass`, `codexHomeMode=clean-minimal-config`, `model=gpt-5.4-mini`, CLI response `saved`, `matchingMemoryMemoRows=1`, and `artifactReadbackMemoryMemoRows=1`.
- [x] Preserved inspectable proof that host MCP/plugin/skill config was not copied.
      Completion evidence: `/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107/codex-config.toml` contains only the generated minimal smoke config comments.
- [x] Preserved data/log/semantic proof.
      Completion evidence: copied artifact DB returns `cli:codex-docker-smoke|codex docker smoke marker 20260615-010731`; ShinyiPilot log contains `[tool_call] tool=save_memo`, `[db] SAVE memo`, and `[tool_result] tool=save_memo ... status=success`; adapter summary contains session, turn, tool routing, SDK tool dispatch, SDK tool result, and assistant completion semantic events.

## Completed: ShinyiPilot Codex Adapter Docker Smoke Proof @2026-06-15-0053

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Prior decision: [Docker isolation and model policy](./todo-finished.md#completed-shinyipilot-codex-adapter-docker-isolation-and-model-policy-2026-06-15-0046)
- Artifact directory: `/tmp/shinyipilot-codex-docker-smoke-20260615-0053`
- Source: user chose Docker as the safety boundary before high-density state-changing ShinyiPilot Codex adapter tests.

- [x] Proved the containerized ShinyiPilot Codex adapter smoke with `gpt-5.4-mini`.
      Completion evidence: `smoke-result.json` reports `status=pass`, `model=gpt-5.4-mini`, marker `codex docker smoke marker 20260615-005311`, and CLI response `saved`.
- [x] Verified data-level side effect from the copied artifact DB.
      Completion evidence: `smoke-result.json` records `matchingMemoryMemoRows=1` and `artifactReadbackMemoryMemoRows=1`; direct read-back from `/tmp/shinyipilot-codex-docker-smoke-20260615-0053/chatpilot.db` returns `cli:codex-docker-smoke|codex docker smoke marker 20260615-005311`.
- [x] Verified ShinyiPilot tool execution logs.
      Completion evidence: `/tmp/shinyipilot-codex-docker-smoke-20260615-0053/shinyipilot.log` contains `[tool_call] tool=save_memo`, `[db] SAVE memo`, and `[tool_result] tool=save_memo ... status=success`.
- [x] Verified adapter semantic observability in the smoke artifact.
      Completion evidence: `/tmp/shinyipilot-codex-docker-smoke-20260615-0053/adapter-summary.json` contains `session.lifecycle:created`, `turn.lifecycle:started`, `tool.routing:requested`, `tool.sdk_call:dispatched`, `tool.sdk_result:received`, `assistant.message:completed`, and `turn.lifecycle:completed`.
- [x] Kept the host boundary clean.
      Completion evidence: the Docker runner uses bind mounts only and publishes no host ports; post-run `lsof` checks found no listeners on host `4873` or `29999`.

## Completed: ShinyiPilot Codex Adapter Docker Isolation And Model Policy @2026-06-15-0046

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Runtime proof follow-up: [Docker smoke proof](./todo-finished.md#completed-shinyipilot-codex-adapter-docker-smoke-proof-2026-06-15-0053)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Source: user chose Docker for the state-changing production smoke boundary and `gpt-5.4-mini` for the default Codex-backed daily-office experiment model.

- [x] Decided that Docker is the default boundary for the next state-changing ShinyiPilot Codex adapter smoke.
      Completion evidence: the production runbook now points state-changing ShinyiPilot smokes at the Docker lane and describes host read-only Codex auth, container-local runtime state, no host port publishing, and `/artifacts` as the only host-writable mount.
- [x] Added the Docker smoke artifact skeleton.
      Completion evidence: `Dockerfile`, `run-smoke.sh`, `container-smoke.sh`, and `README.md` live under [shinyipilot-docker-smoke](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/).
- [x] Decided the default Codex-backed model policy for this experiment lane.
      Completion evidence: docs/spec and the runbook name `gpt-5.4-mini` as the default `CODEX_ADAPTER_MODEL` for ShinyiPilot daily-office Codex experiments.
- [x] Kept runtime proof as a separate follow-up instead of claiming the lane was verified before it ran.
      Completion evidence: the follow-up was completed in [Docker smoke proof](./todo-finished.md#completed-shinyipilot-codex-adapter-docker-smoke-proof-2026-06-15-0053) after the container build/run and artifact read-back passed.

## Completed: Python Codex Adapter Semantic Observability Log @2026-06-15-0024

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Active follow-up: [docs/todo.md](./todo.md#p1-codex-adapter-semantic-observability-parity-2026-06-15-0024)
- Code/Surface: [python/copilot/experimental/codex_adapter/server.py](../python/copilot/experimental/codex_adapter/server.py), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py)
- Source: user clarified that Codex raw thread events should become adapter-visible structured classifications before being logged or replayed.

- [x] Added a bounded Python adapter `semanticLog` summary channel.
      Completion evidence: `CodexCopilotAdapterServer.summary()` includes `semanticLog`, capped by the existing transcript limit.
- [x] Classified existing Python adapter junction points without adding SDK events.
      Completion evidence: session create/resume, turn start/completion, assistant message completion, dynamic tool routing, SDK tool call/result, approval request/result, and tool timeout/runtime error paths record stable category/event pairs.
- [x] Added focused regression coverage.
      Completion evidence: `python/test_codex_adapter_server.py` asserts semantic log entries for normal send/assistant completion and protocol-v2 tool routing/SDK result flow.
- [x] Left Node.js counterpart as active parity work.
      Completion evidence: [docs/todo.md](./todo.md#p1-codex-adapter-semantic-observability-parity-2026-06-15-0024) tracks the Node.js implementation debt.

## Completed: ShinyiPilot Codex Adapter Tool Dispatch Production Smoke @2026-06-15-0009

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Active follow-up: [docs/todo.md](./todo.md#p1-shinyipilot-codex-adapter-production-isolation-gate-2026-06-15-0009)
- Code/Surface: [python/copilot/tools.py](../python/copilot/tools.py), [python/test_tool_result_compat.py](../python/test_tool_result_compat.py), ShinyiPilot worktree `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/src/chatpilot/tools/factory.py`, and ShinyiPilot worktree `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/tests/unit/test_tool_factory.py`
- Commits: `420cee72c00a4f52bd433dadb25277dd5e40ffd3` (`fix: preserve legacy tool result kwargs`) and ShinyiPilot worktree `c00a7dced95a472d190c24afcd56c2c91b82315f` (`fix: normalize SDK tool invocation objects`)
- Live proof: `/tmp/shinyipilot-codex-adapter-summary-after-log-normalization.json` and `/tmp/shinyipilot-codex-smoke-after-log-normalization/chatpilot.db`
- Source: user requested continuing the production integration experiment using the ShinyiPilot worktree under the current repo.

- [x] Normalized SDK `ToolInvocation` dataclass objects at the ShinyiPilot `ToolFactory` boundary.
      Completion evidence: `tests/unit/test_tool_factory.py` calls the generated SDK tool handler with `copilot.tools.ToolInvocation` and verifies the handler receives the existing dict-shaped invocation contract.
- [x] Preserved legacy downstream `ToolResult` constructor compatibility in the parent SDK.
      Completion evidence: `ToolResult` accepts camelCase kwargs such as `textResultForLlm`, `resultType`, and `toolTelemetry`, while current SDK code continues to read snake_case fields.
- [x] Proved the production-like forced `save_memo` path end to end.
      Completion evidence: `CHATPILOT_RUNTIME_BACKEND=codex-adapter` with adapter `127.0.0.1:4873`, ShinyiPilot `127.0.0.1:29999`, temp gpt-5.4 route config, and fresh temp DB returned CLI output `saved`; SQLite read-back found exactly one matching `memory_memos` row; ShinyiPilot logs showed `[tool_call] save_memo`, `[db] SAVE memo`, and `[tool_result] ... status=success`; adapter summary showed `resultType: success` and Codex dynamic tool response `success: true`.
- [x] Left the production isolation decision as active work instead of hiding it in the completed proof.
      Completion evidence: [docs/todo.md](./todo.md#p1-shinyipilot-codex-adapter-production-isolation-gate-2026-06-15-0009) tracks the clean `CODEX_HOME` / container / stricter profile decision and the ShinyiPilot model config policy.

## Completed: Codex Adapter Self-Reviewed Workspace Permission Lane @2026-06-14-1106

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [python/copilot/experimental/codex_adapter/server.py](../python/copilot/experimental/codex_adapter/server.py), [python/copilot/experimental/codex_adapter/cli.py](../python/copilot/experimental/codex_adapter/cli.py)
- Tests: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py)
- Source: user clarified that SDK `approve_all` should not make Codex unusable or unsafe; Codex should use auto-review and workspace-scoped execution.

- [x] Changed the adapter default lane from read-only/no-approval to self-reviewed workspace execution.
      Completion evidence: Node and Python defaults now use `approvalPolicy=on-request`, `approvalsReviewer=auto_review`, `sandboxMode=workspaceWrite`, and `networkAccess=false`, with workspace-local operations enabled by default.
- [x] Preserved bounded execution instead of broad SDK approval passthrough.
      Completion evidence: tests assert `thread/start` receives the auto-review approval settings and `turn/start` receives a workspace-write sandbox policy. Network remains disabled by default, and Node/Python tests also assert the explicit enable path sets `sandboxPolicy.networkAccess=true`.
- [x] Updated runtime proof entrypoints.
      Completion evidence: Python live smoke and Node Chatpilot acceptance env now use the self-reviewed workspace lane unless explicitly overridden.

## Completed: Codex Adapter Workspace Isolation Guard @2026-06-14-1044

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [python/copilot/experimental/codex_adapter/server.py](../python/copilot/experimental/codex_adapter/server.py), [python/copilot/experimental/codex_adapter/cli.py](../python/copilot/experimental/codex_adapter/cli.py)
- Tests: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py)
- Source: user identified that missing `workingDirectory` fell back to adapter process cwd and could mix unrelated sessions.

- [x] Isolated fallback workspaces for sessions without explicit `workingDirectory`.
      Completion evidence: Node and Python adapters now create a UUID directory under `CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT` or the system temp default before calling Codex `thread/start`.
- [x] Preserved explicit workspace semantics.
      Completion evidence: Node and Python tests assert an explicit `workingDirectory` is passed through to `thread/start.cwd` without creating a fallback workspace.
- [x] Added observability for concurrent threads sharing one workspace.
      Completion evidence: Node and Python adapters allow the overlap but record `adapter.workspace.concurrent_threads` in the bounded adapter transcript when another active session has the same `cwd` and a different Codex thread id.

## Completed: Python Codex Adapter Sky Eye And CodeTour @2026-06-12-1755

Section source:

- Canonical spec: [docs/spec.md](./spec.md)
- Architecture index: [docs/architecture/README.md](./architecture/README.md)
- Architecture artifact: [docs/architecture/python-codex-adapter-skyeye.html](./architecture/python-codex-adapter-skyeye.html)
- Architecture spec: [docs/architecture/python-codex-adapter-skyeye.spec.json](./architecture/python-codex-adapter-skyeye.spec.json)
- Review tour: [.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour](../.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour)
- Code/Surface: [python/copilot/experimental/codex_adapter](../python/copilot/experimental/codex_adapter), [python/examples/codex_adapter_live_smoke.py](../python/examples/codex_adapter_live_smoke.py)
- Source: user request for a Python-version skyeye plus codetour focused on the adapter module

- [x] Added a focused Sky Eye for the Python-native adapter module.
      Completion evidence: [python-codex-adapter-skyeye.html](./architecture/python-codex-adapter-skyeye.html) maps the SDK client seam, experimental package boundary, CLI runner, adapter core, mapper/policy layer, durable session store, Codex gateway, runtime boundary, and proof lanes.
- [x] Added a CodeTour that walks the Python adapter from boundary to proof.
      Completion evidence: [.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour](../.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour) anchors the package boundary, CLI startup, gateway, server orchestration, session lifecycle, mappers, v2/v3 tool policy, durable resume store, approval/tool backflow, and live smoke artifact.
- [x] Reconciled canonical doc entrypoints for the new review artifacts.
      Completion evidence: [docs/spec.md](./spec.md), [docs/architecture/README.md](./architecture/README.md), and [docs/todo.md](./todo.md) now point to the Python adapter Sky Eye and tour as current review surfaces for the Python-native spike.

## Completed: Python-Native Codex Adapter Spike @2026-06-12-1553

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md](./integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md)
- Canonical spec: [docs/spec.md](./spec.md)
- Code/Surface: [python/copilot/experimental/codex_adapter](../python/copilot/experimental/codex_adapter), [python/examples/codex_adapter_live_smoke.py](../python/examples/codex_adapter_live_smoke.py), [python/copilot/generated/session_events.py](../python/copilot/generated/session_events.py), [python/pyproject.toml](../python/pyproject.toml)
- Tests: [python/test_codex_adapter_mappers.py](../python/test_codex_adapter_mappers.py), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py), [python/test_codex_adapter_session_store.py](../python/test_codex_adapter_session_store.py), [python/test_codex_adapter_parity_snapshot.py](../python/test_codex_adapter_parity_snapshot.py), [nodejs/conformance/codexAdapterParitySnapshot.ts](../nodejs/conformance/codexAdapterParitySnapshot.ts)
- Artifact: [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json)
- Source: user-provided Python-native Codex adapter spike plan

- [x] Added the experimental Python package/CLI adapter surface.
      Completion evidence: `copilot.experimental.codex_adapter` exposes the spike modules, `copilot-codex-adapter` is registered as a Python console script, and root `copilot.__init__` does not re-export adapter internals.
- [x] Ported the selected Node adapter profile into Python-native layers.
      Completion evidence: the spike includes a Copilot-protocol TCP server, Codex app-server gateway, adapter core methods, mappers, v2/v3 tool-routing policy, and durable session store.
- [x] Added fake-gateway parity tests for the first spike gate.
      Completion evidence: `uv run pytest python/test_codex_adapter_mappers.py python/test_codex_adapter_server.py python/test_codex_adapter_session_store.py python/test_codex_adapter_parity_snapshot.py -q` passed with `24 passed`, covering mapper parity, SDK transport, lifecycle, permission callbacks, v2/v3 tool routing, timeout/denied/failure paths, store parse/upsert/delete, and Node-vs-Python selected-profile snapshot comparison.
- [x] Added live Codex app-server smoke for the Python CLI surface.
      Completion evidence: [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json) records a passing `copilot-codex-adapter` CLI smoke with `account/read`, `model/list`, `thread/start`, `turn/start`, `thread/resume`, and `thread/archive` all present in the adapter transcript, while leaving ports `4800`, `4801`, and `4811` untouched.
- [x] Recorded the remaining boundary before treating the spike as production-ready.
      Completion evidence: the spike spec now marks live gateway smoke as complete, keeps ShinyiPilot `29999` smoke as the next downstream gap, and explicitly notes that strict cross-SDK exception-string parity is still a follow-up if product requirements ever need it.

## Completed: Codex Adapter P1 Audit And Canonical Closeout Phase 7 @2026-06-11-2336

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 7
- Canonical spec: [docs/spec.md](./spec.md)
- Code map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Audit: [.audit/AUDIT-codex-adapter-p1-closeout-v1@2026-06-11-2336.md](../.audit/AUDIT-codex-adapter-p1-closeout-v1@2026-06-11-2336.md)
- Review tour: [.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour](../.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour)
- Source: active todo `P1: Runtime Adapter Refactor Architecture Guard` Phase 7

- [x] Completed the post-audit P1 review scope.
      Completion evidence: the audit covers implementation after the previous audit coverage point through `6c0a8db`, including report assembly, optional probe status, tool/approval probes, tool factory, protocol recorder, scenario state, selected-profile comparison closeout, and dynamic-tool policy extraction.
- [x] Preserved public boundary checks.
      Completion evidence: `nodejs/test/codex-adapter.test.ts` still checks that root SDK exports do not expose experimental adapter internals, the experimental subpath does not expose raw gateway classes, and internal runtime implementation subpaths are not published.
- [x] Updated canonical documentation.
      Completion evidence: [docs/spec.md](./spec.md) and [runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md) now point to `nodejs/conformance/` and `nodejs/src/experimental/codexAdapterToolPolicy.ts` as current module surfaces.
- [x] Produced CodeTour-backed audit closeout.
      Completion evidence: [.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour](../.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour) walks the policy helper, live adapter insertion, harness ownership split, and conformance verdict gate.

## Completed: Codex Adapter Conditional Policy Extraction Phase 6 @2026-06-11-2332

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 6
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Evidence artifact: [refactor-phase6-conditional-policy@2026-06-11-2330.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase6-conditional-policy@2026-06-11-2330.summary.json)
- Code/Surface: [nodejs/src/experimental/codexAdapterToolPolicy.ts](../nodejs/src/experimental/codexAdapterToolPolicy.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/test/codex-adapter-tool-policy.test.ts](../nodejs/test/codex-adapter-tool-policy.test.ts)
- Raw comparison artifact: `/tmp/copilot-codex-phase6-policy-20260611-2330.json`
- Source: active todo `P1: Runtime Adapter Refactor Architecture Guard` Phase 6

- [x] Extracted only the real Strategy/Policy variation axis.
      Completion evidence: [codexAdapterToolPolicy.ts](../nodejs/src/experimental/codexAdapterToolPolicy.ts) owns protocol-version dynamic-tool routing. Protocol v2 returns SDK `tool.call` request params; protocol v3 returns stable `codex-dynamic-tool:<callId>` request ids plus `external_tool.requested` event payloads.
- [x] Inserted the policy helper into the live adapter path.
      Completion evidence: [codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts) now uses `planDynamicToolCallRouting()` before dispatching protocol-v2 `tool.call` or protocol-v3 pending event flow, while gateway IO, timeout, transcript, and session mutation stay in the adapter.
- [x] Added dedicated variant tests.
      Completion evidence: [codex-adapter-tool-policy.test.ts](../nodejs/test/codex-adapter-tool-policy.test.ts) asserts both protocol-v2 and protocol-v3 routing shapes.
- [x] Avoided pattern theater for non-variant candidates.
      Completion evidence: approval request/decision behavior remains mapper functions because no second live approval strategy exists; tool deny/failure remains a result mapper because deny/failure are data variants; generic runtime framework policy is deferred until another backend or concrete conformance need exists.
- [x] Preserved selected-profile behavior after policy extraction.
      Completion evidence: selected-profile comparison run `1024a103-364b-4b94-ac54-6de5e808ddf1` passed with `copilotCli=396` and `codexAdapter=1146` ledger entries; all seven selected-profile checks passed for both backends with `traceParity`, `dataAssertion`, and `intentAssertion` all passing and `missing=[]`.

## Completed: Codex Adapter Conformance Harness Decomposition Phase 5 @2026-06-11-2324

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 5
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Evidence artifact: [refactor-phase5-decomposition-selected-profile@2026-06-11-2320.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-decomposition-selected-profile@2026-06-11-2320.summary.json)
- Prior progress audit and tour: [.audit/AUDIT-codex-adapter-p1-progress-v1@2026-06-11-1941.md](../.audit/AUDIT-codex-adapter-p1-progress-v1@2026-06-11-1941.md), [.tours/audit-codex-adapter-p1-progress-20260611-1941.tour](../.tours/audit-codex-adapter-p1-progress-20260611-1941.tour)
- Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/conformance](../nodejs/conformance), [nodejs/test](../nodejs/test)
- Raw comparison artifact: `/tmp/copilot-codex-selected-profile-20260611-2320.json`
- Source: active todo `P1: Runtime Adapter Refactor Architecture Guard` Phase 5

- [x] Deleted the active inline minimal harness residue from the selected-profile spike.
      Completion evidence: `RawCodexAppServerClient` and `_MinimalCopilotAdapterServer` were removed from [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts); [boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md) records the oracle fitness rule as `passing-now`.
- [x] Split conformance harness responsibilities by evidence ownership.
      Completion evidence: proof assertions live in [codexConformanceProof.ts](../nodejs/conformance/codexConformanceProof.ts); ledger normalization in [codexConformanceLedger.ts](../nodejs/conformance/codexConformanceLedger.ts); report aggregation in [codexConformanceReport.ts](../nodejs/conformance/codexConformanceReport.ts); custom tool assertions in [codexConformanceToolProbe.ts](../nodejs/conformance/codexConformanceToolProbe.ts); approval probe contracts in [codexConformanceApprovalProbe.ts](../nodejs/conformance/codexConformanceApprovalProbe.ts); deterministic tool fixtures in [codexConformanceToolFactory.ts](../nodejs/conformance/codexConformanceToolFactory.ts); protocol capture in [codexConformanceProtocolRecorder.ts](../nodejs/conformance/codexConformanceProtocolRecorder.ts); and runner event state in [codexConformanceScenarioState.ts](../nodejs/conformance/codexConformanceScenarioState.ts). Each module has a dedicated `nodejs/test/codex-conformance-*.test.ts` file.
- [x] Preserved selected-profile semantics after decomposition.
      Completion evidence: selected-profile comparison run `e627ec9c-5ae6-4a36-b843-df215cd728bd` passed with `copilotCli=405` and `codexAdapter=1145` ledger entries; all seven checks passed for both backends with `traceParity`, `dataAssertion`, and `intentAssertion` all passing and `missing=[]`.
- [x] Preserved raw artifact hygiene.
      Completion evidence: the raw 2.7M `/tmp/copilot-codex-selected-profile-20260611-2320.json` transcript is not committed because it contains large runtime transcripts and account/model detail; the repo keeps a compact summary, command, hash, result matrix, and comparison notes instead.

## Completed: Codex Adapter Experimental Path Graduation Decision @2026-06-11-1534

Section source:

- Decision: [docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md](./integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md)
- Canonical spec: [docs/spec.md](./spec.md)
- Code map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Plan source: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 7
- Package surface: [nodejs/package.json](../nodejs/package.json), `./experimental/codex-adapter`
- Source surface: [nodejs/src/experimental](../nodejs/src/experimental)
- Test guards: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- Source: user noticed the cleaned adapter modules still live under `experimental/`

- [x] Decided and executed the adapter graduation path after Phase 4/5 production evidence.
      Completion evidence: the adapter intentionally remains under `nodejs/src/experimental/` and `./experimental/codex-adapter` for the next P1 refactor slice. The rationale is recorded in the adapter graduation decision, linked from `docs/spec.md` and the runtime backend code map, and the active todo has been removed from `docs/todo.md`.
- [x] Preserved the stable API boundary.
      Completion evidence: no package exports, source paths, bins, or runtime code were moved. Existing tests still guard that root SDK exports do not expose Codex adapter internals, the experimental subpath does not expose raw gateway classes, and no internal runtime subpaths are published.
- [x] Defined the future graduation trigger.
      Completion evidence: graduation should be revisited only after architecture guard closeout: stale inline harness residue deleted or archived, harness responsibilities split by evidence ownership, policy extraction justified by real variants, before/after conformance artifacts preserved, and canonical docs/code map pointing to final module surfaces.

## Completed: Codex Adapter P0 Production Readiness Gate @2026-06-11-1143

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Phase 6 artifact: [refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Code/Surface: [nodejs/conformance/codexConformanceProof.ts](../nodejs/conformance/codexConformanceProof.ts), [nodejs/examples/codex-adapter-phase6-policy-audit.ts](../nodejs/examples/codex-adapter-phase6-policy-audit.ts), [nodejs/examples/codex-app-server-smoke.ts](../nodejs/examples/codex-app-server-smoke.ts), [nodejs/test/codex-conformance-proof.test.ts](../nodejs/test/codex-conformance-proof.test.ts)
- Raw local artifacts: `/tmp/codex-phase6-policy-cleanup-20260611-1143.json`, `/tmp/codex-phase6-auth-smoke-20260611-1143.json`
- Source: active todo `P0: Codex Adapter Production Readiness Queue` Phase 6

- [x] Closed C2 residual with a safe 26-tool selection benchmark surrogate.
      Completion evidence: Phase 6 policy artifact passes with 26 prompt cases covering 26 Chatpilot tools; side-effecting tools are marked `dry-run-only`; Phase 5 live save/list remains the real execution slice.
- [x] Closed B6 native namespace audit.
      Completion evidence: no Chatpilot SDK tool name collides with known Codex native tools `apply_patch`, `local_shell`, `read_file`, `shell`, `update_plan`, or `write_file`.
- [x] Closed C3/C4 model-behavior readiness checks.
      Completion evidence: Phase 5 live benchmark observed no native Codex tool calls under locked Chatpilot lane; Phase 6 policy audit reports zero description issues across the 26-tool catalog.
- [x] Closed D2 production-like auth inheritance proof.
      Completion evidence: raw auth smoke passes `account/read refreshToken=false`, `account/read refreshToken=true`, and `model/list` from an isolated copied Codex home. Raw smoke is not copied into repo because it can contain account identity details; summary records hash and boolean evidence only.
- [x] Explicitly deferred B7 and D3 as non-blocking P2 follow-ups.
      Completion evidence: runbook and Phase 6 artifact record that current Chatpilot media tools use text-to-LLM or user-visible media policy, not Codex dynamic-tool multimodal output; bounded transcript summary remains the P0 observability contract, while live metrics/health endpoints are deferred until staged deployment needs them.

## Completed: Codex Adapter Production Proof Expansion Phase 5 @2026-06-11-1038

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md), issues A6, B5, C2
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 5
- Evidence artifacts: [refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json), [refactor-phase5-production-proof@2026-06-11-1038.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-production-proof@2026-06-11-1038.summary.json)
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Prior scaffold audit and tour: [.audit/AUDIT-codex-adapter-phase5-proof-scaffold-v1@2026-06-10-1813.md](../.audit/AUDIT-codex-adapter-phase5-proof-scaffold-v1@2026-06-10-1813.md), [.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour](../.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour)
- Production proof audit and tour: [.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md](../.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md), [.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour](../.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour)
- Code/Surface: [nodejs/conformance/codexConformanceProof.ts](../nodejs/conformance/codexConformanceProof.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-conformance-proof.test.ts](../nodejs/test/codex-conformance-proof.test.ts)
- Raw live artifacts: `/tmp/chatpilot-codex-phase5-live-20260611-1037.json`, `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json`
- Source: active todo `P0: Codex Adapter Production Readiness Queue` Phase 5

- [x] Added real Chatpilot 26-tool schema round-trip proof.
      Completion evidence: `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot` drives a live Chatpilot session with 26 chatbot-visible tools; the adapter report compares SDK `session.create.tools` against Codex `thread/start.dynamicTools`; both live artifacts report `expectedToolCount=26`, `observedToolCount=26`, and no failed tools.
- [x] Produced live A6 multi-session concurrent acceptance.
      Completion evidence: `/tmp/chatpilot-codex-phase5-live-20260611-1037.json` passes with `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=2`; each concurrent route has a distinct SDK session id, persists a distinct marker in SQLite `memory_memos`, and reuses the app-level runtime session for the second turn.
- [x] Produced C2 safe tool-call compliance benchmark and backend comparison evidence.
      Completion evidence: `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json` passes with both `copilot-cli` and `codex-adapter`; both backends select `save_memo` and `list_memos` under 26-tool availability, persist/read data through Chatpilot, and report no native Codex tool calls under marker-scoped plus full-trace scanning.
- [x] Preserved the C2 safety boundary for external-side-effect tools.
      Completion evidence: the Phase 5 summary records that this benchmark does not intentionally execute WorkProof push, browser, web search, or other external-side-effect tools. Full prompt-quality tuning across every tool description remains assigned to Phase 6 model-behavior cleanup.

## Completed: Codex Adapter Refactor / Production Hardening Phase 4 @2026-06-09-1155

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 4
- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Phase 3.5 capability spike: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Evidence artifacts: [refactor-phase4-session-lifecycle@2026-06-08-1130.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-session-lifecycle@2026-06-08-1130.summary.json), [refactor-phase4-runtime-session-store@2026-06-09-1102.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-runtime-session-store@2026-06-09-1102.summary.json), [refactor-phase4-final-hardening@2026-06-09-1145.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-final-hardening@2026-06-09-1145.summary.json)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Audit: [.audit/AUDIT-codex-adapter-phase4-final-v1@2026-06-09-1150.md](../.audit/AUDIT-codex-adapter-phase4-final-v1@2026-06-09-1150.md)
- Review tours: [.tours/audit-codex-adapter-phase4-session-lifecycle-20260608-1138.tour](../.tours/audit-codex-adapter-phase4-session-lifecycle-20260608-1138.tour), [.tours/audit-codex-adapter-phase4-runtime-session-store-20260609-1108.tour](../.tours/audit-codex-adapter-phase4-runtime-session-store-20260609-1108.tour), [.tours/audit-codex-adapter-phase4-final-20260609-1150.tour](../.tours/audit-codex-adapter-phase4-final-20260609-1150.tour)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterSessionStore.ts](../nodejs/src/experimental/codexAdapterSessionStore.ts), [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts), [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts)
- Source: active todo `P0: Codex Adapter Production Readiness Queue` Phase 4 and `P1: Runtime Adapter Refactor Architecture Guard` Phase 4

- [x] Implemented session lifecycle semantics from Phase 3.5 spike evidence.
      Completion evidence: `session.create` starts non-ephemeral Codex threads, SDK disconnect maps to idempotent `thread/unsubscribe`, SDK resume maps to `thread/resume`, and SDK delete maps to `thread/archive`.
- [x] Implemented adapter-owned runtime session mapping store.
      Completion evidence: adapter restart can recover `sdkSessionId -> Codex runtime session/thread id` from persisted store and call `thread/resume` instead of failing with `Unknown session`.
- [x] Implemented incompatible resume tool-set policy.
      Completion evidence: in-memory resume with changed tools, adapter-restart resume with missing required tools, and adapter-restart resume with changed tools are rejected before Codex `thread/resume`.
- [x] Implemented long-running server hygiene.
      Completion evidence: adapter and gateway transcripts are bounded by `transcriptLimit`; protocol-v3 pending dynamic tool calls time out and return a failed Codex dynamic tool response; gateway request path can restart a previously-started app-server after child exit.
- [x] Implemented safe tool-result text fallback.
      Completion evidence: object tool results without `textResultForLlm` no longer leak arbitrary object structure into Codex `inputText`; mapper test covers this contract.
- [x] Documented the Phase 4 locked lane and runbook.
      Completion evidence: the Phase 4 runbook documented required `codex login`, stable `CODEX_ADAPTER_CODEX_HOME`, stable `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH`, locked defaults at the time (`approvalPolicy=never`, `sandboxMode=readOnly`, `networkAccess=false`), resume tool-set policy, and common operational knobs. Current default permission posture is superseded by `Codex Adapter Self-Reviewed Workspace Permission Lane @2026-06-14-1106` above.
- [x] Passed final Phase 4 verification gates.
      Completion evidence: local gates passed (`npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 34 tests, scoped `npx tsc --noEmit ...`, scoped `npx eslint ...`, and `npm run build`); selected-profile conformance `/tmp/copilot-codex-refactor-phase4-final.json` run `d83f7062-a944-40cb-a0d9-3f56a436c85c` verdict `pass`; Chatpilot acceptance `/tmp/chatpilot-codex-refactor-phase4-final.json` run `15aade97-d245-43e7-ab78-58c8a9ae631e` status `pass`.
- [x] Audited Phase 4 as ready for consolidated user review.
      Completion evidence: final audit verdict is pass with explicit post-Phase-4 residual risks. Residuals are assigned to Phase 5/6: representative native-tool compliance benchmark, auth token refresh / 401 recovery validation, and optional SDK event-history replay decision if product evidence requires it.

## Completed: Codex Adapter Production Capability Spike Gate @2026-06-04-2028

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 3.5
- Evidence artifact: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-production-capability-spike-v1@2026-06-04-2028.md](../.audit/AUDIT-codex-adapter-production-capability-spike-v1@2026-06-04-2028.md)
- Probe script: [nodejs/examples/codex-app-server-capability-spike.ts](../nodejs/examples/codex-app-server-capability-spike.ts)
- Raw live transcript artifact: `/tmp/codex-app-server-capability-spike-20260604-live.json`
- Source: user request to put spike-only production unknowns before Phase 4 and re-plan implementation from evidence

- [x] Classified Codex app-server lifecycle capability before Phase 4.
      Completion evidence: no `thread/end` / `thread/close` request exists; `thread/unsubscribe` succeeds for listener detach; `thread/archive` succeeds for persisted-thread cleanup after a live turn writes a rollout.
- [x] Proved restart continuity with durable transcript evidence.
      Completion evidence: live turn `019e929a-804c-7012-9316-4ae39940631a` persisted rollout for thread `019e929a-7f57-7980-b000-7be3e99e4afc`; same-process `thread/resume`, restart `thread/resume`, and restart `thread/read` all returned the completed user/agent turn.
- [x] Classified dynamic tool refresh on resume as unsupported.
      Completion evidence: upstream `ThreadStartParams` has `dynamic_tools`, `ThreadResumeParams` does not; a live resume request carrying `dynamicTools` succeeds but must be treated as unknown-field tolerance / ignored-field behavior, not tool refresh support.
- [x] Classified native-tool suppression and sandbox control as Phase 4 partial support.
      Completion evidence: Codex exposes sandbox, permission profiles, config, and `dynamicTools`, but not SDK-shaped `available_tools` / `excluded_tools`; Phase 4 must implement locked Chatpilot lane controls and benchmark native-tool suppression.
- [x] Confirmed basic isolated `CODEX_HOME` auth inheritance.
      Completion evidence: copied isolated home starts app-server and `account/read` succeeds; token refresh / 401 recovery remains a later production-like validation.
- [x] Clarified the runtime identity model for Phase 4 implementation.
      Completion evidence: production docs now distinguish `codex app-server` process from Codex thread and Copilot SDK session. One app-server process can host many Codex threads; a Codex thread is the task-session unit closest to a Codex CLI session; app-server health is only a precondition, while `thread/resume` / `thread/read` is the continuity proof.

## Completed: Runtime Adapter Refactor Phase 3 @2026-06-04-1710

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary fitness: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md)
- Code/Surface: [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- Evidence artifact: [refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-phase3-gateway-boundary-v1@2026-06-04-1710.md](../.audit/AUDIT-codex-adapter-phase3-gateway-boundary-v1@2026-06-04-1710.md)
- Review tour: [.tours/audit-codex-adapter-phase3-gateway-boundary-20260604-1710.tour](../.tours/audit-codex-adapter-phase3-gateway-boundary-20260604-1710.tour)
- Source: refactor plan Phase 3; `boundary-fitness.md` expected violation for raw gateway class exposure

- [x] Moved Codex app-server process and JSON-RPC client behavior behind an adapter-internal gateway module.
      Completion evidence: [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts) now owns process spawn, Codex home preparation, JSON-RPC request/notify/respond, app-server notification/request routing, timeout handling, and gateway transcript capture.
- [x] Made the adapter facade depend on gateway capability instead of a public concrete app-server class.
      Completion evidence: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts) no longer defines or exports `CodexAppServerClient`; `CodexCopilotAdapterServer` creates the internal gateway by default and keeps app-facing constructor options free of gateway injection types.
- [x] Removed raw gateway class exposure from the experimental adapter public subpath.
      Completion evidence: `keeps experimental adapter subpath free of raw gateway classes` in [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), plus build-time declaration check showing `codexAdapter.d.ts` does not expose or import gateway/JSON-RPC types.
- [x] Preserved runtime transcript/error observability and existing behavior after gateway extraction.
      Completion evidence: local gates passed (`npx tsc --noEmit ...`, `npx eslint ...`, `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 2 files / 26 tests passing, and `npm run build`), selected-profile conformance `runId=4d82c62d-19b2-4749-9248-50d31b39c99c`, verdict `pass`, 7/7 checks pass, `copilotCli=396` and `codexAdapter=1473` ledger entries, and Chatpilot acceptance `runId=546a6ab7-5476-46d3-b315-d2caf6dae322`, status `pass`.

## Completed: Runtime Adapter Refactor Phase 2 @2026-06-04-0942

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary references: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md)
- Code/Surface: [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- Evidence artifacts: [refactor-phase2-command-mapper@2026-06-03-2248.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-command-mapper@2026-06-03-2248.summary.json), [refactor-phase2-file-approval-mapper@2026-06-04-0822.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-file-approval-mapper@2026-06-04-0822.summary.json), [refactor-phase2-mapper-layer@2026-06-04-0942.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-phase2-mapper-layer-v1@2026-06-04-0942.md](../.audit/AUDIT-codex-adapter-phase2-mapper-layer-v1@2026-06-04-0942.md)
- Review tour: [.tours/audit-codex-adapter-phase2-mapper-layer-20260604-0942.tour](../.tours/audit-codex-adapter-phase2-mapper-layer-20260604-0942.tour)
- Source: refactor plan Phase 2; user request to preserve spike behavior while extracting minimal clean mapper bricks

- [x] Extracted command approval request/result mapping into a pure adapter-local mapper module.
      Completion evidence: dedicated tests in [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts), inserted into the live adapter flow, and no-regression gates recorded in [refactor-phase2-command-mapper@2026-06-03-2248.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-command-mapper@2026-06-03-2248.summary.json).
- [x] Extracted file-change approval request/result mapping into the same pure mapper module.
      Completion evidence: dedicated file approval tests, live adapter insertion, selected-profile conformance `runId=4f54f8b5-46bf-484e-a281-55631edf8458`, and Chatpilot acceptance `runId=40cf07a3-9bff-4d6e-aa05-8d4f0027dd6f`.
- [x] Extracted SDK tool descriptor mapping, SDK tool result mapping, model list conversion, and sandbox request shape conversion.
      Completion evidence: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts) now imports these translations from [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), and mapper tests fail on contract drift for missing evidence, default shapes, failed tool results, model capabilities, and sandbox aliases.
- [x] Preserved Phase 1 functional behavior after inserting the completed mapper layer.
      Completion evidence: local gates passed (`npx tsc --noEmit ...`, `npx eslint ...`, `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 2 files / 24 tests passing, and `npm run build`), selected-profile conformance `runId=dd467a11-24b7-4241-8ee4-93d19e8eb270`, verdict `pass`, 7/7 checks pass, `copilotCli=421` and `codexAdapter=1674` ledger entries, and Chatpilot acceptance `runId=15ec983d-293e-4142-9a67-fd203e64ffec`, status `pass`.
- [x] Kept protocol-v2/v3 dynamic tool request normalization out of Phase 2 because it is not currently a pure mapper brick.
      Completion evidence: the decision is recorded in [refactor-phase2-mapper-layer@2026-06-04-0942.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json). Current protocol branching touches session state, pending tool-call lifecycle, SDK connection IO, and transcript emission; extracting it now would create pattern theater. Revisit during Phase 4/6 only if a real variant seam appears.

## Completed: Runtime Adapter Refactor Phase 1 @2026-06-03-2242

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary fitness: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md)
- Code/Surface: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Evidence artifacts: [refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json), [refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json)
- Source: refactor plan Phase 1; subagent review finding that characterization and executable boundary fitness must precede extraction

- [x] Added top-down adapter-facing characterization tests without freezing the current mixed module layout.
      Completion evidence: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts) now covers root export guard, package export guard, core source import guard, capability flags, deferred profiles, named server boundary, and SDK-facing create/send behavior through a fake Codex gateway seam.
- [x] Updated boundary fitness status with executable evidence and remaining expected violations.
      Completion evidence: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md) records all current `passing-now` rules with test/artifact evidence; the remaining `CodexAppServerClient` public gateway export and stale inline harness oracle are explicitly assigned to Phase 3 and Phase 5.
- [x] Passed local Phase 1 verification gates.
      Completion evidence: `npx tsc --noEmit ...`, `npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts test/codex-adapter.test.ts`, `npx vitest run test/codex-adapter.test.ts` with 7 tests passing, and `npm run build`.
- [x] Passed broad selected-profile conformance and Chatpilot runtime acceptance after rerunning sandbox-blocked commands outside the sandbox.
      Completion evidence: selected-profile conformance `runId=34902c4f-117f-4e89-8cf9-590ce9ba3640`, verdict `pass`, 7/7 checks pass, `copilotCli=396` and `codexAdapter=1570` ledger entries; Chatpilot acceptance `runId=3ebf6f98-d69a-489b-8758-d2c42f7b7aef`, status `pass`, both `copilot-cli` and `codex-adapter` pass with cross-backend memo/tool-intent assertions.

## Completed: Codex SDK Runtime Profile Parity @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md), [docs/integrations/codex-sdk-runtime-profile/plan.md](./integrations/codex-sdk-runtime-profile/plan.md), [.progress/progress.md](../.progress/progress.md)
- Architecture: [docs/architecture/skyeye.html](./architecture/skyeye.html)
- Code Map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Conformance: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capability notes: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Downstream surface: `/Users/rickwen/code/chatpilot/src/chatpilot/sdk/session.py`, `/Users/rickwen/code/chatpilot/tests/unit/test_sdk_session.py`
- Source: runtime backend replacement milestone

- [x] Phase 1: Locked the target as `SDK Core Profile + Coding Agent Profile`, while explicitly deferring `Interactive Profile`, `Fidelity Profile`, and `Extended CLI Profile`.
- [x] Phase 2: Built baseline-vs-adapter conformance reporting around normalized ledgers and machine-readable verdicts.
- [x] Phase 3: Passed selected-profile conformance for core new session, resume continuation, command approval approve/deny, file approval approve/deny, custom tool call, and tool deny/failure.
      Completion evidence: `/tmp/copilot-codex-all-tool-failure-20260601-v1.json`, summarized in [selected-profile-conformance@2026-06-01.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/selected-profile-conformance@2026-06-01.summary.json).
- [x] Phase 4: Graduated the spike into reusable adapter module boundary.
      Completion evidence: `CodexCopilotAdapterServer`, `CodexAppServerClient`, `createCodexCopilotClientOptions`, package subpath `./experimental/codex-adapter`, and `/tmp/copilot-codex-all-module-20260601-v1.json`.
- [x] Phase 5: Integrated the adapter into the downstream Chatpilot runtime seam without changing app-level routing, execution identity, memory ownership, or tool registration.
      Completion evidence: `copilot-codex-adapter` server runner, `CHATPILOT_COPILOT_CLI_URL`, `CHATPILOT_RUNTIME_BACKEND=codex-adapter`, protocol-v2 tool handling, direct `SdkClient` smoke, and custom Python SDK tool smoke.
- [x] Phase 6: Passed real Chatpilot `/cli/chat` new-session and run-session acceptance against both `Copilot SDK + Copilot CLI` and `Copilot SDK + Codex adapter + Codex app-server`.
      Completion evidence: `/tmp/chatpilot-codex-phase6-all-20260601-v1.json`, summarized in [chatpilot-runtime-acceptance@2026-06-01-1357.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/chatpilot-runtime-acceptance@2026-06-01-1357.summary.json). Both backends persisted SQLite `memory_memos`, invoked `save_memo` / `list_memos`, reused the same Chatpilot SDK session on the second turn, and passed cross-backend assertions.
- [x] Phase 7: Closed the milestone with canonical spec updates, architecture diagram, code map, conformance artifact index, unsupported capability notes, and todo archive.
      Completion evidence: [docs/spec.md](./spec.md), [docs/architecture/skyeye.html](./architecture/skyeye.html), [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md), [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md), and this archive entry.

## Completed: Canonical Spec Pack Gaps @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Source: migrated from session continuity and live adapter findings

- [x] Created a runtime-backend architecture diagram and linked it from `docs/spec.md`.
      Completion evidence: [docs/architecture/skyeye.html](./architecture/skyeye.html), visually checked via Chrome headless screenshot `/tmp/copilot-runtime-skyeye-v3.png`.
- [x] Created a code map for the Codex bridge path and linked it from `docs/spec.md`.
      Completion evidence: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md).
- [x] Decided whether the adapter spike stays exploratory or becomes a reusable module.
      Completion evidence: the Codex bridge is now a reusable experimental Node module at [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), exposed through package subpath `./experimental/codex-adapter`, with capability flags in `CODEX_ADAPTER_CAPABILITIES`.

## Completed: Codex Baseline Replaceability @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/codex-app-server-smoke.ts](../nodejs/examples/codex-app-server-smoke.ts)
- Source: live spike proving the baseline session path

- [x] Proved `create -> send -> disconnect -> resume -> getMessages -> second send` works end to end.
- [x] Proved state survives reconnect and resume with a fresh SDK client.
- [x] Proved the narrow Codex facade can return `READY` and `READYREADY` on the baseline path.
- [x] Captured the live baseline as a reusable `RuntimeBackend` reference point.

## Completed: Codex Command Approval Callback @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/codex-app-server-smoke.ts](../nodejs/examples/codex-app-server-smoke.ts)
- Source: live command approval probe and adapter bridge validation

- [x] Proved `item/commandExecution/requestApproval` can be mapped through the adapter to SDK `permission.request`.
- [x] Proved the SDK permission result can be mapped back to Codex `result.decision`.
- [x] Proved a workspace-outside file write can complete with live approval handling.
- [x] Proved the output file exists and contains the exact expected contents `hello`.
