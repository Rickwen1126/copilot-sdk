# ShinyiPilot Runtime Backup Dry-Run Plan

Created: 2026-06-15 13:54
Last Updated: 2026-06-15 17:17
Status: Active; dry-run list specified, Item 1 complete

## Purpose

This plan turns the ShinyiPilot DB/runtime ownership decision into a repeatable
dry-run list. The goal is to avoid using session memory as the source of truth
for production-like DB, backup, restore, migration, or cleanup decisions.

The current transition runtime is:

```text
/Users/rickwen/.local/state/shinyipilot-codex-line/runtime
```

The future final repo owner is `~/code/shinyipilot`, through a
ShinyiPilot-owned Docker/deploy/config/DB runtime layout and runbook. The
future final physical runtime path is still outside the git worktree under
`/Users/rickwen/.local/state/shinyipilot/production/runtime`. Until that
handoff is stable, this dry-run plan is the operational evidence ledger for the
transition runtime.

## Source References

- Active todo: [docs/todo.md](../../../../todo.md#p1-shinyipilot-deployment-ownership-transition-2026-06-15-0932)
- Ownership transition: [../plan.md](../plan.md)
- Production runbook: [../../production-runbook.md](../../production-runbook.md)
- Host 2999 cutover checklist: [../../shinyipilot-docker-smoke/host-2999-cutover-checklist.md](../../shinyipilot-docker-smoke/host-2999-cutover-checklist.md)
- Backup helper: [../../shinyipilot-docker-smoke/production-runtime-backup.py](../../shinyipilot-docker-smoke/production-runtime-backup.py)
- Production runner: [../../shinyipilot-docker-smoke/run-production-line.sh](../../shinyipilot-docker-smoke/run-production-line.sh)

## Hard Constraints

- Do not stop, restart, or replace the running host `2999` cutover container
  during these dry runs.
- Do not touch reserved ports `4800`, `4801`, or `4811`.
- Do not mutate the production-like SQLite DBs during inventory or restore
  rehearsal.
- Do not run LINE canaries as part of backup or restore proof unless a later
  item explicitly decides to include one.
- Do not use destructive sync or delete semantics for NAS backup.
- Do not restore over the live transition runtime without a separate restore
  decision.
- Do not clean up
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` until final
  ShinyiPilot ownership, backup/restore evidence, stable runtime behavior, and a
  separate cleanup approval all exist.

## Dry-Run To Production Path Mapping

The dry-run paths are deliberately shaped so that a successful rehearsal can be
compared directly with the future ShinyiPilot-owned deployment. The dry run is
not a second design; it is a staging version of the same data movement.

| Role | Dry-run path | Future ShinyiPilot-owned path | Equivalence rule |
| --- | --- | --- | --- |
| Deployment repo owner | This `copilot-sdk` branch documents and runs the transition lane | `/Users/rickwen/code/shinyipilot` owns product deployment docs/scripts | Final production operation should be driven from ShinyiPilot, not from the parent transition runner. |
| App image source path | `/Users/rickwen/code/shinyipilot` copied by `run-production-line.sh` into a temp build context | `/Users/rickwen/code/shinyipilot` as the Docker build source | Same app source. The production image must not depend on `/Users/rickwen/code/copilot-sdk/shinyipilot-spike`. |
| Adapter source/package path | `/Users/rickwen/code/copilot-sdk/python/copilot/experimental/codex_adapter` copied into the image as editable `/workspace/python` | A pinned `copilot-sdk` adapter package/source consumed by the ShinyiPilot image build | Same adapter API contract. Final deployment decides the pin method; ShinyiPilot owns only the consumption point. |
| Dockerfile source | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/Dockerfile` | A ShinyiPilot-owned Dockerfile, for example `/Users/rickwen/code/shinyipilot/docker/codex-line/Dockerfile` | Port the image shape into ShinyiPilot before final handoff. The parent Dockerfile becomes transition evidence. |
| Container entrypoint source | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/container-production-line.sh` | A ShinyiPilot-owned entrypoint/run script, for example `/Users/rickwen/code/shinyipilot/docker/codex-line/entrypoint.sh` | Preserve env, `/runtime`, Codex home, adapter startup, and app startup semantics; remove parent-specific overlay fallback. |
| Backup helper source | `docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-runtime-backup.py` | A ShinyiPilot-owned backup/restore helper or deploy script | Same manifest/integrity/hash behavior. Add live read-only snapshot mode before recurring use. |
| Product route config | `/Users/rickwen/code/shinyipilot/config/route_settings.yaml` and `route_bindings.yaml`, mounted read-only to `/host-config/*` | Same ShinyiPilot-owned config files, or a ShinyiPilot-defined production config source | Config is product state. It is mounted/read by Docker and never copied into the image. |
| Env/secrets | `/Users/rickwen/code/shinyipilot/.env` as an optional env file | ShinyiPilot-defined secret source | Secrets never enter git, build context, Docker image layers, or artifacts. |
| Codex working repo | `/Users/rickwen/code/copilot-sdk` is currently the controller workspace for transition docs, runner, dry-run plan, and handoff | `/Users/rickwen/code/shinyipilot` becomes the primary Codex working repo for production ShinyiPilot operation | Future sessions should be able to start in ShinyiPilot, read its docs, and operate/debug/deploy without first loading this SDK branch. |
| Handoff docs | `copilot-sdk` transition docs plus `.progress/progress.md` updates | ShinyiPilot canonical docs, active todo, completed archive, and deployment topic docs | Port the decisions and evidence ledger, not the raw session log. `.progress` remains continuity only. |
| Current live source runtime | `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` | `/Users/rickwen/.local/state/shinyipilot/production/runtime` | Current transition source becomes the migration source. Future production runtime has the same DB and asset contract, but lives under ShinyiPilot-owned state. |
| Local backup bundle | `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/<timestamp>-transition-runtime-live-snapshot` | `/Users/rickwen/.local/state/shinyipilot/production/backups/<timestamp>-production-runtime-live-snapshot` | Same manifest schema, DB hashes, row counts, and asset allowlist. Only owner/root/name changes after final deployment. |
| NAS backup bundle | `/Volumes/home/backup/shinyipilot-codex-line/runtime-backups/<timestamp>-transition-runtime-live-snapshot` | `/Volumes/home/backup/shinyipilot/production/runtime-backups/<timestamp>-production-runtime-live-snapshot` | Same off-host copy semantics: target directory must not already exist, no delete semantics, manifest and DB hashes must verify after copy. |
| File-level restore rehearsal | `/tmp/shinyipilot-runtime-restore-rehearsal-<timestamp>` | A temporary restore candidate before copying into `/Users/rickwen/.local/state/shinyipilot/production/runtime` | Proves the backup can be copied back and read. It is not mounted into production and is never the live runtime. |
| Service-level restore rehearsal runtime | `/tmp/shinyipilot-final-layout-rehearsal-<timestamp>/production/runtime` | `/Users/rickwen/.local/state/shinyipilot/production/runtime` | Same directory shape and app env contract as final production: mounted as `/runtime`, with `CHATPILOT_DB=/runtime/chatpilot.db`, `CHATPILOT_TASK_DB=/runtime/tasks.db`, `CHATPILOT_FILES_DB=/runtime/files.db`, and `CHATPILOT_FILE_ASSETS_DIR=/runtime/file_assets`. |
| Service-level rehearsal app port | container app `PORT=2999`, no host `2999` publish | host `127.0.0.1:2999 -> container:2999`, app `PORT=2999` | Container-internal app port matches final deployment. Dry run proves app behavior without taking host `2999`; final cutover publishes the same container port to host `2999`. |
| Final migration target | not written during dry run | `/Users/rickwen/.local/state/shinyipilot/production/runtime` | Created only during the approved migration. Dry-run success means this path should receive the same verified backup contents that passed file-level and service-level rehearsal. |

Promotion rule:

- If file-level restore and service-level restore both pass, the actual
  migration should copy the verified backup contents into the future production
  path and then compare the same manifest fields: DB integrity, DB hashes before
  first live write, row counts, asset allowlist, app `/health`, runtime env, and
  port mapping.
- If Docker source ownership is being promoted at the same time, the promoted
  ShinyiPilot Dockerfile/entrypoint must be compared against the transition
  Dockerfile/entrypoint for these contracts: app source path, adapter package
  install, `/runtime` mount, route config mount, secret exclusion, Codex clean
  home, `CHATPILOT_RUNTIME_BACKEND=codex-adapter`, app `PORT=2999`, and
  no-overlay source mode.
- The promoted ShinyiPilot image must record its adapter source: local rehearsal
  checkout path, wheel/source artifact, or git SHA. A container proof must show
  `copilot-codex-adapter` is installed and that runtime env selects protocol v2,
  `gpt-5.4-mini`, the `/runtime` session store, and the documented approval /
  sandbox / network policy.
- If Codex working-repo ownership is being promoted at the same time, the
  ShinyiPilot docs pack must be compared against this plan for these contracts:
  live state path, future state path, NAS path, Docker source path, config
  ownership, backup/restore sequence, host `2999` rule, cleanup guard, and open
  todos. Missing docs are a handoff failure even if the container starts.
- If any field differs, stop and explain the difference before proceeding.
  Production migration should not invent a new path, port, DB name, or backup
  semantics that did not appear in the dry run.

## Dry-Run List

### Item 1: Read-Only Inventory Baseline

Status: complete at 2026-06-15 13:56 CST.

Decision:

- Run a full read-only inventory before any backup, restore, migration, or
  cleanup design step.
- The inventory records facts, not intent: container, port owner, health,
  runtime files, DB integrity, row counts, artifacts, backup manifests, NAS
  mount status, and repo commits.
- This item must produce zero writes, zero DB mutations, zero LINE canaries, and
  zero service lifecycle changes.

Commands to run:

- `docker ps --filter name=shinyipilot-codex-line-cutover-20260615-0958 --format ...`
- `lsof -nP -iTCP:2999 -sTCP:LISTEN`
- `curl -fsS http://127.0.0.1:2999/health`
- `find /Users/rickwen/.local/state/shinyipilot-codex-line/runtime -maxdepth 2 ...`
- `sqlite3 'file:/Users/rickwen/.local/state/shinyipilot-codex-line/runtime/chatpilot.db?mode=ro' ...`
- `sqlite3 'file:/Users/rickwen/.local/state/shinyipilot-codex-line/runtime/tasks.db?mode=ro' ...`
- `sqlite3 'file:/Users/rickwen/.local/state/shinyipilot-codex-line/runtime/files.db?mode=ro' ...`
- `test -r` checks for cutover artifact, latest pre-cutover shadow artifact, and
  latest startup backup manifest.
- `test -d /Volumes/home/backup` and read-only mount visibility checks.
- `git -C /Users/rickwen/code/copilot-sdk log -1 --oneline`
- `git -C /Users/rickwen/code/shinyipilot log -1 --oneline`

Pass criteria:

- The expected cutover container is running and owns host `127.0.0.1:2999`.
- `/health` returns a healthy JSON payload.
- The transition runtime directory exists and includes `chatpilot.db`,
  `tasks.db`, and `files.db`.
- All three SQLite DBs pass `PRAGMA integrity_check` in read-only mode.
- Row-count evidence is captured for important tables that exist.
- Cutover artifact, pre-cutover shadow artifact, and startup backup manifest are
  readable.
- `/Volumes/home/backup` is visible without writing to it.
- Repo commit evidence is captured for both `copilot-sdk` and `shinyipilot`.

Result:

- PASS.

Evidence snapshot at 2026-06-15 13:55 CST:

- Container:
  `shinyipilot-codex-line-cutover-20260615-0958` was running for about 3 hours
  and published `127.0.0.1:2999->29999/tcp`.
- Port owner:
  `lsof -nP -iTCP:2999 -sTCP:LISTEN` showed Docker process `com.docke`
  listening on `127.0.0.1:2999`.
- Health:
  `curl -fsS http://127.0.0.1:2999/health` returned
  `{"status":"ok","version":"0.2.0","uptime_seconds":11655}`.
- Runtime directory:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` exists and was
  about `11708 KiB`. It contains `chatpilot.db`, `tasks.db`, `files.db`,
  matching WAL/SHM sidecars, `codex-runtime-sessions.json`,
  `codex-workspaces/`, `file_assets/`, route label/map files,
  `session_contexts/`, `unit_images.json`, and `workspace/`.
- SQLite integrity:
  `chatpilot.db`, `tasks.db`, and `files.db` all returned `ok` from
  `PRAGMA integrity_check` through `file:...?mode=ro`.
- `chatpilot.db` row counts:
  `line_identity_registry=69`, `memory_custom_prompts=0`,
  `memory_memos=0`, `memory_observations=336`, `memory_reminders=0`,
  `memory_schedules=0`, `observation_entries=879`,
  `procurement_context_events=113`, `procurement_context_memory=31`,
  `procurement_contexts=30`, `procurement_event_sources=80`,
  `source_message_batches=433`, `source_messages=981`,
  `trigger_keywords=0`.
- `source_messages` range:
  oldest `2026-05-08T08:25:15.196213+00:00`, newest
  `2026-06-15T03:47:42.875520+00:00`, with `24` rows after
  `2026-06-15T02:48:00`.
- `tasks.db` row counts:
  `tasks=0`.
- `files.db` row counts:
  `file_assets=745`, `file_notes=0`, `file_relations=0`.
- Cutover artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0958-production-line-cutover`
  exists. `production-line-ready.json` records `status=ready`,
  `mode=cutover`, `model=gpt-5.4-mini`, `appBindHost=0.0.0.0`,
  `containerAppUrl=http://127.0.0.1:29999`, `adapterUrl=127.0.0.1:4873`,
  and `readyAt=2026-06-15T02:41:45.380947+00:00`.
- Source mode:
  the cutover `source-overlay-manifest.json` records `status=not_applied`,
  `sourceMode=real-shinyipilot-source-no-overlay`, and
  `shinyipilotSource=/Users/rickwen/code/shinyipilot`.
- Pre-cutover shadow artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0950-production-line-shadow`
  exists. `line-shadow-preflight-result.json` records `status=pass`,
  `runtimeBackend=codex-adapter`, and `model=gpt-5.4-mini`.
- Startup backup manifest:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0958-production-line-startup/manifest.json`
  records `status=pass`, `runnerVersion=production-line-backup-v1`,
  `runtimeDir=/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`,
  and `backupDir=/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0958-production-line-startup`.
  The manifest records `integrityCheck=ok` for `chatpilot.db`, `tasks.db`,
  and `files.db`.
- Startup backup DB hashes:
  `chatpilot.db=26890252c0141db4cd11943f2663c4a388ccb4106e1fb7e32df5d517b522ed88`,
  `tasks.db=3000c371de83fab3d17e8d252149a81d5ea6a471dbf0273e32191dad239f3603`,
  `files.db=b254aa746b9ccb436fe191401feb1af7958a23f8d706e3c8c7e98d70ded706b7`.
- NAS visibility:
  `/Volumes/home/backup` exists and is readable as an SMB mount under
  `/Volumes/home`, with about `1.7Ti` total and `749Gi` available.
- Source commits:
  `copilot-sdk` HEAD was `b71144c docs: clarify shinyipilot db ownership route`;
  `shinyipilot` HEAD was
  `0dc74d4 chore: default route models to codex compatible model`.
- Repo status:
  `shinyipilot` was clean. `copilot-sdk` had this dry-run documentation work in
  progress plus existing untracked `code-trace/` and `shinyipilot-spike/`.

No writes were made to the runtime DBs. No LINE canary was sent. The running
container was not stopped, restarted, or replaced. Reserved ports `4800`,
`4801`, and `4811` were not touched.

### Item 2: Local SQLite-Aware Backup Snapshot Dry Run

Status: specified; not executed.

Decision:

- Do not run the current `production-runtime-backup.py` unchanged against the
  live transition runtime and call it read-only. That helper currently performs
  `PRAGMA wal_checkpoint(FULL)` before using the SQLite backup API. It is valid
  for startup backups, but it is not a pure read-only live inventory/snapshot
  operation.
- Add or use a live-snapshot mode before executing this item. That mode opens
  source DBs through `file:...?mode=ro`, uses SQLite's backup API without an
  explicit WAL checkpoint by default, records WAL/SHM sidecar existence/size,
  and writes only to a new backup directory.
- The local backup name should be distinct from startup backups:
  `<timestamp>-transition-runtime-live-snapshot`.
- The local backup root stays under the current transition state root until the
  final ShinyiPilot-owned layout is decided:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups`.
- The backup helper should keep the same DB and asset allowlist as
  `production-runtime-backup.py` unless Item 1 evidence shows a missing required
  runtime asset.

Required command shape:

```sh
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
python3 docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-runtime-backup.py \
  --runtime-dir /Users/rickwen/.local/state/shinyipilot-codex-line/runtime \
  --backup-root /Users/rickwen/.local/state/shinyipilot-codex-line/backups \
  --backup-name "${TIMESTAMP}-transition-runtime-live-snapshot" \
  --live-readonly-snapshot
```

Implementation note:

- `--live-readonly-snapshot` does not exist yet. Add it before running this
  command against the live transition runtime.
- The existing startup path should keep its current behavior unless deliberately
  changed and re-tested.

Minimum evidence:

- New backup directory name.
- Source runtime path.
- DB integrity result.
- DB hashes and sizes.
- Row-count summary.
- Asset allowlist summary.
- Confirmation that Codex auth homes, caches, `.env`, and other secret-bearing
  state are excluded.
- Manifest fields:
  `snapshotMode=live-readonly-snapshot`, `sourceWasLive=true`,
  `walCheckpoint=not-requested`, `runtimeDir`, `backupDir`,
  `createdAt`, DB `integrityCheck`, DB `backupSha256`, and table row counts.

Pass criteria:

- New backup directory did not exist before the run.
- All three DB backups pass `PRAGMA integrity_check`.
- Manifest row counts match the live inventory baseline unless new production
  traffic arrived between Item 1 and the snapshot; if counts changed, record the
  delta explicitly.
- No write is made to `/Volumes/home/backup` in this item.
- No restore is attempted in this item.
- No LINE canary is sent in this item.

### Item 3: NAS Sync Dry Run

Status: specified; not executed. Do not run until Item 2 proves a local
snapshot.

Decision:

- NAS destination root:
  `/Volumes/home/backup/shinyipilot-codex-line/runtime-backups`.
- Copy one complete local backup directory from Item 2 into that root.
- Keep the same directory name on NAS, for example:
  `/Volumes/home/backup/shinyipilot-codex-line/runtime-backups/<timestamp>-transition-runtime-live-snapshot`.
- Do not use `rsync --delete`, destructive sync, or broad mirror semantics.
- Prefer a target-not-exists preflight plus `cp -a` for the first dry run. If a
  later periodic job uses `rsync`, it must be `rsync -a` without `--delete` and
  with an explicit target directory that does not overlap unrelated backups.
- Retention is not automated in this item. Record a later retention decision
  instead of deleting old NAS backups during the first dry run.

Minimum constraints:

- No delete semantics by default.
- No write into the live runtime.
- NAS copy must include manifest and enough hashes to verify content after copy.

Required command shape:

```sh
NAS_ROOT=/Volumes/home/backup/shinyipilot-codex-line/runtime-backups
LOCAL_BACKUP=/Users/rickwen/.local/state/shinyipilot-codex-line/backups/<timestamp>-transition-runtime-live-snapshot
test -d "${LOCAL_BACKUP}"
test ! -e "${NAS_ROOT}/$(basename "${LOCAL_BACKUP}")"
mkdir -p "${NAS_ROOT}"
cp -a "${LOCAL_BACKUP}" "${NAS_ROOT}/"
```

Pass criteria:

- NAS root exists and is on `/Volumes/home`.
- Target directory did not exist before copy.
- Copied manifest exists on NAS.
- DB files on NAS have the same SHA-256 values as the local backup manifest.
- SQLite integrity checks pass against the NAS copy in read-only mode.
- No source runtime file is modified.

### Item 4: Restore Rehearsal Dry Run

Status: specified; not executed. Do not run until Item 3 proves NAS copy.

Decision:

- Restore destination should be a temp or staging directory, never the live
  transition runtime.
- Validation compares integrity, DB hashes, row counts, and selected artifact
  manifest fields.
- The default restore rehearsal root should be under `/tmp`, for example:
  `/tmp/shinyipilot-runtime-restore-rehearsal-<timestamp>`.
- The rehearsal copies from the NAS backup into the temp restore root, then
  validates the copy. It does not start ShinyiPilot and does not mount the
  restored directory into a container.
- Item 4b service-level restore rehearsal can run only after this file-level
  restore proof passes.

Required command shape:

```sh
NAS_BACKUP=/Volumes/home/backup/shinyipilot-codex-line/runtime-backups/<timestamp>-transition-runtime-live-snapshot
RESTORE_ROOT=/tmp/shinyipilot-runtime-restore-rehearsal-<timestamp>
test -d "${NAS_BACKUP}"
test ! -e "${RESTORE_ROOT}"
cp -a "${NAS_BACKUP}" "${RESTORE_ROOT}"
sqlite3 "file:${RESTORE_ROOT}/chatpilot.db?mode=ro" "PRAGMA integrity_check;"
sqlite3 "file:${RESTORE_ROOT}/tasks.db?mode=ro" "PRAGMA integrity_check;"
sqlite3 "file:${RESTORE_ROOT}/files.db?mode=ro" "PRAGMA integrity_check;"
```

Pass criteria:

- Restore root did not exist before rehearsal.
- All restored DBs pass read-only integrity checks.
- Restored DB hashes match the manifest copied from NAS.
- Row counts match the local snapshot manifest.
- No production runtime path is used as restore destination.
- No service is started from the restored directory.

### Item 4b: Service-Level Restore Rehearsal

Status: specified; not executed. Do not run until Item 4 proves file-level
restore from NAS.

Decision:

- Use the restored backup to create a temp final-layout rehearsal directory, then
  run an isolated ShinyiPilot container against that temp runtime.
- The dry-run container must not publish host `2999`, must not touch Cloudflare
  tunnel config, and must not send real LINE webhook/canary traffic.
- Container-internal app port should be `2999` so the rehearsal matches the
  future final deployment shape. Health can be checked inside the container or
  through an explicitly chosen temporary host port after a free-port preflight.
  Do not use host `2999`, `4800`, `4801`, or `4811`.
- The rehearsal may exercise read-only app health, config loading, DB open,
  runtime env, and manifest row-count checks.
- If a write smoke is needed later, it must write only to the temp restored DB
  and must record cleanup/discard evidence. The default service-level rehearsal
  is read-only.

Dry-run directory shape:

```text
/tmp/shinyipilot-final-layout-rehearsal-<timestamp>/
  production/
    runtime/
      chatpilot.db
      tasks.db
      files.db
      file_assets/
      route_labels.json
      ...
    artifacts/
```

Required runtime env shape:

```sh
PORT=2999
CHATPILOT_DB=/runtime/chatpilot.db
CHATPILOT_TASK_DB=/runtime/tasks.db
CHATPILOT_FILES_DB=/runtime/files.db
CHATPILOT_FILE_ASSETS_DIR=/runtime/file_assets
ROUTE_SETTINGS_PATH=/host-config/route_settings.yaml
ROUTE_BINDINGS_PATH=/host-config/route_bindings.yaml
CHATPILOT_RUNTIME_BACKEND=codex-adapter
```

Minimum proof:

- Container starts with the temp runtime mounted as `/runtime`.
- App binds container port `2999`.
- `/health` returns `status=ok` from inside the isolated service.
- The app opens `chatpilot.db`, `tasks.db`, and `files.db` from `/runtime`.
- DB integrity and row counts in the temp runtime match the Item 4 restored
  manifest before any optional write smoke.
- Runtime env recorded in the rehearsal artifact matches the future final
  deployment env shape.
- No host `2999` listener changes during the rehearsal.
- No Cloudflare or LINE side effect occurs.

Pass criteria:

- File-level restore passed first.
- Service-level health and DB-open checks pass using the temp restored runtime.
- No production runtime path is modified.
- No host `2999` takeover happens.
- Rehearsal artifact states whether it used no host port or a temporary host
  port, and records the temp path that maps to the future production path.

### Item 5: Final ShinyiPilot Runtime Layout Decision

Status: specified; not executed.

Decision:

- Final ownership returns to `~/code/shinyipilot`, but the production physical
  DB/runtime files should not live inside the git worktree. `data/` is
  gitignored and remains a valid local-development default, but production
  should use a ShinyiPilot-owned host state directory referenced by ShinyiPilot
  deploy docs/scripts.
- Default final state root:
  `/Users/rickwen/.local/state/shinyipilot/production`.
- Default final runtime path:
  `/Users/rickwen/.local/state/shinyipilot/production/runtime`.
- Default final local backup path:
  `/Users/rickwen/.local/state/shinyipilot/production/backups`.
- Default final artifact/log path:
  `/Users/rickwen/.local/state/shinyipilot/production/artifacts`.
- Default final NAS backup path:
  `/Volumes/home/backup/shinyipilot/production/runtime-backups`.
- Docker should mount the final runtime path to the app as `/runtime`, then set
  the existing ShinyiPilot env vars:
  `CHATPILOT_DB=/runtime/chatpilot.db`,
  `CHATPILOT_TASK_DB=/runtime/tasks.db`,
  `CHATPILOT_FILES_DB=/runtime/files.db`,
  `CHATPILOT_FILE_ASSETS_DIR=/runtime/file_assets`.
- Final deployment should align the host and container app port:
  `127.0.0.1:2999 -> container:2999`, with ShinyiPilot app `PORT=2999`.
  The current transition mapping `127.0.0.1:2999 -> container:29999` remains
  accepted evidence and should not be changed just to make ports prettier,
  because changing it would require replacing the running cutover container.
- Route config remains ShinyiPilot-owned:
  `ROUTE_SETTINGS_PATH` and `ROUTE_BINDINGS_PATH` point at ShinyiPilot config
  files, with real local production config remaining untracked.
- Docker/deploy/config source ownership also returns to ShinyiPilot. The final
  image should build from `/Users/rickwen/code/shinyipilot`, install or copy a
  pinned `copilot-sdk` Codex adapter package, and mount external state/config at
  runtime. It should not copy `shinyipilot-spike/`, real `.env`, real
  `config/route_settings.yaml`, SQLite DBs, Codex auth state, or NAS backups
  into the build context.
- The final image build must choose and document one adapter acquisition mode:
  local rehearsal copy from `/Users/rickwen/code/copilot-sdk/python`, a pinned
  wheel/source artifact from a `copilot-sdk` commit, or a pinned git dependency.
  Production should prefer a pinned artifact or git ref over an unversioned
  sibling checkout.
- The current `copilot-sdk` Docker lane remains as transition evidence and
  adapter-level E2E. After handoff, it should not be the production run command
  for ShinyiPilot.

Evidence for this decision:

- ShinyiPilot `.gitignore` excludes `.env`, `config/route_settings.yaml`,
  `config/route_bindings.yaml`, `data/`, and `log/`.
- ShinyiPilot README documents SQLite defaults as `data/chatpilot.db` and
  `data/tasks.db`, and disk JSON route labels under `data/route_labels.json`.
- `src/chatpilot/server/__init__.py` already supports `CHATPILOT_DB`,
  `CHATPILOT_TASK_DB`, `CHATPILOT_FILES_DB`, `CHATPILOT_FILE_ASSETS_DIR`,
  `ROUTE_SETTINGS_PATH`, and `ROUTE_BINDINGS_PATH`.
- `SqliteMemoryStore`, `SqliteTaskStore`, and `SqliteFileStore` create parent
  directories and enable WAL mode.

ShinyiPilot deployment files to create or port before final handoff:

- ShinyiPilot-owned Dockerfile, for example
  `/Users/rickwen/code/shinyipilot/docker/codex-line/Dockerfile`.
- ShinyiPilot-owned container entrypoint/run script, for example
  `/Users/rickwen/code/shinyipilot/docker/codex-line/entrypoint.sh`.
- ShinyiPilot-owned deploy or run script that mounts
  `/Users/rickwen/.local/state/shinyipilot/production/runtime:/runtime`,
  mounts product config read-only, supplies secrets safely, and publishes
  `127.0.0.1:2999 -> container:2999`.
- ShinyiPilot-owned adapter build/install documentation that records the active
  `copilot-sdk` commit/artifact, the install command, and a container-level
  verification command for `copilot-codex-adapter`.
- ShinyiPilot-owned backup/restore helper or script with the manifest,
  integrity, hash, row-count, NAS-copy, and restore-rehearsal behavior proven in
  this plan.
- ShinyiPilot-owned production runbook documenting final path layout, migration
  from `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime`, NAS backup
  cadence/retention, restore rules, and transition-runtime cleanup criteria.
- ShinyiPilot-owned adapter capability/boundary handoff docs explaining which
  future changes belong in `~/code/copilot-sdk` and which belong in
  `~/code/shinyipilot`.

What should remain in `copilot-sdk` after handoff:

- `copilot.experimental.codex_adapter` implementation and packaging.
- Adapter protocol/conformance tests and semantic observability parity tests.
- Adapter-level Docker E2E that proves the adapter can run inside a generic app
  image boundary.
- Historical ShinyiPilot transition evidence and docs.

What should not remain as `copilot-sdk` responsibility after handoff:

- ShinyiPilot production Docker run command.
- ShinyiPilot real route config or `.env`.
- ShinyiPilot production DB/runtime files.
- ShinyiPilot NAS backup operations.
- ShinyiPilot Cloudflare/host `2999` operational runbook.
- ShinyiPilot production handoff/controller docs required for future Codex
  sessions to continue from `/Users/rickwen/code/shinyipilot`.

### Item 6: Migration And Cutover Rehearsal

Status: specified; not executed.

Decision:

- How to copy from the current transition runtime to the final ShinyiPilot-owned
  runtime layout.
- Whether the live container must be stopped for the actual migration.
- What read-only proof can be run before any service lifecycle change.
- What rollback means if the final layout fails health checks.
- Rehearsal does not write to the final production state root. It restores from
  a NAS-proven backup into a temp staging directory first, then validates the
  staged runtime with read-only DB checks.
- Rehearsal staging root:
  `/tmp/shinyipilot-final-layout-rehearsal-<timestamp>`.
- Rehearsal runtime path inside staging:
  `/tmp/shinyipilot-final-layout-rehearsal-<timestamp>/production/runtime`.
- Rehearsal validates that the final Docker/env layout can point at that
  runtime, but it does not replace host `2999`.
- Actual migration to
  `/Users/rickwen/.local/state/shinyipilot/production/runtime` requires a
  separate operational decision because it changes production ownership and may
  require stopping the current cutover container.

Actual migration outline, not yet approved for execution:

1. Run Item 1 again immediately before migration.
2. Run Item 2 and Item 3 to create a fresh local and NAS backup.
3. Stop only the current ShinyiPilot cutover container after explicit approval.
4. Copy the fresh verified backup into the final ShinyiPilot state root.
5. Start the ShinyiPilot-owned Docker/deploy runner with final env and mount
   paths.
6. Verify `/health`, Docker/port ownership, DB integrity, and a controlled LINE
   canary only after local health passes.
7. Preserve the old transition runtime until Item 7 cleanup criteria are met.

Rollback rule:

- If the ShinyiPilot-owned final layout fails health or DB checks, stop the new
  deployment and restart the previous known-good transition container or old
  service path without restoring over the DB. Restore from backup remains a
  separate corruption-recovery decision.

### Item 7: Transition Runtime Cleanup Criteria

Status: specified; not executed.

Decision:

- Whether the transition runtime is deleted, archived, or retained after
  ShinyiPilot-owned deployment is stable.
- Minimum stable-running window before cleanup.
- Inventory and approval required before any directory-level deletion.
- Where any archive copy should live if it is retained.
- Default action is retain, not delete.
- Minimum stable-running window before any cleanup proposal: 7 days after the
  ShinyiPilot-owned deployment has owned host `2999` with successful health,
  DB integrity, and normal LINE behavior.
- Before cleanup, run a final read-only inventory on both old transition runtime
  and new ShinyiPilot-owned runtime, then compare row counts and selected DB
  hashes from the migration manifest.
- Preferred cleanup is archive-before-delete:
  copy the old transition runtime or final backup manifest to
  `/Volumes/home/backup/shinyipilot/transition-archives/` first.
- Directory deletion still requires explicit user approval with absolute path
  inventory. Do not infer approval from this plan.
- If there is no space pressure, keeping
  `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` as historical
  transition evidence is acceptable.
