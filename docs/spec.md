# Copilot SDK Canonical Spec

Created: 2026-05-16
Last Updated: 2026-06-15 18:42
Status: Active

## Purpose

This repo provides the Copilot SDK and the surrounding docs, examples, tests, and integrations that keep the runtime behavior understandable and testable.

## Current Project Role

- The SDK remains the primary surface for Copilot-shaped app development.
- Runtime backend experiments are allowed, but they must stay behind adapter boundaries.
- The current experimental direction is the `RuntimeBackend` abstraction described in [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md).
- Runtime replacement targets SDK runtime-profile parity for the selected app path, not full Copilot CLI parity.
- Codex replacement work now has a reusable experimental Node module boundary at [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), exposed through the package subpath `./experimental/codex-adapter`.
- The adapter intentionally remains experimental for the next P1 refactor slice. The graduation decision and future trigger are recorded in [docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md](./integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md).
- The adapter can also run as a long-lived Copilot-protocol server through [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), exposed as the package bin `copilot-codex-adapter`.
- The first downstream Chatpilot integration uses the existing SDK transport seam: Chatpilot keeps its runtime/session/app routing code stable and points its Python Copilot SDK client at the adapter with `CHATPILOT_COPILOT_CLI_URL`.
- The ShinyiPilot spike extends the same transport-boundary pattern to a Python app using local Python SDK source with the Node.js Codex adapter as a sidecar runtime. The current commit/deployment notes are recorded in [docs/integrations/codex-sdk-runtime-profile/shinyipilot-python-node-spike/spec.md](./integrations/codex-sdk-runtime-profile/shinyipilot-python-node-spike/spec.md).
- The Python-native Codex adapter package/CLI surface is now `copilot.codex_adapter` and `copilot-codex-adapter`, with a compatibility wrapper kept at `copilot.experimental.codex_adapter` for old imports. Selected-profile parity tests and live Codex app-server smoke evidence are recorded in [docs/integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md](./integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md) and [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json).
- Both Node and Python Codex adapters isolate sessions that do not provide `workingDirectory` by creating a UUID fallback workspace under `CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT` or the system temp default. Explicit `workingDirectory` remains the product-owned workspace contract. The adapters allow multiple Codex threads to use the same explicit workspace, but record `adapter.workspace.concurrent_threads` in the bounded adapter transcript when that happens.
- The adapter default permission lane is self-reviewed workspace execution: `approvalPolicy=on-request`, `approvalsReviewer=auto_review`, `sandboxMode=workspaceWrite`, and `networkAccess=false`. This lets SDK clients that use broad permission handlers still run ordinary workspace-local work, while Codex boundary crossings are reviewed by the Codex reviewer agent instead of being blindly approved by the SDK callback. Network is disabled by default, not hard-locked; products can explicitly set `CODEX_ADAPTER_NETWORK_ACCESS=true` when their bounded workspace lane needs network access.
- ShinyiPilot state-changing Codex adapter smokes now use the Docker lane at [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/). The lane uses a container-local clean Codex source home with auth-required files plus a generated minimal `config.toml`; host `config.toml`, MCP/plugin settings, skills, and memories are not copied into the smoke. The default Codex model for this daily-office experiment lane is `gpt-5.4-mini`; the clean-config proof at `/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107` validates an actual Codex turn, copied SQLite artifact read-back, ShinyiPilot tool logs, and adapter `semanticLog`, not GitHub Copilot SDK `list_models()` output. The Docker behavior sweep at `/tmp/shinyipilot-codex-docker-sweep-dev-20260615-014939` runs the same clean boundary across CLI memo/reminder/schedule CRUD plus the web facade getCurrentContext/operate loop, then verifies DB cleanup, ShinyiPilot logs, and adapter `semanticLog` success entries. The long-running lab artifact at `/tmp/shinyipilot-codex-docker-lab-live-20260615-0124` keeps the same clean Docker boundary while allowing repeated CLI probes against memo, reminder, schedule, and custom-prompt tools with live adapter summary inspection. Adapter `semanticLog` now includes bounded redacted previews for SDK tool arguments and results, while ShinyiPilot logs remain the full business-payload source. The production-like LINE cutover plan is tracked in [production-line-lab.md](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/production-line-lab.md), with repo ownership and no-hidden-overlay rules in [shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md). Short-term deployment decisions stay in this parent `copilot-sdk` branch because `shinyipilot-spike/` is a nested worktree, and production DB state must stay in a host-backed persistent `/runtime` with SQLite-aware backups for Cloudflare/host `2999` cutover. After ShinyiPilot commit `0946d0b`, the production-line no-overlay shadow proof passed at `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0938-production-line-shadow` with `sourceMode=real-shinyipilot-source-no-overlay`, host-backed `/runtime`, startup backup `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0938-production-line-startup`, no host port publishing, and signed synthetic LINE webhook DB/log read-back. Host `2999` cutover was executed with container `shinyipilot-codex-line-cutover-20260615-0958`, artifact `/Users/rickwen/.local/state/shinyipilot-codex-line/artifacts/20260615-0958-production-line-cutover`, startup backup `/Users/rickwen/.local/state/shinyipilot-codex-line/backups/20260615-0958-production-line-startup`, Docker-owned `127.0.0.1:2999`, and real LINE canary evidence after ShinyiPilot route models were corrected to `gpt-5.4-mini`.
- ShinyiPilot DB/runtime ownership is a staged handoff. The current host-backed runtime at `/Users/rickwen/.local/state/shinyipilot-codex-line/runtime` remains the transitional production-like state for the running cutover container and must not be cleaned up until the service is stable and a migration decision exists. The runtime backup dry run passed through local live read-only snapshot, non-destructive NAS copy, file-level restore, and service-level restore rehearsal at [runtime-backup-dry-run/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/runtime-backup-dry-run/plan.md); this proves the data movement shape but does not yet install recurring ShinyiPilot-owned backup automation. The final Docker/deploy/config/DB layout, backup/restore policy, production runbook, adapter build/pinning instructions, adapter capability boundary, and controller handoff docs belong in `~/code/shinyipilot`; this `copilot-sdk` branch keeps only the transition runner, adapter package/source, adapter-level E2E, and historical transition evidence. During the transition, the runtime needs a non-destructive periodic NAS sync path under `/Volumes/home/backup` in addition to local SQLite-aware startup backups. Final handoff means future Codex sessions can start in `/Users/rickwen/code/shinyipilot` and recover the production context from ShinyiPilot docs without reading this SDK branch first.
- Protocol compatibility is versioned at the adapter boundary. Node SDK conformance stays on protocol v3 by default; current Chatpilot Python SDK compatibility uses `CODEX_ADAPTER_PROTOCOL_VERSION=2`, including v2 `tool.call` custom tool handling.
- The protocol-version dynamic-tool routing decision is isolated in [nodejs/src/experimental/codexAdapterToolPolicy.ts](../nodejs/src/experimental/codexAdapterToolPolicy.ts). Protocol v2 routes through SDK `tool.call`; protocol v3 routes through `external_tool.requested` and `session.tools.handlePendingToolCall`.
- The conformance harness entrypoint remains [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), backed by reusable support modules in [nodejs/conformance](../nodejs/conformance). It is the regression gate for the adapter module.
- Downstream Chatpilot acceptance is covered by [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts). It runs isolated Chatpilot `/cli/chat` new-session and run-session flows against both `Copilot SDK + Copilot CLI` and `Copilot SDK + Codex adapter + Codex app-server`, then verifies SDK-visible logs, tool intent, session reuse, adapter transcript, and SQLite memory side effects.
- Current conformance artifacts are indexed in [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md).
- Deferred and unsupported runtime capabilities are recorded in [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md).
- Production readiness for running the selected Chatpilot live runtime profile on the Codex backend is tracked in [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md). The P0 gate is closed for the selected profile through Phase 4 lifecycle hardening, Phase 5 production proof, and Phase 6 policy/model-behavior cleanup; current evidence is indexed in [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md).

