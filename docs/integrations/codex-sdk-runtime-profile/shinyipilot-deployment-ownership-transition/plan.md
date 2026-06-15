# ShinyiPilot Deployment Ownership Transition Plan

Created: 2026-06-15 09:32
Last Updated: 2026-06-15 19:42
Status: Active; host 2999 cutover complete, final ownership pending

## Purpose

This plan records how the ShinyiPilot Codex adapter production-line experiment
moves from a `copilot-sdk`-owned Docker lab into a cleaner two-repo operating
model.

The first production-line shadow proof temporarily overlaid two adapter
compatibility files from `shinyipilot-spike` inside the Docker build context.
That was acceptable as a proof technique, but not as a production deployment
shape because the code running in the container would not match the code a
reviewer sees in `~/code/shinyipilot`.

The accepted transition state is now no-overlay: the container builds from real
`~/code/shinyipilot` source/config/env, while this parent `copilot-sdk` branch
still owns the Docker runner, adapter packaging, E2E evidence, and transition
docs. The remaining route work is to move final Docker/config/DB/backup
ownership back into ShinyiPilot and protect the transitional runtime until that
handoff is stable.

The detailed backup/migration dry-run sequence is tracked in
[runtime-backup-dry-run/plan.md](./runtime-backup-dry-run/plan.md). Use that
plan as the evidence ledger for inventory, backup snapshot, NAS sync, restore
rehearsal, final layout, migration, and cleanup decisions.

The code-surface inventory for the first execution step is tracked in
[code-surface-inventory.md](./code-surface-inventory.md). Use it before
porting files or deciding what can be cleaned up.

## Execution Sequence

The remaining transition work has a fixed order. Do not treat "move the
backup/deploy/runbook into ShinyiPilot" and "cleanup" as parallel choices.

1. Locate and classify every code surface.
   - Identify which current files are transition prototypes, which files remain
     adapter-owned in `copilot-sdk`, which files must be recreated or ported
     into `~/code/shinyipilot`, and which paths are runtime state rather than
     source code.
   - This includes the Dockerfile, entrypoint, runner, backup helper, adapter
     package source, ShinyiPilot config/env inputs, runtime DB/assets, NAS
     backup path, and controller docs.
   - Current result:
     [code-surface-inventory.md](./code-surface-inventory.md).
2. Compare the dry-run result against the formal production run.
   - The dry run already proved the data movement shape. The next operational
     pass should use that evidence as the checklist for the real ShinyiPilot
     owned layout: local snapshot, NAS copy, restore candidate, service health,
     DB hashes/row counts, internal `PORT=2999`, and host `2999` ownership.
   - Any production path, port, DB name, mount, adapter pin, or backup semantic
     that did not appear in the dry run is a stop-and-explain difference.
3. Finish teaching and handoff documentation.
   - ShinyiPilot docs must explain how to build the image, pin or consume the
     `copilot-sdk` adapter, mount runtime/config/secrets, back up and restore
     SQLite state, operate host `2999` / Cloudflare, roll back, and decide
     whether future changes belong in `copilot-sdk` or `shinyipilot`.
   - Future Codex sessions should be able to start in
     `/Users/rickwen/code/shinyipilot` and recover the production context from
     ShinyiPilot docs without reading this transition branch first.
4. Cleanup only after the above are true.
   - Cleanup means archive/retire transition-only docs, runners, temporary
     copies, and old runtime evidence according to the cleanup criteria. It does
     not mean deleting production-like DB state just because the formal layout
     exists.
   - Directory deletion still requires explicit approval with absolute path
     inventory.

## Target Ownership

During the transition:

- `copilot-sdk` owns the Codex adapter implementation, adapter packaging,
  Docker lab runner, backup/preflight scripts, behavior sweeps, and
  production-line E2E evidence.
- `shinyipilot` owns the application code needed to select the
  `codex-adapter` runtime backend, tool invocation compatibility, LINE route
  behavior, real route config, `.env` inputs, and product semantics.
- The production-line Docker runner may build from `~/code/shinyipilot`, but it
  must not silently change application source code in the build context.
- ShinyiPilot config remains in `~/code/shinyipilot` during the transition.
  `copilot-sdk` should mount or read it; it should not become the owner of
  product route config.
