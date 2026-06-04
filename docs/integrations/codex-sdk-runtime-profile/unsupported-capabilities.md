# Unsupported And Deferred Runtime Capabilities

Created: 2026-06-01 14:05
Last Updated: 2026-06-01 14:05
Status: Active

This document records what the current Codex adapter does **not** claim.

## Covered Profile

The current replacement claim covers:

- `SDK Core Profile`
- `Coding Agent Profile`

The current evidence proves these profile capabilities for the selected Chatpilot path:

- session creation and resume
- final assistant response through `sendAndWait()`
- command approval approve/deny
- file approval approve/deny
- custom SDK tool calls
- SDK tool failure and denied-result paths
- Chatpilot `/cli/chat` new-session and run-session app behavior
- Chatpilot `save_memo` / `list_memos` side effects through SQLite data assertions

## Deferred Profiles

### Interactive Profile

Deferred until a product path directly consumes it.

Not claimed:

- ask-user style `userInput.request`
- elicitation request/response
- UI capability change semantics

### Fidelity Profile

Deferred until UI or observability requirements demand it.

Not claimed:

- streaming delta fidelity
- reasoning delta fidelity
- usage event parity
- attachment behavior
- rich multi-client fan-out semantics

### Extended CLI Profile

Deferred by design. This profile should not define the app substrate.

Not claimed:

- `session.rpc.agent.*`
- `session.rpc.skills.*`
- `session.rpc.mcp.*`
- `session.rpc.plugins.*`
- `session.rpc.extensions.*`
- `session.rpc.workspaces.*`
- `session.rpc.plan.*`
- server-scoped config discovery or management RPCs

## Current Protocol Boundary

- Node SDK conformance uses protocol v3 by default.
- Chatpilot's current Python SDK uses protocol v2.
- The adapter explicitly supports both `CODEX_ADAPTER_PROTOCOL_VERSION=3` and `CODEX_ADAPTER_PROTOCOL_VERSION=2`.
- Protocol-v2 custom tools use SDK `tool.call` request/response.
- Protocol-v3 custom tools use `external_tool.requested` and `session.tools.handlePendingToolCall`.

## Non-Goals

- Full Copilot CLI cloning is not the goal.
- Matching exact assistant wording is not a protocol gate when the real Copilot CLI baseline transforms final prose after receiving the correct tool result.
- A behavior becomes required only when the selected SDK runtime profile or Chatpilot app path consumes it.
