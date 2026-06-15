# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-15 17:17
Status: Active

## P0: ShinyiPilot Production Agent Cleanup And Capability Gates @2026-06-15-1109

Section source:

- Spec: [docs/spec.md](./spec.md)
- Cutover archive: [docs/todo-finished.md](./todo-finished.md#completed-shinyipilot-host-2999-codex-cutover-2026-06-15-1050)
- Cutover checklist: [host-2999-cutover-checklist.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/host-2999-cutover-checklist.md)
- Ownership transition plan: [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md)
- Docker lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Code/Surface: [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), [container-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-production-line.sh), ShinyiPilot `/Users/rickwen/code/shinyipilot`, host-backed `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`
- Source: user wants to first confirm current production agent capability and then add stronger self-iteration powers, including bounded shell calls and proactive skill-generation records. The agreed order is to clean the codebase and ownership boundary before granting new agent powers.

Current checkpoint @2026-06-15 11:19:

- Docker-backed ShinyiPilot already owns host `127.0.0.1:2999`.
- Real LINE canaries passed after ShinyiPilot route models were changed to
  `gpt-5.4-mini`.
- The next work must not assume Docker alone is enough isolation, because the
  running container mounts real `/runtime`, real ShinyiPilot config, and Codex
  auth.
- The current host-backed runtime copy is allowed to remain where it is during
  stabilization. It must not be cleaned up until ShinyiPilot owns the final
  DB/runtime layout and the NAS backup/restore route has evidence.
- New shell/self-improvement powers are intentionally blocked behind cleanup and
  capability gates.

- [ ] Clean the codebase and ownership boundary before adding new agent powers.
  - Source: current user decision that codebase cleanup should come before shell/self-iteration expansion.
  - Code/Surface: `docs/todo.md`, `docs/todo-finished.md`, `docs/spec.md`, `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/`, `/Users/rickwen/code/shinyipilot`, and the untracked parent paths `shinyipilot-spike/` and `code-trace/`.
  - Done when: active todo contains only actionable unfinished work; completed-only historical sections are removed from `docs/todo.md` and already represented in `docs/todo-finished.md`; the transition split between `copilot-sdk` and `shinyipilot` is unambiguous; `shinyipilot-spike/` is no longer treated as production source; production config/runtime/DB ownership is explicit; the current copied runtime has a documented keep-until-stable cleanup rule; and no runner silently patches ShinyiPilot app code.
- [ ] Build a production capability confirmation matrix before unlocking broader autonomy.
  - Source: current user request to "完全確認能力可用+再強化".
  - Code/Surface: real LINE route `line:shinyipaint:*`, ShinyiPilot logs, SQLite read-back under `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, adapter `semanticLog`, and existing Docker sweep tools such as [run-sweep.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-sweep.sh).
  - Done when: the matrix proves real production-like behavior for normal reply, memo save/list/delete, reminder and schedule CRUD, custom prompt list/delete after the prefix gap is fixed, warehouse/query-style tool use, observer capture, and file/image ingress if in scope. Each row must include input, expected behavior, DB/log/adapter evidence, cleanup/backout proof if state-changing, and a clear pass/fail result.
- [ ] Design bounded shell and self-improvement capability before implementation.
  - Source: current user request to "完全解放 agent 自我迭代的能力也就是準 shell 能call" and add "自我強化能力（主動 skill 生成記錄）".
  - Code/Surface: ShinyiPilot tool registry, Codex adapter permission/sandbox settings, Docker production-line runtime, skill storage policy, audit logs, and future ShinyiPilot-owned deploy/runbook.
  - Done when: there is a documented design for an admin-only bounded command runner with fixed working directories, command allowlist/denylist, timeout, output cap, environment redaction, audit log, state-changing preflight/backup policy, no destructive defaults, and container/host mount boundaries; skill generation writes only to an approved staging area, records provenance, runs a smoke test, and updates a registry or docs entry before being activated.
- [ ] Implement shell/self-improvement only after the cleanup and capability gates pass.
  - Source: safety ordering from the current discussion.
  - Code/Surface: future ShinyiPilot implementation and `copilot-sdk` adapter-level tests.
  - Done when: implementation is covered by Docker E2E with DB/log/audit evidence, proves denied unsafe commands, proves allowed read-only and bounded write commands, proves skill-generation staging/activation flow, and documents rollback/backout.

## P1: ShinyiPilot Deployment Ownership Transition @2026-06-15-0932

Section source:

- Spec: [docs/spec.md](./spec.md)
- Docker lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Production LINE lab plan: [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md)
- Ownership transition plan: [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md)
- Runtime backup dry-run plan: [runtime-backup-dry-run/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/runtime-backup-dry-run/plan.md)
- Host 2999 cutover checklist: [host-2999-cutover-checklist.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/host-2999-cutover-checklist.md)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Source: user accepted keeping short-term ShinyiPilot production-line deployment decisions in the parent `copilot-sdk` branch because `shinyipilot-spike/` is a nested worktree and parent git cannot own its internal files as canonical source.
- Source update: user clarified the long-term split: `copilot-sdk` owns Codex adapter, Docker lab, and adapter E2E during transition; `shinyipilot` owns minimal app compatibility, product config, and future full Docker/config/DB deployment ownership.
- Source update: user clarified that final DB/runtime ownership should return
  to `~/code/shinyipilot`; the current copied runtime can remain during
  stabilization, but the transition should add periodic sync backup to the NAS
  path `/Volumes/home/backup`.
- Source update: user clarified that the final goal is also to move Codex's
  primary working repo for this production app from `~/code/copilot-sdk` to
  `~/code/shinyipilot`. ShinyiPilot must receive the controller docs and
  handoff context, not only Docker/config/DB files.

Current checkpoint @2026-06-15 11:19:

- `run-production-line.sh` now implements the dedicated production-line shadow
  runner and defaults to no application-code overlay.
- The runner uses real `~/code/shinyipilot` source/config/env and host-backed
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime:/runtime`.
- ShinyiPilot commit `0946d0b` owns the accepted adapter compatibility subset in
  `src/chatpilot/sdk/session.py` and `src/chatpilot/tools/factory.py`.
- `run-production-line.sh` now treats overlay as explicit debug fallback only:
  `ALLOW_SHINYIPILOT_COMPAT_OVERLAY=YES`. Cutover mode refuses overlay-enabled
  builds.
- Startup backup passed at
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0938-production-line-startup`.
- Shadow preflight passed at
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0938-production-line-shadow`
  with `sourceMode=real-shinyipilot-source-no-overlay`.
  It verified health, real LINE config env presence, route policy,
  source-message capture, route identity registry update, and log evidence.
- Host `2999` cutover was executed after explicit user approval.
- Docker container `shinyipilot-codex-line-cutover-20260615-0958` owns
  `127.0.0.1:2999 -> container:29999`.
- Real LINE canary passed after the ShinyiPilot route model policy was corrected
  from `gemini-3-flash` to `gpt-5.4-mini`.
- The current host-backed runtime at
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` remains the
  active transition runtime for the running container. It is not a disposable
  image layer and should not be cleaned up until the ShinyiPilot-owned runtime
  layout and backup/restore route are ready.
- NAS sync backup to `/Volumes/home/backup` is an accepted route but not yet a
  completed recurring automation proof.
- Completion evidence is archived in
  [docs/todo-finished.md](./todo-finished.md#completed-shinyipilot-host-2999-codex-cutover-2026-06-15-1050).

- [ ] Add transitional NAS backup automation for the current host-backed runtime.
  - Source: user decision that the current DB is production-like and should gain a NAS safety copy while final ownership moves back to ShinyiPilot.
  - Plan: [runtime-backup-dry-run/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/runtime-backup-dry-run/plan.md)
  - Code/Surface: [production-runtime-backup.py](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-runtime-backup.py), [run-production-line.sh](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh), `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, `/Volumes/home/backup`, and the future ShinyiPilot-owned runbook.
  - Done when: the dry-run plan has settled and recorded the read-only inventory baseline, local SQLite-aware snapshot proof, NAS sync proof, restore rehearsal proof, final ShinyiPilot runtime layout decision, migration/cutover rehearsal rules, and transition-runtime cleanup criteria; sync is non-destructive and does not use delete semantics by default; restore requires a separate decision; and the final ShinyiPilot runbook says whether this automation moves into `~/code/shinyipilot` or is retired.

- [ ] Move full ShinyiPilot production deployment ownership back to `~/code/shinyipilot` when the transition ends.
  - Source: [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md) and user decision that future complete deployment should move Docker, config, DB, backup, and runbook ownership back to ShinyiPilot.
  - Source update: user clarified that Codex should eventually work from `~/code/shinyipilot` as the primary production app workspace. The handoff therefore includes docs/controller context, not just executable deployment files.
  - Code/Surface: current parent Docker lane, ShinyiPilot config/runtime layout, host-backed `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, `copilot-sdk` transition docs, ShinyiPilot `docs/spec.md`, ShinyiPilot `docs/todo.md`, and a future ShinyiPilot deployment topic such as `docs/codex-line-production/`.
  - Done when: ShinyiPilot repo owns the production Docker/deploy/config/DB/backup runbook, including the final DB location, migration/cutover steps from the current transition runtime, NAS backup cadence/retention, restore rules, and cleanup criteria for the extra transition copy; ShinyiPilot docs contain the controller handoff needed for future Codex sessions to start in `~/code/shinyipilot`; ShinyiPilot docs explain how the `copilot-sdk` adapter is built or pinned into the Docker image, how to verify `copilot-codex-adapter` inside the container, which adapter capabilities are available, and which future changes belong in `copilot-sdk` versus `shinyipilot`; `copilot-sdk` keeps only adapter source/package, adapter-level Docker E2E, semantic observability parity, and historical transition evidence.

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
