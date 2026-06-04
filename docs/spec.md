# Copilot SDK Canonical Spec

Created: 2026-05-16
Last Updated: 2026-06-01 14:05
Status: Active

## Purpose

This repo provides the Copilot SDK and the surrounding docs, examples, tests, and integrations that keep the runtime behavior understandable and testable.

## Current Project Role

- The SDK remains the primary surface for Copilot-shaped app development.
- Runtime backend experiments are allowed, but they must stay behind adapter boundaries.
- The current experimental direction is the `RuntimeBackend` abstraction described in [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md).
- Runtime replacement targets SDK runtime-profile parity for the selected app path, not full Copilot CLI parity.
- Codex replacement work now has a reusable experimental Node module boundary at [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), exposed through the package subpath `./experimental/codex-adapter`.
- The adapter can also run as a long-lived Copilot-protocol server through [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), exposed as the package bin `copilot-codex-adapter`.
- The first downstream Chatpilot integration uses the existing SDK transport seam: Chatpilot keeps its runtime/session/app routing code stable and points its Python Copilot SDK client at the adapter with `CHATPILOT_COPILOT_CLI_URL`.
- Protocol compatibility is versioned at the adapter boundary. Node SDK conformance stays on protocol v3 by default; current Chatpilot Python SDK compatibility uses `CODEX_ADAPTER_PROTOCOL_VERSION=2`, including v2 `tool.call` custom tool handling.
- The conformance harness remains in [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts) and is the regression gate for the adapter module.
- Downstream Chatpilot acceptance is covered by [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts). It runs isolated Chatpilot `/cli/chat` new-session and run-session flows against both `Copilot SDK + Copilot CLI` and `Copilot SDK + Codex adapter + Codex app-server`, then verifies SDK-visible logs, tool intent, session reuse, adapter transcript, and SQLite memory side effects.
- Current conformance artifacts are indexed in [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md).
- Deferred and unsupported runtime capabilities are recorded in [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md).

## Canonical Entrypoints

- Active todo: [docs/todo.md](./todo.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Session continuity: [.progress/progress.md](../.progress/progress.md)

## Architecture Diagram

Current artifact: [docs/architecture/skyeye.html](./architecture/skyeye.html)

The diagram shows the Chatpilot app substrate, Copilot SDK protocol seam, Copilot CLI baseline, Codex adapter path, and Phase 6 acceptance evidence chain.

## Code Map / CodeTour

Current artifact: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)

The code map identifies the adapter module, adapter server runner, conformance harness, Chatpilot acceptance harness, and downstream Chatpilot SDK/session seam.

## Source Of Truth Rules

- `docs/spec.md` is the canonical project entrypoint.
- `docs/todo.md` is the only active todo list.
- `docs/todo-finished.md` is the archive for completed and superseded work.
- `.progress/progress.md` is continuity only, not canonical state.
- Legacy dated todo files should not remain as active planning.
- If a runtime backend changes, the app substrate should stay stable and the backend should adapt to it.
- Adapter goals must name the SDK/runtime profile they support before claiming replacement parity.