## Canonical Entrypoints

- Active todo: [docs/todo.md](./todo.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- ShinyiPilot deployment ownership transition: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md](./integrations/codex-sdk-runtime-profile/shinyipilot-deployment-ownership-transition/plan.md)
- Adapter graduation decision: [docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md](./integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md)
- Production readiness gate: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- ShinyiPilot Docker smoke lane: [docs/integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/](./integrations/codex-sdk-runtime-profile/shinyipilot-docker-smoke/)
- Production capability spike evidence: [docs/integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Session continuity: [.progress/progress.md](../.progress/progress.md)

## Architecture Diagram

Current artifact: [docs/architecture/skyeye.html](./architecture/skyeye.html)

The diagram shows the Chatpilot app substrate, Copilot SDK protocol seam, Copilot CLI baseline, Codex adapter path, and P0 readiness evidence chain.

Focused adapter integration diagram: [docs/architecture/dataflows/codex-adapter-integration.html](./architecture/dataflows/codex-adapter-integration.html)

Focused Python adapter Sky Eye: [docs/architecture/python-codex-adapter-skyeye.html](./architecture/python-codex-adapter-skyeye.html)

This Sky Eye narrows the view to `copilot.codex_adapter`: package boundary, CLI runner, Copilot-protocol TCP facade, mapper/policy layer, durable session store, Codex gateway, and the parity/live-smoke proof lanes.

## Code Map / CodeTour

Current artifact: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)

The code map identifies the adapter module, adapter server runner, conformance harness, Chatpilot acceptance harness, and downstream Chatpilot SDK/session seam.

Focused Python adapter CodeTour: [.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour](../.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour)

The tour walks the Python adapter package boundary, CLI boot path, gateway, server lifecycle mapping, mapper/policy split, durable resume store, and live smoke proof boundary.

## Source Of Truth Rules

- `docs/spec.md` is the canonical project entrypoint.
- `docs/todo.md` is the only active todo list.
- `docs/todo-finished.md` is the archive for completed and superseded work.
- `.progress/progress.md` is continuity only, not canonical state.
- Legacy dated todo files should not remain as active planning.
- If a runtime backend changes, the app substrate should stay stable and the backend should adapt to it.
- Adapter goals must name the SDK/runtime profile they support before claiming replacement parity.