- Production-like DB/runtime state currently stays in the host-backed
  transition directory `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`
  with SQLite-aware startup backups. It must not be treated as disposable image
  or container state, and it must not be cleaned up until ShinyiPilot owns the
  final DB/runtime layout and migration/backup evidence exists.
- The transition should add non-destructive periodic NAS sync backup under
  `/Volumes/home/backup`. This is a backup route, not a new source of truth and
  not a cleanup signal.

In the future complete deployment:

- `shinyipilot` owns Dockerfile/compose/deploy scripts, app config, DB runtime
  layout, backup/restore policy, and production runbooks.
- The DB/runtime path lives under a ShinyiPilot-owned host state layout, with
  an explicit migration/cutover plan from the current transition runtime. The
  physical production DB/runtime files should not live inside the
  `~/code/shinyipilot` git worktree.
- `copilot-sdk` provides the tested Codex adapter source/package and keeps its
  own adapter-level Docker E2E regression harness.
- `copilot-sdk` no longer owns ShinyiPilot production deployment. It verifies
  that the adapter can be packaged into an app image; it does not operate the
  app's production container.
- The ShinyiPilot repo also becomes the primary work area for future context.
  Final handoff is incomplete until the controller docs, decisions, evidence
  index, and active follow-up todos needed to operate this service are
  represented in ShinyiPilot's own `docs/` and `docs/todo.md`.

## Ownership Boundary By Surface

`~/code/shinyipilot` should own the production deployment contract, while
mutable production state stays in a host state directory. In other words,
"move ownership back to ShinyiPilot" does not mean "put production SQLite files
inside the git repo".

| Surface | Transition owner/path | Final owner/path | Rule |
| --- | --- | --- | --- |
| ShinyiPilot app source for image | `run-production-line.sh` copies from `/Users/rickwen/code/shinyipilot` into a temp Docker build context | `/Users/rickwen/code/shinyipilot` is the Docker build source | Production images build from real ShinyiPilot source. `shinyipilot-spike/` is never a production source. |
| ShinyiPilot product config | `/Users/rickwen/code/shinyipilot/config/route_settings.yaml` and `route_bindings.yaml`, mounted read-only as `/host-config/*` | Same config ownership under `/Users/rickwen/code/shinyipilot/config/`, with real local files remaining untracked/secret-safe | `copilot-sdk` may read or mount config during transition; it must not become the product config owner. |
| ShinyiPilot `.env` / secrets | `/Users/rickwen/code/shinyipilot/.env` supplied as an env file when present | ShinyiPilot deploy/runbook defines the secret source | Never copy secrets into Docker build context, artifacts, or git. |
| Runtime DB/assets physical state | `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` | `/Users/rickwen/.local/state/shinyipilot/production/runtime` | Host state directory is production data. It is mounted into the container as `/runtime`; it is not image state and not a git worktree file. |
| Local runtime backups/artifacts | `/Users/rickwen/.local/state/shinyipilot-codex-line/backups` and `artifacts` | `/Users/rickwen/.local/state/shinyipilot/production/backups` and `artifacts` | Same evidence schema should carry forward; only the owner/root changes. |
| NAS backups | `/Volumes/home/backup/shinyipilot-codex-line/runtime-backups` | `/Volumes/home/backup/shinyipilot/production/runtime-backups` | NAS is backup/restore evidence, not the live source of truth. No delete semantics by default. |
| Dockerfile and entrypoint | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/Dockerfile` and `container-production-line.sh` | ShinyiPilot deployment files, for example `docker/codex-line/Dockerfile`, `docker/codex-line/entrypoint.sh`, and a ShinyiPilot-owned run/deploy script | Final Docker ownership moves to ShinyiPilot. The current files are transition prototypes/evidence until ported. |
| Backup helper | `production-runtime-backup.py` in the `copilot-sdk` Docker lane | ShinyiPilot-owned backup/restore helper or deploy script | Port the behavior, not necessarily the exact file path. Add live read-only snapshot mode before using it as recurring backup. |
| Codex adapter source/package | `copilot-sdk/python/copilot/codex_adapter` copied into the transition image as editable `/workspace/python`, with legacy import wrappers under `copilot.experimental.codex_adapter` | A pinned `copilot-sdk` adapter package/source consumed by ShinyiPilot image build | This is the thin adapter surface that remains in `copilot-sdk`: runtime backend implementation, package, protocol tests, semantic-log parity, compatibility shim, and adapter E2E. |
| Adapter E2E / behavior sweep | `copilot-sdk` Docker smoke/sweep/lab docs and artifacts | `copilot-sdk` keeps adapter-level regression; ShinyiPilot keeps product deployment E2E | SDK tests prove the adapter can run inside an app image. ShinyiPilot tests prove the product deployment, config, DB, and LINE behavior. |
| Controller docs and handoff | `copilot-sdk/docs/spec.md`, `docs/todo.md`, this transition plan, dry-run plan, production-line lab docs, cutover checklist, and `.progress/progress.md` updates | ShinyiPilot `docs/spec.md`, `docs/todo.md`, `docs/todo-finished.md`, and a ShinyiPilot deployment topic such as `docs/codex-line-production/` | Final handoff must let a future agent start in `/Users/rickwen/code/shinyipilot` and recover the production context without depending on session memory or reading this SDK branch first. |

The final image source arrangement should be:

```text
/Users/rickwen/code/shinyipilot
  source of app code, product Dockerfile/entrypoint/deploy docs, product config examples

