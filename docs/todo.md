# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-15 09:32
Status: Active

## P1: ShinyiPilot Deployment Ownership Transition @2026-06-15-0932

Section source:

- Spec: [docs/spec.md](./spec.md)
- Docker lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Production LINE lab plan: [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md)
- Ownership transition plan: [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Source: user accepted keeping short-term ShinyiPilot production-line deployment decisions in the parent `copilot-sdk` branch because `shinyipilot-spike/` is a nested worktree and parent git cannot own its internal files as canonical source.
- Source update: user clarified the long-term split: `copilot-sdk` owns Codex adapter, Docker lab, and adapter E2E during transition; `shinyipilot` owns minimal app compatibility, product config, and future full Docker/config/DB deployment ownership.

Current checkpoint @2026-06-15 09:32:

- `run-production-line.sh` now implements the dedicated production-line shadow
  runner.
- The runner uses real `~/code/shinyipilot` source/config/env and host-backed
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime:/runtime`.
- Because the real ShinyiPilot checkout has not yet accepted the Codex adapter
  runtime patches, the runner overlays only `src/chatpilot/sdk/session.py` and
  `src/chatpilot/tools/factory.py` from `shinyipilot-spike` into the temporary
  Docker build context. The original checkout is not modified.
- That overlay is now classified as a temporary proof bridge, not the default
  production source mode. Production cutover should wait until the accepted
  ShinyiPilot patch subset is ported into `~/code/shinyipilot`, and a
  no-overlay shadow proof passes.
- Startup backup passed at
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-030207-production-line-startup`.
- Shadow preflight passed at
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-030207-production-line-shadow`.
  It verified health, real LINE config env presence, route policy,
  source-message capture, route identity registry update, and log evidence.
- Host `2999` was not published; post-run `lsof` found no listener.
- The old host-local `2999` service may be stopped for cutover, but stopping it
  must not edit, delete, or migrate its data.

- [ ] Port the accepted ShinyiPilot adapter compatibility subset into `~/code/shinyipilot`.
  - Source: ownership transition plan M2 and user decision to keep long-term interaction as `~/code/copilot-sdk` + `~/code/shinyipilot`.
  - Code/Surface: `/Users/rickwen/code/shinyipilot/src/chatpilot/sdk/session.py`, `/Users/rickwen/code/shinyipilot/src/chatpilot/tools/factory.py`, matching ShinyiPilot unit tests, and the current reference files under `shinyipilot-spike`.
  - Done when: ShinyiPilot supports `CHATPILOT_RUNTIME_BACKEND=codex-adapter` and SDK `ToolInvocation` normalization from its own source, tests pass, and no `.env`, route config, DB, runtime asset, or production data file is modified.
- [ ] Make `run-production-line.sh` no-overlay by default.
  - Source: ownership transition plan M3 no-hidden-overlay guard.
  - Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), `source-overlay-manifest.json` artifact behavior, production runbook, and Docker lab README.
  - Done when: shadow mode builds from `~/code/shinyipilot` as-is by default, overlay requires an explicit debug flag and artifact evidence, and cutover mode refuses overlay-enabled builds.
- [ ] Produce a no-overlay production-line shadow proof.
  - Source: ownership transition plan M4 and current overlay caveat in [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md).
  - Code/Surface: production-line runner, startup backup helper, synthetic LINE webhook preflight, host-backed `/runtime`, artifact result JSON, ShinyiPilot logs, and adapter summary.
  - Done when: the latest artifact records source mode as no overlay, `/health` passes, synthetic LINE webhook DB/log read-back passes, startup backup passes, and host `2999`, `4800`, `4801`, and `4811` remain untouched.
- [ ] Prepare host `2999` cutover and backout checklist.
  - Source: user said the old `2999` service can be stopped directly, but data must not be modified.
  - Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md), production runbook, and runner flags for `127.0.0.1:2999:29999`.
  - Done when: cutover requires the latest no-overlay shadow pass, fresh startup backup, old-service stop confirmation, container health, Cloudflare tunnel target confirmation, and a documented stop-container backout path.

## P1: Codex Adapter Semantic Observability Parity @2026-06-15-0024

Section source:

- Spec: [docs/spec.md](./spec.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Code/Surface: [python/copilot/experimental/codex_adapter/server.py](../python/copilot/experimental/codex_adapter/server.py), [python/test_codex_adapter_server.py](../python/test_codex_adapter_server.py), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts)
- Source: user clarified that Codex raw thread events should become adapter-visible structured classifications before they are logged or replayed.

Current checkpoint @2026-06-15 00:24:

- Python adapter now records bounded `semanticLog` entries in summary output.
- Python categories currently include `session.lifecycle`, `turn.lifecycle`,
  `assistant.message`, `tool.routing`, `tool.sdk_call`, `tool.sdk_result`,
  `approval.requested`, `approval.resolved`, and `runtime.error`.
- Python implementation intentionally does not add new SDK events; it keeps
  this as structured observability for logs/replay/debug proof.
- Node.js adapter counterpart is not yet implemented.

- [ ] Add the same adapter semantic observability vocabulary to the Node.js Codex adapter.
  - Source: Python-first semantic log work completed before production deploy/high-density test.
  - Code/Surface: `nodejs/src/experimental/codexAdapter.ts`, `nodejs/src/experimental/codexAppServerGateway.ts`, Node conformance tests, and selected-profile summary artifacts.
  - Done when: Node summary/log artifacts expose the same stable adapter categories as Python for session lifecycle, turn lifecycle, assistant message completion, tool routing, SDK tool call/result, approval request/result, and runtime error/timeout, without adding product-facing SDK events.

## P2 Pending: Codex Container Auth Persistence Strategy @2026-06-15-0106

Section source:

- Spec: [docs/spec.md](./spec.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Code/Surface: [python/copilot/experimental/codex_adapter/gateway.py](../python/copilot/experimental/codex_adapter/gateway.py), [container-smoke.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-smoke.sh)
- Source: user asked how Docker handles Codex auth before broader Codex + Copilot SDK testing.

Current checkpoint @2026-06-15 01:06:

- Short state-changing Docker smokes use host `~/.codex` only as a read-only
  auth source.
- The smoke copies `auth.json`, `installation_id`, and `models_cache.json`
  when present into `/runtime/codex-clean-home`.
- The smoke generates a minimal `config.toml` in `/runtime/codex-clean-home`.
  Host `config.toml` is intentionally not copied, so host MCP/plugin/skill
  settings do not enter the Docker smoke lane.
- `gateway.py` still runs with `CODEX_ADAPTER_ISOLATE_CODEX_HOME=true`, so
  `codex app-server` receives a second isolated container-local `CODEX_HOME`.
- Any Codex token refresh/session writes happen inside container-local homes and
  are discarded when the container exits.
- This is acceptable for short smoke tests. It is not yet the long-running
  production auth strategy.
- Latest short-smoke proof with clean config passed at
  `/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107`.

- [ ] Decide and document the long-running container auth strategy.
  - Source: the clean Docker smoke lane deliberately avoids writable host Codex home state.
  - Code/Surface: production runbook, Docker deployment shape, secret/volume policy, and `CODEX_ADAPTER_CODEX_HOME` / `CODEX_ADAPTER_ISOLATE_CODEX_HOME` settings.
  - Done when: the runbook states whether long-lived containers use a controlled writable secret volume, a refresh-token persistence policy, API-key/service-account lane, or another explicit auth mechanism; the decision must say where refresh/session state can be written and how it is rotated or discarded.

## P2: ShinyiPilot Custom Prompt Prefix Delete Gap @2026-06-15-0126

Section source:

- Spec: [docs/spec.md](./spec.md)
- Docker lab lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Evidence: `/tmp/shinyipilot-codex-docker-lab-live-20260615-0124/shinyipilot.log`, `/tmp/shinyipilot-codex-docker-lab-live-20260615-0124/adapter-summary.json`
- Code/Surface: `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/src/chatpilot/tools/builtin/list_custom_prompts.py`, `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/src/chatpilot/tools/builtin/delete_custom_prompt.py`
- Source: broad Codex + SDK Docker lab testing found an app-level tool usability mismatch.

Current checkpoint @2026-06-15 01:26:

- `list_custom_prompts` returns shortened IDs like `[f4663078]`.
- `delete_custom_prompt` currently passes the provided `prompt_id` directly to
  `memory_store.delete(route_id, "custom_prompt", prompt_id)`.
- A natural user turn that asked Codex to list and delete the current preference
  called `list_custom_prompts` and then `delete_custom_prompt` with
  `prompt_id=f4663078`.
- ShinyiPilot returned `找不到 ID 為 f4663078 的偏好設定`; adapter
  `semanticLog` correctly recorded `tool.sdk_result success=false`.
- This is not an adapter dispatch failure. It is a ShinyiPilot tool contract gap
  between list output and delete input, similar to the prefix support already
  present in `delete_memo`.

- [ ] Make `delete_custom_prompt` support unambiguous ID prefixes or change `list_custom_prompts` to expose full IDs.
  - Source: Docker lab probe using `gpt-5.4-mini` and natural-language CLI turns.
  - Code/Surface: ShinyiPilot `delete_custom_prompt.py`, `list_custom_prompts.py`, and matching unit tests in the nested ShinyiPilot worktree.
  - Done when: a user can ask to list and delete a preference by the displayed ID, DB read-back confirms deletion, ShinyiPilot logs show `status=success`, and adapter `semanticLog` records `tool.sdk_result success=true`.

## P1: Runtime Adapter Refactor Architecture Guard @2026-06-03-1141

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- References: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [SHIP](../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md), [learning packet](./integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md), [prior cleanup draft](./integrations/codex-sdk-runtime-profile/module-cleanup-plan.md), and [runtime backend code map](./architecture/runtime-backend-code-map.md)
- Source: user request to consolidate side-thread learning/refactor context into canonical spec/plan before implementation

No active P1 Runtime Adapter Refactor Architecture Guard phases remain. Completed Phase 5-7 work has been moved to [docs/todo-finished.md](./todo-finished.md).

Current milestone state:

- Canonical spec: [docs/spec.md](./spec.md)
- Architecture diagram: [docs/architecture/skyeye.html](./architecture/skyeye.html)
- Python adapter sky eye: [docs/architecture/python-codex-adapter-skyeye.html](./architecture/python-codex-adapter-skyeye.html)
- Code map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Python adapter CodeTour: [.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour](../.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Runtime profile plan: [docs/integrations/codex-sdk-runtime-profile/plan.md](./integrations/codex-sdk-runtime-profile/plan.md)
- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Production capability spike: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Python-native adapter spike: [docs/integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md](./integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md)
- Python-native adapter live smoke: [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json)
- Conformance artifacts: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capabilities: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)

Completed work for the milestone has been moved to [docs/todo-finished.md](./todo-finished.md).
