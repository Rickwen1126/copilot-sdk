# ShinyiPilot Production-Line Code Surface Inventory

Created: 2026-06-15 19:42
Last Updated: 2026-06-15 19:42
Status: Active inventory for handoff sequencing step 1

## Purpose

This inventory completes the first handoff step: locate and classify every code
or state surface involved in the ShinyiPilot Codex production-line deployment.

The next step is not cleanup. The next step is to use this inventory plus the
backup dry-run evidence to run the formal ShinyiPilot-owned production pass.

## Classification Labels

| Label | Meaning |
| --- | --- |
| `copilot-sdk remains owner` | The surface is adapter/runtime infrastructure and should stay in this repository after handoff. |
| `port/recreate in shinyipilot` | The surface is currently a transition prototype here, but the final production version belongs in `/Users/rickwen/code/shinyipilot`. |
| `shinyipilot remains owner` | The surface already belongs in ShinyiPilot and should stay there. |
| `runtime state` | The surface is mutable production-like state, not git source and not image state. |
| `NAS backup` | The surface is off-host backup/restore evidence, not the live source of truth. |
| `transition evidence` | The surface should remain as historical proof, but should not be the final production operating path. |
| `cleanup candidate` | The surface may be archived, stopped, removed, or retired only after the formal handoff and explicit cleanup approval. |

## Current Production-Like State

| Surface | Current path or object | Classification | Final owner / action | Notes |
| --- | --- | --- | --- | --- |
| Active host `2999` container | `shinyipilot-codex-line-cutover-20260615-1813-adapter-path` | `runtime state` | Keep running until a separate migration/cutover decision. | Publishes `127.0.0.1:2999->29999/tcp`; current production-like LINE experiment. |
| Stopped cutover containers | `shinyipilot-codex-line-cutover-20260615-0958`, `shinyipilot-codex-line-cutover-20260615-0952` | `cleanup candidate` | Retain until formal handoff and cleanup approval. | Do not delete during code classification. |
| Lab containers | `shinyipilot-codex-lab`, `shinyipilot-codex-lab-redacted` | `cleanup candidate` | Stop/remove only when not needed and explicitly approved. | They are not host `2999`; they are transition lab infrastructure. |
| Transition runtime | `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` | `runtime state` | Migration source for future `/Users/rickwen/.local/state/shinyipilot/production/runtime`. | Contains production-like SQLite DBs, file assets, session contexts, Codex runtime session store, and workspaces. |
| Transition local backups/artifacts | `/Users/rickwen/.local/state/shinyipilot-codex-line/backups`, `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts` | `transition evidence` | Keep as evidence until ShinyiPilot-owned backup/artifact roots exist. | Latest live snapshot: `20260615-183041-transition-runtime-live-snapshot`. |
| Transition NAS backup | `/Volumes/home/backup/shinyipilot-codex-line/runtime-backups/20260615-183041-transition-runtime-live-snapshot` | `NAS backup` | Preserve. Future root should become `/Volumes/home/backup/shinyipilot/production/runtime-backups`. | Verified by Item 3 of the dry-run plan. |
| File-level restore candidate | `/tmp/shinyipilot-runtime-restore-rehearsal-20260615-183041` | `transition evidence` | Temp evidence only; do not promote without migration decision. | Verified by Item 4. |
| Service-level restore rehearsal | `/tmp/shinyipilot-final-layout-rehearsal-20260615-183041` | `transition evidence` | Temp evidence only; maps to future production layout. | Verified by Item 4b; no host port published. |

## ShinyiPilot App Source And Config