/Users/rickwen/code/copilot-sdk
  source of the Codex adapter package and adapter-level tests

/Users/rickwen/.local/state/shinyipilot/production/runtime
  production DB/assets mounted into the container as /runtime
```

The image should contain app code plus the pinned adapter package. It should
not contain live route config, `.env`, Codex auth state, SQLite DBs, runtime
assets, or NAS backups.

## Adapter Build And Capability Handoff

The final ShinyiPilot Docker/deploy docs must explain how the Codex adapter is
included in the image. It is not enough to say "use the adapter"; future agents
working from `~/code/shinyipilot` need the build path, pinning rule, runtime
env, and change boundary.

Current transition build behavior:

- `run-production-line.sh` creates a temporary Docker build context.
- It copies `copilot-sdk/python/copilot`, `python/pyproject.toml`,
  `python/uv.lock`, and `python/README.md` into `BUILD_CONTEXT/python`.
- It copies real `/Users/rickwen/code/shinyipilot` app source into
  `BUILD_CONTEXT/shinyipilot`.
- The transition `Dockerfile` copies both into the image and runs:
  `uv pip install --python /workspace/shinyipilot/.venv/bin/python --editable /workspace/python`.
- This editable local-source install is acceptable for transition proof. It is
  not yet a production pinning policy.

Final ShinyiPilot build docs must choose one explicit adapter acquisition mode:

- Local rehearsal mode: copy `/Users/rickwen/code/copilot-sdk/python` into the
  Docker build context and install it like the transition image. This is useful
  for local development and dry-run parity, but it depends on a sibling checkout.
- Production pin mode: build or fetch a wheel/source artifact from a specific
  `copilot-sdk` git SHA and install that artifact in the ShinyiPilot image.
  This is the preferred final production shape because the image can record the
  adapter version independently of the developer's local checkout.
- Git dependency mode: pin a `copilot-sdk` git ref in ShinyiPilot dependency
  metadata if the build environment is allowed to fetch it. This is simpler but
  makes network/build reproducibility policy part of deployment.

The final ShinyiPilot runbook must record which mode is active, the exact
`copilot-sdk` commit or artifact used, and the command that verifies
`copilot-codex-adapter` is installed inside the image.

Required adapter runtime env contract for the ShinyiPilot production lane:

```text
CHATPILOT_RUNTIME_BACKEND=codex-adapter
CHATPILOT_COPILOT_CLI_URL=127.0.0.1:<adapter-port>
CODEX_ADAPTER_PROTOCOL_VERSION=2
CODEX_ADAPTER_MODEL=gpt-5.4-mini
CODEX_ADAPTER_CODEX_HOME=<container clean or controlled Codex home>
CODEX_ADAPTER_ISOLATE_CODEX_HOME=true or an explicitly documented production alternative
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH=/runtime/codex-runtime-sessions.json
CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT=/runtime/codex-workspaces
CODEX_ADAPTER_APPROVAL_POLICY=on-request
CODEX_ADAPTER_APPROVALS_REVIEWER=auto_review
CODEX_ADAPTER_SANDBOX_MODE=workspaceWrite
CODEX_ADAPTER_NETWORK_ACCESS=false unless a documented product lane needs network
CODEX_ADAPTER_SUMMARY_PATH=<artifact path>
```

Adapter capability boundary to hand off:

| Capability or change | Owner after handoff | Boundary rule |
| --- | --- | --- |
| Copilot-protocol server and Codex app-server mapping | `copilot-sdk` | Change in SDK adapter first, prove with adapter conformance/live smoke, then bump the ShinyiPilot adapter pin. |
| Protocol v2 SDK `tool.call` support | `copilot-sdk` adapter plus ShinyiPilot tool contracts | Adapter routes calls; ShinyiPilot owns tool schemas, handlers, DB effects, and user-facing wording. |
| Protocol v3 dynamic-tool policy | `copilot-sdk` | Available as adapter capability, but current ShinyiPilot production lane uses protocol v2. Do not switch without a separate product proof. |
| Session/thread mapping and fallback workspaces | `copilot-sdk` adapter | Runtime store and fallback workspace parent live under `/runtime`; product should pass explicit workspaces when it has a route/user/project identity. |
| Approval, sandbox, and network policy | Shared | Adapter maps policy to Codex; ShinyiPilot deploy docs decide the safe production values. Broader shell powers are a product feature, not automatically granted by the adapter. |
| Adapter `semanticLog` and summary artifacts | `copilot-sdk` format, ShinyiPilot operational use | Use semantic log for control-plane proof; use ShinyiPilot logs/DB for full business side effects. |
| Codex auth persistence | ShinyiPilot deploy/runbook, with adapter knobs | Still an open production decision. The transition lane copies auth into a clean container home; final long-running auth policy must be explicit. |
| Product tools, route config, LINE behavior, DB schema | ShinyiPilot | These changes should happen in `~/code/shinyipilot`, with ShinyiPilot unit/E2E/DB/log proof. |
| Shell/self-improvement features | ShinyiPilot product capability, gated by adapter/deploy policy | Do not treat adapter workspace-write as automatic permission to expose arbitrary shell. Design bounded commands, audit log, and deny tests first. |

Change workflow after handoff:

1. If the change is adapter protocol/runtime behavior, modify
   `~/code/copilot-sdk`, run adapter tests/E2E, publish or pin the new adapter,
   then update ShinyiPilot's adapter pin and run product E2E.
2. If the change is ShinyiPilot tool behavior, config, DB, deploy, backup, or
   LINE behavior, modify `~/code/shinyipilot` first and run ShinyiPilot tests.
3. If the change crosses both boundaries, land the adapter change with evidence
   first, then make the ShinyiPilot consumption change with a pinned adapter
   reference and product evidence.

## No-Hidden-Overlay Guard

The transition guard is:

```text
Default production-line builds must use ~/code/shinyipilot as-is.
Any adapter compatibility overlay must be explicit, artifact-visible, and
debug-only.
```

The overlay existed only because the real ShinyiPilot checkout had not yet
accepted the Codex adapter compatibility changes. After ShinyiPilot commit
`0946d0b` and the parent runner no-overlay change, the production-line runner
defaults to no overlay and cutover mode refuses overlay-enabled builds.

Required runner behavior after the port:

- Shadow mode defaults to real ShinyiPilot source with no application-code
  overlay.
- Cutover mode refuses to run with overlay enabled.
- Overlay can remain as an explicit fallback/debug option, gated by an
  intentionally named environment variable and recorded in artifacts.
- Every production-line artifact records whether source mode was `no-overlay`
  or `overlay-enabled`.

This keeps source, image, and runtime behavior aligned.

## Minimal ShinyiPilot Patch Set

Do not merge the whole `shinyipilot-spike` worktree back into
`~/code/shinyipilot`.

Port only the accepted compatibility subset first:

- `src/chatpilot/sdk/session.py`
  - Adds the `CHATPILOT_RUNTIME_BACKEND=codex-adapter` path.
  - Uses `CHATPILOT_COPILOT_CLI_URL` to point ShinyiPilot's SDK client at the
    Codex adapter server.
- `src/chatpilot/tools/factory.py`
  - Normalizes SDK `ToolInvocation` objects into ShinyiPilot's existing
    dict-shaped tool handler contract.
  - Preserves tool-call and tool-result logging that supports DB/log E2E
    proofs.
- Unit tests for the compatibility behavior, especially the SDK tool invocation
  normalization path.

This keeps ShinyiPilot changes small and reviewable while making the app source
truthful for production-line builds.

Current status:

- Already landed in ShinyiPilot:
  `0946d0b feat: support codex adapter runtime backend`.
- Already landed in ShinyiPilot tracked defaults:
  `0dc74d4 chore: default route models to codex compatible model`.
- No additional accepted `shinyipilot-spike` cherry-pick is required for the
  currently running no-overlay host `2999` production-line container.

Known remaining ShinyiPilot-side work is not a broad spike merge:

- If the production capability matrix includes custom prompt delete by listed
  short id, fix the ShinyiPilot app-level
  `delete_custom_prompt` / `list_custom_prompts` ID-prefix contract and add
  tests. This is a product tool usability fix, not an adapter patch.
- Before final ownership handoff, port or recreate the deployment assets in the
  ShinyiPilot repo: Dockerfile, entrypoint/run script, backup/restore helper,
  env/config documentation, NAS backup runbook, and migration/cutover runbook.
- Before final ownership handoff, port or rewrite the controller documentation
  into ShinyiPilot's canonical docs structure. This includes the accepted
  source/runtime/config path decisions, current host `2999` state, backup and
  restore evidence requirements, migration checklist, cleanup guard, and open
  todos. Do not rely on `copilot-sdk/.progress` or this branch's transition docs
  as the only future handoff source.
- Do not port transition-only artifacts, old overlay mechanics, or the whole
  `shinyipilot-spike/` worktree into ShinyiPilot.

Recommended ShinyiPilot docs landing pack:

- `docs/spec.md`: add the Codex-backed production LINE runtime as a current
  ShinyiPilot deployment/runtime state, with links to the deployment topic.
- `docs/todo.md`: add active ShinyiPilot-owned todos for final Docker deploy,
  backup automation, migration/cutover rehearsal, capability matrix, and later
  shell/self-improvement gates.
- `docs/codex-line-production/spec.md`: product-owned current-state spec for
  Docker, config, runtime, DB, Codex adapter consumption, and host `2999`.
- `docs/codex-line-production/plan.md`: migration and handoff plan from the
  current transition runtime to the final ShinyiPilot-owned layout.
- `docs/codex-line-production/runtime-backup-dry-run.md` or equivalent:
  backup/restore evidence ledger copied or rewritten from this dry-run plan.
- `docs/todo-finished.md`: archive the completed compatibility port and host
  `2999` cutover once ShinyiPilot has accepted those as product history.

## Milestones

### M1: Record Ownership Decision

Status: complete in this plan.

Done when:

- The transition ownership model is recorded in `docs/`.
- Active todo items point to this plan.
- Production LINE lab docs identify the overlay as temporary.

### M2: Port Minimal ShinyiPilot Compatibility

Status: complete.

Done when:

- The accepted `session.py` and `factory.py` behavior is ported or
  cherry-picked into `~/code/shinyipilot`.
- ShinyiPilot unit tests cover the Codex adapter runtime selection and SDK
  `ToolInvocation` normalization.
- No `.env`, route config, DB, runtime asset, or production data file is
  modified by the port.

### M3: Make Production Runner No-Overlay By Default

Status: complete.

Done when:

- `run-production-line.sh` builds from `~/code/shinyipilot` as-is by default.
- The runner fails fast if the real ShinyiPilot source lacks required
  compatibility behavior.
- Overlay requires an explicit debug flag and writes source-mode evidence into
  artifacts.
- Cutover mode refuses overlay-enabled builds.

### M4: Produce No-Overlay Shadow Proof

Status: complete.

Done when:

- Production-line shadow mode passes with source mode recorded as no overlay.
- Startup backup passes immediately before the container starts.
- Synthetic LINE webhook proof includes health, route policy, source-message
  capture, route identity registry update, ShinyiPilot log evidence, and
  adapter evidence.
- Host `2999`, `4800`, `4801`, and `4811` remain untouched.

### M5: Prepare Host 2999 Cutover And Backout

Status: complete.

Done when:

- The checklist references the latest no-overlay shadow proof.
- The old host-local `2999` service stop path is explicit and does not edit,
  delete, or migrate its data.
- Docker cutover publishes only `127.0.0.1:2999 -> container:29999`.
- Backout preserves persistent `/runtime` and defines when restore from backup
  is allowed.
- The executed cutover record captures the running container, cutover artifact,
  startup backup, source mode, host health, LINE canary evidence, and model
  policy fix.

### M6: Move Accepted Deployment Ownership To ShinyiPilot

Done when:

- ShinyiPilot owns its Docker/deploy/config/DB/backup docs and concrete
  deployment files.
- ShinyiPilot owns the canonical controller/handoff docs required to continue
  the work from `/Users/rickwen/code/shinyipilot` without reading this SDK
  branch first.
- ShinyiPilot defines the final DB/runtime path, migration/cutover from
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, NAS backup
  cadence/retention, restore rules, and cleanup criteria for the transition
  copy.
- ShinyiPilot image builds from `/Users/rickwen/code/shinyipilot` and consumes
  the pinned `copilot-sdk` adapter package/source, without depending on
  `shinyipilot-spike/` or parent-repo transition overlay.
- The detailed dry-run decisions are recorded in
  [runtime-backup-dry-run/plan.md](./runtime-backup-dry-run/plan.md), not only
  in session context.
- `copilot-sdk` retains only adapter implementation/package, adapter-level
  integration tests, semantic observability parity, and historical transition
  evidence.
- The `copilot-sdk` production-line lab is marked as historical or transition
  evidence instead of the app deployment source of truth.
- ShinyiPilot `docs/todo.md` contains the active product todos, and
  `copilot-sdk/docs/todo.md` keeps only adapter-level follow-ups or an explicit
  pointer that production ownership has moved.

### M7: Retire Or Preserve The Transition Runtime Copy

Done when:

- The service has run stably on the ShinyiPilot-owned DB/runtime layout.
- NAS backup and restore evidence exists for the ShinyiPilot-owned layout.
- A separate cleanup decision says whether to delete, archive, or keep
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`.
- No cleanup uses destructive sync or directory delete without an explicit
  inventory and approval.

