# Runtime Backend Code Map

Created: 2026-06-01 14:05
Last Updated: 2026-06-11 15:34
Status: Active

This code map describes the current Codex replacement path for the selected `SDK Core Profile + Coding Agent Profile`.

## Reading Path

1. [Runtime backend guide](../integrations/runtime-backends.md) defines the app-vs-runtime boundary and the supported/deferred profile split.
2. [Codex SDK runtime profile plan](../integrations/codex-sdk-runtime-profile/plan.md) defines the conformance gate.
3. [Codex adapter graduation decision](../integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md) explains why the adapter intentionally remains under the experimental package/source boundary for the next P1 slice.
4. [Codex adapter module](../../nodejs/src/experimental/codexAdapter.ts) implements the Copilot-protocol facade over Codex app-server.
5. [Codex adapter server runner](../../nodejs/src/experimental/codexAdapterServer.ts) exposes the adapter as a long-running TCP server for downstream SDK clients.
6. [Adapter conformance harness](../../nodejs/examples/copilot-codex-adapter-spike.ts) proves selected profile parity against `Copilot SDK + Copilot CLI`.
7. [Chatpilot runtime acceptance harness](../../nodejs/examples/chatpilot-runtime-acceptance.ts) proves app-level new-session and run-session behavior through real Chatpilot `/cli/chat`.

## Copilot SDK Repo Surfaces

### `nodejs/src/experimental/codexAdapter.ts`

Primary responsibility: translate between the Copilot SDK protocol shape and Codex app-server protocol shape.

Important exports:

- `CODEX_ADAPTER_CAPABILITIES`: explicit supported and deferred profile/capability claims.
- `CodexCopilotAdapterServer`: TCP server that accepts Copilot SDK client connections.
- `createCodexCopilotClientOptions`: helper for SDK clients that want to connect to the adapter server.

Important boundary:

- the adapter remains intentionally exposed through `./experimental/codex-adapter`;
- raw gateway / JSON-RPC implementation classes are internal and must not leak through the package subpath;
- root SDK exports must stay free of Codex adapter internals until a future stable graduation decision changes the public contract.

Key behavior:

- protocol v3 is the default for the current Node SDK conformance harness.
- protocol v2 is supported for Chatpilot's current Python SDK.
- `system_message.mode=replace` maps to Codex `thread/start.baseInstructions`.
- SDK custom tools map to Codex `thread/start.experimental.dynamicTools`.
- Codex `item/tool/call` maps to SDK tool handling:
  - protocol v3: `external_tool.requested` plus `session.tools.handlePendingToolCall`
  - protocol v2: `tool.call` request/response
- command approvals map Codex `item/commandExecution/requestApproval` to SDK permission requests.
- file approvals map Codex `item/fileChange/requestApproval` to SDK write permission requests.

### `nodejs/src/experimental/codexAdapterServer.ts`

Primary responsibility: run the reusable adapter as an external Copilot-protocol backend.

Important env:

- `CODEX_ADAPTER_PORT`
- `CODEX_ADAPTER_PROTOCOL_VERSION`
- `CODEX_ADAPTER_MODEL`
- `CODEX_ADAPTER_APPROVAL_POLICY`
- `CODEX_ADAPTER_APPROVALS_REVIEWER`
- `CODEX_ADAPTER_SANDBOX_MODE`
- `CODEX_ADAPTER_NETWORK_ACCESS`
- `CODEX_ADAPTER_SUMMARY_PATH`

Operational behavior:

- emits one JSON readiness line containing `event = "codex-adapter.listening"` and `cliUrl`
- writes optional shutdown summary with adapter and Codex transcripts
- is exposed through package bin `copilot-codex-adapter`

### `nodejs/examples/copilot-codex-adapter-spike.ts`

Primary responsibility: adapter-module conformance gate.

Coverage:

- core new session
- resume continuation
- command approval approve
- command approval deny
- file approval approve/deny
- custom tool call
- tool deny/failure

The harness runs the same profile against both:

- `Copilot SDK + Copilot CLI`
- `Copilot SDK + Codex adapter + Codex app-server`

### `nodejs/examples/chatpilot-runtime-acceptance.ts`

Primary responsibility: downstream app-level acceptance gate.

Coverage:

- isolated Chatpilot config, route bindings, logs, workspace, and SQLite DBs
- baseline mode: `Copilot SDK + Copilot CLI`
- adapter mode: `Copilot SDK + Codex adapter + Codex app-server`
- `/cli/chat` new-session turn requiring `save_memo`
- `/cli/chat` run-session turn requiring `list_memos`
- SQLite `memory_memos` data assertion
- Chatpilot SDK session reuse assertion
- SDK-visible tool intent assertion
- adapter transcript assertion for Codex `item/tool/call` and protocol-v2 SDK `tool.call`

## Downstream Chatpilot Surfaces

These files live in `/Users/rickwen/code/chatpilot` and are part of the downstream integration evidence.

### `src/chatpilot/sdk/session.py`

Primary responsibility: keep Chatpilot's app/session code stable while allowing the SDK client transport to be swapped.

Integration seam:

- `CHATPILOT_COPILOT_CLI_URL` passes `cli_url` into `copilot.CopilotClient`.
- `CHATPILOT_RUNTIME_BACKEND=codex-adapter` labels the backend and requires `CHATPILOT_COPILOT_CLI_URL`.
- when no env is provided, default behavior remains bundled Copilot CLI.
- `create_session()` and `resume_session()` still use the existing `PermissionHandler.approve_all` policy path.

### `src/chatpilot/chatbot/manager.py`

Primary responsibility: preserve app-level execution identity.

Relevant behavior:

- `build_sdk_session_id(route_id, chatbot_name)` creates stable SDK session IDs.
- `get_or_create_session()` first reuses an existing in-memory route session.
- new sessions and resumed sessions keep the same route/chatbot identity.
- tools are selected from Chatpilot config, not from runtime-specific adapter logic.

### `src/chatpilot/server/webhook.py`

Primary responsibility: expose the app-level test surface.

Relevant behavior:

- `/cli/chat` goes through the full hub -> router -> chatbot -> SDK path.
- Phase 6 acceptance intentionally uses this route instead of direct `SdkClient` calls.

## Invariants

- Chatpilot route identity, memory ownership, and tool registration remain app-substrate concerns.
- Runtime backends do not define Chatpilot route IDs or memory partitioning.
- Adapter conformance claims are profile-scoped; unsupported Copilot CLI escape hatches are not silently claimed.
- The Codex adapter remains under the experimental package/source boundary until the graduation trigger in the adapter graduation decision is met.
- Logs alone are evidence, not verdict. Verdicts require data-level assertions and machine-readable reports.
