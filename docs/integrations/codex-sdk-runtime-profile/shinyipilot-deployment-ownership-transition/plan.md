# ShinyiPilot Deployment Ownership Transition Plan

Created: 2026-06-15 09:32
Last Updated: 2026-06-15 09:32
Status: Active

## Purpose

This plan records how the ShinyiPilot Codex adapter production-line experiment
moves from a `copilot-sdk`-owned Docker lab into a cleaner two-repo operating
model.

The immediate problem is that the current production-line shadow proof uses
real `~/code/shinyipilot` source/config/env, but temporarily overlays two
adapter compatibility files from `shinyipilot-spike` inside the Docker build
context. That is acceptable as a proof technique. It is not acceptable as the
default production deployment shape because the code running in the container
would not match the code a reviewer sees in `~/code/shinyipilot`.

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
- Production-like DB/runtime state stays in a host-backed persistent directory
  with SQLite-aware startup backups. It must not be treated as disposable image
  or container state.

In the future complete deployment:

- `shinyipilot` owns Dockerfile/compose/deploy scripts, app config, DB runtime
  layout, backup/restore policy, and production runbooks.
- `copilot-sdk` provides the tested Codex adapter source/package and keeps its
  own adapter-level Docker E2E regression harness.
- `copilot-sdk` no longer owns ShinyiPilot production deployment. It verifies
  that the adapter can be packaged into an app image; it does not operate the
  app's production container.

## No-Hidden-Overlay Guard

The transition guard is:

```text
Default production-line builds must use ~/code/shinyipilot as-is.
Any adapter compatibility overlay must be explicit, artifact-visible, and
debug-only.
```

The current overlay exists only because the real ShinyiPilot checkout has not
yet accepted the Codex adapter compatibility changes. Before host `2999`
cutover, the accepted subset should be ported into `~/code/shinyipilot`, then
the production-line runner should default to no overlay.

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

## Milestones

### M1: Record Ownership Decision

Status: complete in this plan.

Done when:

- The transition ownership model is recorded in `docs/`.
- Active todo items point to this plan.
- Production LINE lab docs identify the overlay as temporary.

### M2: Port Minimal ShinyiPilot Compatibility

Done when:

- The accepted `session.py` and `factory.py` behavior is ported or
  cherry-picked into `~/code/shinyipilot`.
- ShinyiPilot unit tests cover the Codex adapter runtime selection and SDK
  `ToolInvocation` normalization.
- No `.env`, route config, DB, runtime asset, or production data file is
  modified by the port.

### M3: Make Production Runner No-Overlay By Default

Done when:

- `run-production-line.sh` builds from `~/code/shinyipilot` as-is by default.
- The runner fails fast if the real ShinyiPilot source lacks required
  compatibility behavior.
- Overlay requires an explicit debug flag and writes source-mode evidence into
  artifacts.
- Cutover mode refuses overlay-enabled builds.

### M4: Produce No-Overlay Shadow Proof

Done when:

- Production-line shadow mode passes with source mode recorded as no overlay.
- Startup backup passes immediately before the container starts.
- Synthetic LINE webhook proof includes health, route policy, source-message
  capture, route identity registry update, ShinyiPilot log evidence, and
  adapter evidence.
- Host `2999`, `4800`, `4801`, and `4811` remain untouched.

### M5: Prepare Host 2999 Cutover And Backout

Done when:

- The checklist references the latest no-overlay shadow proof.
- The old host-local `2999` service stop path is explicit and does not edit,
  delete, or migrate its data.
- Docker cutover publishes only `127.0.0.1:2999 -> container:29999`.
- Backout preserves persistent `/runtime` and defines when restore from backup
  is allowed.

### M6: Move Accepted Deployment Ownership To ShinyiPilot

Done when:

- ShinyiPilot owns its Docker/deploy/config/DB/backup docs.
- `copilot-sdk` retains only adapter packaging and adapter-level integration
  tests.
- The `copilot-sdk` production-line lab is marked as historical or transition
  evidence instead of the app deployment source of truth.

## Current Evidence

- Production-line shadow runner commit:
  `65b04dd test: add shinyipilot production line shadow runner`
- Latest passing shadow artifact:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-030207-production-line-shadow`
- Latest startup backup:
  `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-030207-production-line-startup`
- Current source mode:
  `real-shinyipilot-source-with-adapter-compat-overlay`

## Non-Goals

- Do not move all ShinyiPilot deployment ownership into `copilot-sdk`.
- Do not merge the entire `shinyipilot-spike` worktree into `~/code/shinyipilot`.
- Do not move ShinyiPilot real config, `.env`, DB files, or runtime assets into
  this repo.
- Do not publish host `2999` until the no-overlay shadow gate and cutover
  checklist are complete.

## Open Decisions

- How the Codex adapter is version-pinned when ShinyiPilot owns the final Docker
  deployment.
- Whether long-running production auth uses a controlled writable Codex state
  volume, an API-key/service-account lane, or another explicit mechanism.
- Which backup/restore automation belongs in ShinyiPilot once deployment
  ownership moves there.