| Surface | Current path | Classification | Final owner / action | Notes |
| --- | --- | --- | --- | --- |
| App source used by production image | `/Users/rickwen/code/shinyipilot/src` | `shinyipilot remains owner` | Build final image from this repo. | Current no-overlay runner copies this source into a temp build context. |
| Runtime backend selection | `/Users/rickwen/code/shinyipilot/src/chatpilot/sdk/session.py` | `shinyipilot remains owner` | Keep in ShinyiPilot. | Commit `0946d0b` added `CHATPILOT_RUNTIME_BACKEND=codex-adapter` and `CHATPILOT_COPILOT_CLI_URL` support. |
| SDK tool invocation normalization | `/Users/rickwen/code/shinyipilot/src/chatpilot/tools/factory.py` | `shinyipilot remains owner` | Keep in ShinyiPilot. | Commit `0946d0b` added SDK invocation object normalization and log proof compatibility. |
| Runtime DB/config env support | `/Users/rickwen/code/shinyipilot/src/chatpilot/server/__init__.py` | `shinyipilot remains owner` | Keep in ShinyiPilot; use existing env contract in final deploy. | Supports `CHATPILOT_DB`, `CHATPILOT_TASK_DB`, `CHATPILOT_FILES_DB`, `CHATPILOT_FILE_ASSETS_DIR`, `ROUTE_SETTINGS_PATH`, and `ROUTE_BINDINGS_PATH`. |
| Real route config | `/Users/rickwen/code/shinyipilot/config/route_settings.yaml`, `/Users/rickwen/code/shinyipilot/config/route_bindings.yaml` | `shinyipilot remains owner` | Mount read-only into final container. | Files are gitignored product config. Do not copy into image or docs. |
| Config examples | `/Users/rickwen/code/shinyipilot/config/route_settings.example.yaml`, `/Users/rickwen/code/shinyipilot/config/route_bindings.example.yaml` | `shinyipilot remains owner` | Keep tracked examples in ShinyiPilot. | Commit `0dc74d4` sets Codex-compatible default model to `gpt-5.4-mini`. |
| Secrets env file | `/Users/rickwen/code/shinyipilot/.env` | `shinyipilot remains owner` | Final ShinyiPilot runbook defines secret source; never commit. | Present locally and gitignored. |
| Local development runtime | `/Users/rickwen/code/shinyipilot/data`, `/Users/rickwen/code/shinyipilot/log` | `runtime state` | Keep as ShinyiPilot local dev state; do not confuse with final production runtime. | Gitignored. Production should use external host state, not repo `data/`. |
| ShinyiPilot docs source | `/Users/rickwen/code/shinyipilot/docs/spec.md`, `/Users/rickwen/code/shinyipilot/docs/todo.md`, `/Users/rickwen/code/shinyipilot/docs/todo-finished.md` | `shinyipilot remains owner` | Add production Codex handoff pack there in a later step. | Current docs do not yet describe the Codex production-line deployment. |
| ShinyiPilot production handoff topic | `/Users/rickwen/code/shinyipilot/docs/codex-line-production/` | `port/recreate in shinyipilot` | Create during teaching/handoff docs step. | Should contain spec, plan, backup evidence, deploy/runbook, and active todo links. |
| ShinyiPilot Docker/deploy files | likely `/Users/rickwen/code/shinyipilot/docker/codex-line/` plus run/deploy scripts | `port/recreate in shinyipilot` | Create before formal production ownership. | No existing ShinyiPilot Dockerfile/deploy surface was found in the scan. |

## Copilot SDK Adapter Surfaces

| Surface | Current path | Classification | Final owner / action | Notes |
| --- | --- | --- | --- | --- |
| Python Codex adapter package | `/Users/rickwen/code/copilot-sdk/python/copilot/codex_adapter/` | `copilot-sdk remains owner` | Keep here. ShinyiPilot consumes a pinned package/source. | New import path for production docs and future code. |
| Legacy Python adapter wrappers | `/Users/rickwen/code/copilot-sdk/python/copilot/experimental/codex_adapter/` | `copilot-sdk remains owner` | Keep temporarily as compatibility shim. | Do not teach new ShinyiPilot code to import this path. |
| Python adapter console script | `/Users/rickwen/code/copilot-sdk/python/pyproject.toml` | `copilot-sdk remains owner` | Keep here. | Provides `copilot-codex-adapter = "copilot.codex_adapter.cli:main"`. |
| Python adapter tests | `python/test_codex_adapter_*.py` | `copilot-sdk remains owner` | Keep here. | Adapter conformance/regression, not ShinyiPilot product deployment tests. |
| Node experimental adapter | `nodejs/src/experimental/codex*.ts` | `copilot-sdk remains owner` | Keep here. | Still relevant for Node parity and semantic observability follow-up, not a ShinyiPilot deployment surface. |

## Transition Docker And Backup Surfaces