## Current Evidence

- ShinyiPilot compatibility commit:
  `0946d0b feat: support codex adapter runtime backend`
- ShinyiPilot model default commit:
  `0dc74d4 chore: default route models to codex compatible model`
- Production-line shadow runner commit:
  `65b04dd test: add shinyipilot production line shadow runner`
- Latest pre-cutover shadow artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0950-production-line-shadow`
- Latest startup backup:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0958-production-line-startup`
- Executed cutover artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0958-production-line-cutover`
- Current transition runtime:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`
- Current source mode:
  `real-shinyipilot-source-no-overlay`
- Current host ownership:
  Docker container `shinyipilot-codex-line-cutover-20260615-0958` owns
  `127.0.0.1:2999 -> container:29999`.

## Non-Goals

- Do not move all ShinyiPilot deployment ownership into `copilot-sdk`.
- Do not merge the entire `shinyipilot-spike` worktree into `~/code/shinyipilot`.
- Do not move ShinyiPilot real config, `.env`, DB files, or runtime assets into
  this repo.
- Do not repeat cutover, backout, or transition-runtime cleanup without an
  explicit operational decision.

## Open Decisions

- How the Codex adapter is version-pinned when ShinyiPilot owns the final Docker
  deployment.
- Whether long-running production auth uses a controlled writable Codex state
  volume, an API-key/service-account lane, or another explicit mechanism.
- The exact NAS sync cadence, retention, and restore drill for
  `/Volumes/home/backup`.
- The final ShinyiPilot-owned migration timing.
