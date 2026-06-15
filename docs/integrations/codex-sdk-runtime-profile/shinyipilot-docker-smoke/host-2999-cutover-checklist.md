# ShinyiPilot Host 2999 Cutover Checklist

Created: 2026-06-15 09:44
Last Updated: 2026-06-15 09:44
Status: Ready for explicit cutover approval

This checklist is the operational gate for moving host `127.0.0.1:2999` from
the old host-local ShinyiPilot service to the production-line Docker container.

It is a checklist, not approval to cut over. Do not stop the old service or
publish host `2999` until the user explicitly says to proceed with cutover.

## Current Accepted Baseline

- ShinyiPilot app compatibility commit:
  `0946d0b feat: support codex adapter runtime backend`
- `copilot-sdk` runner/docs commit:
  `b0b7b3e test: require shinyipilot no-overlay production shadow`
- Latest no-overlay shadow artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0938-production-line-shadow`
- Latest no-overlay startup backup:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0938-production-line-startup`
- Required source mode:
  `real-shinyipilot-source-no-overlay`

## Invariants

- Do not edit, delete, move, or migrate old host-local `2999` service data.
- Do not edit `~/code/shinyipilot/.env`, route config, SQLite DBs, `data/`, or
  runtime assets as part of cutover.
- Do not run destructive cleanup on
  `~/.local/state/shinyipilot-codex-line/runtime`.
- Do not use adapter compatibility overlay for cutover.
- Do not touch host `4800`, `4801`, or `4811`.
- Do not restore a DB backup unless there is concrete corruption evidence and a
  separate restore decision.

## Pre-Cutover Checks

1. Confirm both repos are on the expected commits or later accepted commits.

   ```sh
   git -C /Users/rickwen/code/shinyipilot log -1 --oneline
   git -C /Users/rickwen/code/copilot-sdk log -1 --oneline
   ```

2. Confirm ShinyiPilot has no unexpected dirty app/config/data changes.

   ```sh
   git -C /Users/rickwen/code/shinyipilot status --short
   ```

   Expected: empty, or only explicitly accepted source changes.

3. Confirm the current host `2999` owner before stopping anything.

   ```sh
   lsof -nP -iTCP:2999 -sTCP:LISTEN
   ```

   Record the PID and command. This is evidence, not an instruction to kill it.

4. Run a fresh no-overlay shadow proof immediately before cutover.

   ```sh
   TIMESTAMP="$(date +%Y%m%d-%H%M%S)" \
   PRODUCTION_LINE_MODE=shadow \
   ALLOW_SHINYIPILOT_COMPAT_OVERLAY=NO \
   docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh
   ```

5. Verify the fresh shadow artifact.

   Required evidence:

   - `source-overlay-manifest.json` has `status=not_applied`.
   - `source-overlay-manifest.json` has
     `sourceMode=real-shinyipilot-source-no-overlay`.
   - `startup-backup-manifest.json` or backup `manifest.json` has
     `status=pass`.
   - `line-shadow-preflight-result.json` has `status=pass`.
   - `line-shadow-preflight-result.json` has
     `runtimeBackend=codex-adapter`.
   - `line-shadow-preflight-result.json` has `model=gpt-5.4-mini` unless the
     cutover intentionally overrides the model.
   - SQLite read-back confirms the synthetic shadow message row.
   - ShinyiPilot log contains the line-ingress handled marker.

## Cutover Steps

1. Stop only the old host-local `2999` process.

   Use the least invasive process stop available for the recorded owner, such as
   service stop, terminal interrupt, or `kill -TERM <pid>`.

   Do not delete files. Do not edit configs. Do not move DBs.

2. Confirm host `2999` is free.

   ```sh
   lsof -nP -iTCP:2999 -sTCP:LISTEN
   ```

   Expected: no output.

3. Start the Docker cutover container.

   ```sh
   TIMESTAMP="$(date +%Y%m%d-%H%M%S)" \
   PRODUCTION_LINE_MODE=cutover \
   ALLOW_HOST_2999_CUTOVER=YES \
   ALLOW_SHINYIPILOT_COMPAT_OVERLAY=NO \
   docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/run-production-line.sh
   ```

   The runner publishes only:

   ```text
   127.0.0.1:2999 -> container:29999
   ```

4. Verify local health through the host port.

   ```sh
   curl -fsS http://127.0.0.1:2999/health
   ```

   Expected: JSON health payload with `status=ok` or `status=healthy`.

5. Confirm the cutover container is the host `2999` owner.

   ```sh
   docker ps --filter name=shinyipilot-codex-line-cutover
   lsof -nP -iTCP:2999 -sTCP:LISTEN
   ```

6. Confirm Cloudflare tunnel still targets host `2999`.

   No Cloudflare tunnel config change is expected if the tunnel already targets
   the host `2999` endpoint. Record the verification method used in the cutover
   notes.

7. Run one controlled real LINE canary only after local health passes.

   Required evidence:

   - LINE request reaches the Docker-backed service.
   - SQLite read-back confirms expected source/message/tool state.
   - ShinyiPilot logs contain the expected ingress/tool evidence.
   - Adapter summary contains the expected session/turn/tool semantic entries
     if the canary exercises Codex turns.

## Backout

1. Stop the cutover container.

   ```sh
   docker stop <cutover-container-name>
   ```

2. Confirm host `2999` is free.

   ```sh
   lsof -nP -iTCP:2999 -sTCP:LISTEN
   ```

3. Restart the old host-local service only if needed.

   Use the original command/service manager for the recorded old service. Do not
   change its data.

4. Preserve the persistent runtime.

   Do not delete:

   ```text
   /Users/rickwen/.local/state/shinyipilot-codex-line/runtime
   ```

5. Restore from backup only with a separate decision.

   A failed canary or bad deployment is not automatically DB corruption. Restore
   only if there is concrete evidence that the experiment corrupted state, and
   choose the specific backup manifest to restore from.

## Evidence To Keep

- Old `2999` owner PID/command before stop.
- Fresh no-overlay shadow artifact path.
- Fresh startup backup path.
- Cutover artifact path.
- `curl http://127.0.0.1:2999/health` payload.
- `lsof` output showing Docker owns host `2999`.
- Cloudflare tunnel target verification.
- Real LINE canary timestamp, route id, DB read-back, ShinyiPilot log lines, and
  adapter summary path.
- Backout command and post-backout `lsof` result if backout is used.