| Surface | Current path | Classification | Final owner / action | Notes |
| --- | --- | --- | --- | --- |
| Production-line Dockerfile | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/Dockerfile` | `port/recreate in shinyipilot` | Port image shape into ShinyiPilot-owned Dockerfile. | Must preserve app source install, adapter install, `uv`, Codex CLI, and secret/runtime exclusion rules. |
| Production-line entrypoint | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-production-line.sh` | `port/recreate in shinyipilot` | Port into ShinyiPilot-owned entrypoint. | Final version should remove parent-specific overlay fallback and use internal app `PORT=2999`. |
| Production-line runner | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh` | `port/recreate in shinyipilot` | Recreate as ShinyiPilot-owned run/deploy script. | Current transition runner builds from real ShinyiPilot source and no-overlay by default; final host mapping should be `127.0.0.1:2999 -> container:2999`. |
| Runtime backup helper | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-runtime-backup.py` | `port/recreate in shinyipilot` | Port behavior into ShinyiPilot backup/restore helper. | Must keep live read-only snapshot mode, manifest, integrity, hash, row-count, and allowlisted assets. |
| LINE shadow preflight | `container-line-shadow-preflight.py` | `transition evidence` | Keep here as evidence; port only if ShinyiPilot wants an equivalent shadow proof. | Synthetic webhook proof, not the final backup/deploy runner. |
| Host cutover checklist | `host-2999-cutover-checklist.md` | `transition evidence` | Rewrite relevant operational rules into ShinyiPilot runbook. | Do not make this parent file the future production runbook. |
| Production lab docs | `production-line-lab.md`, `shinyipilot-docker-smoke/README.md` | `transition evidence` | Rewrite relevant parts into ShinyiPilot docs. | Useful evidence, but not final operator docs. |
| Docker smoke/lab/sweep scripts | `run-smoke.sh`, `run-lab.sh`, `run-sweep.sh`, `container-smoke.sh`, `container-behavior-sweep.py` | `copilot-sdk remains owner` with follow-up | Keep adapter-level E2E in `copilot-sdk`, but remove production dependence on `shinyipilot-spike`. | Current smoke/sweep/lab scripts still build from `shinyipilot-spike`; they are adapter E2E, not production deployment. Decide whether to move them to real ShinyiPilot source or a dedicated fixture app before cleanup. |
| `shinyipilot-spike/` nested worktree | `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/` | `cleanup candidate` / `transition evidence` | Do not use as production source. Retain until adapter E2E no longer depends on it and cleanup is approved. | Parent git cannot own it as normal source. |

## Documentation Surfaces

| Surface | Current path | Classification | Final owner / action | Notes |
| --- | --- | --- | --- | --- |
| Transition ownership plan | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md` | `transition evidence` | Keep here; rewrite accepted decisions into ShinyiPilot docs. | This file remains the current source until ShinyiPilot docs are created. |
| Runtime backup dry-run plan | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/runtime-backup-dry-run/plan.md` | `transition evidence` | Copy/rewrite evidence ledger into ShinyiPilot handoff pack. | Items 1-4b passed; Items 5-7 specify migration/cleanup rules. |
| Production runbook | `docs/integrations/codex-sdk-runtime-profile/production-runbook.md` | `transition evidence` | Extract ShinyiPilot-relevant runbook content into ShinyiPilot docs. | Parent runbook should not be the final ShinyiPilot production operator entrypoint. |
| Parent active todo/spec | `docs/todo.md`, `docs/spec.md` | `transition evidence` | Keep SDK context here; mirror accepted product-operation context into ShinyiPilot. | Future ShinyiPilot work should start from its own docs. |
| Session continuity | `.progress/progress.md` | `transition evidence` | Keep as session continuity only. | Do not rely on it as ShinyiPilot handoff source. |

## Blocking Findings Before Formal Production Run

1. ShinyiPilot does not yet own a Docker/deploy/backup code path.
   - Create or port a ShinyiPilot-owned Dockerfile, entrypoint, deploy/run
     script, and backup/restore helper before the formal ShinyiPilot-owned
     production pass.
2. ShinyiPilot docs do not yet contain the production Codex handoff pack.
   - Create `docs/codex-line-production/` or an equivalent topic pack before
     cleanup.
3. `copilot-sdk` smoke/sweep/lab scripts still depend on `shinyipilot-spike/`.
   - This is acceptable for historical adapter E2E, but it is not acceptable as
     production source. Before cleanup, either move those E2E lanes to real
     ShinyiPilot source or replace the app dependency with a dedicated fixture.
4. Adapter acquisition mode is not finalized for ShinyiPilot production.
   - Choose local rehearsal copy, pinned wheel/source artifact, or pinned git
     dependency. Production should prefer a pinned artifact or git ref.
5. Final Codex auth persistence strategy is still open.
   - The transition lane uses read-only host auth copied into a container-local
     clean home. Long-running production must define where refresh/session state
     may be written or how it is discarded.

## Next Action

Use this inventory to create the ShinyiPilot-owned deployment surfaces. The
formal production pass should not invent new paths, ports, DB names, mount
semantics, or backup behavior that do not appear in the dry-run plan.
