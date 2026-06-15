# Python-Native Codex Adapter Spike

Created: 2026-06-12 15:53
Last Updated: 2026-06-15 18:10
Status: Phase 1 implementation, parity tests, live Codex smoke evidence, and package-path graduation shim

This spike ports the selected Node.js Codex adapter profile into a Python-native
experimental surface without switching ShinyiPilot or Chatpilot production
routes. The adapter remains behind the Copilot protocol TCP boundary, so Python
SDK clients connect through `ExternalServerConfig` exactly as they do with the
Node sidecar.

## Package Boundary

Current code surface:

- `python/copilot/codex_adapter/`
- CLI entrypoint: `copilot-codex-adapter`
- Public import path: `copilot.codex_adapter`
- Legacy compatibility import path: `copilot.experimental.codex_adapter`

The root `copilot` package does not re-export adapter internals. The adapter is
still not re-exported from the root SDK package because downstream production
lanes need explicit adapter pinning and proof. The old
`copilot.experimental.codex_adapter` path remains as a compatibility shim for
existing tests, docs, and artifacts.

## Runtime Layers

- Copilot-protocol server: `server.py` owns TCP `Content-Length` JSON-RPC
  framing, SDK request handlers, SDK notifications, and SDK request callbacks.
- Codex app-server gateway: `gateway.py` owns `codex app-server` subprocess
  startup, initialize/initialized handshake, line-delimited JSON-RPC requests,
  stderr capture, transcript capture, and response/notification/request routing.
- Adapter core: `server.py` handles `ping`, `status.get`, `auth.getStatus`,
  `models.list`, `session.create`, `session.resume`, `session.getMessages`,
  `session.send`, `session.destroy`, `session.delete`, and
  `session.tools.handlePendingToolCall`.
- Policy, mappers, and store: `mappers.py`, `tool_policy.py`, and
  `session_store.py` port the Node adapter shape for tool descriptors,
  v2/v3 tool routing, approval decisions, sandbox/model/auth mapping, and
  durable SDK-session to Codex-thread records.

## Spike Matrix Result

| Spike | Result | Evidence |
| --- | --- | --- |
| S1 Transport parity | Passed with fake gateway | `CopilotClient(ExternalServerConfig(url=server.cli_url()))` can call `ping`, `status.get`, `auth.getStatus`, and `models.list`. |
| S2 Gateway parity | Passed with live Codex smoke | `python/examples/codex_adapter_live_smoke.py` starts the real `copilot-codex-adapter` CLI, reaches `codex app-server`, and records `account/read`, `model/list`, `thread/start`, `turn/start`, `thread/resume`, and `thread/archive` in the adapter transcript. |
| S3 Session lifecycle parity | Passed with fake gateway and live smoke | Fake-gateway tests cover `create -> send_and_wait -> getMessages -> destroy -> resume -> delete`; live smoke proves the same lifecycle hits real Codex `thread/start`, `turn/start`, `thread/resume`, and `thread/archive`. |
| S4 Resume/store parity | Passed with fake gateway and dedicated store tests | Restart resume rejects missing or changed tool descriptors before any `thread/resume` call when a persisted non-empty tool fingerprint exists, and the session-store file shape is covered by direct load/upsert/delete tests. |
| S5 Tool parity | Passed with fake gateway and Node snapshot comparison | Protocol v2 routes Codex `item/tool/call` through SDK `tool.call`; protocol v3 routes through `external_tool.requested` and `session.tools.handlePendingToolCall`, including success, denied, failure, timeout, and unknown-tool paths. |
| S6 Permission/sandbox parity | Passed with callback-path tests | Python tests now cover command/file permission request callbacks end-to-end, sandbox policy mapping, model mapping, safe tool-result text, and the Python SDK `PermissionRequest` shape expected by downstream clients. |
| S7 App smoke | Not run in this implementation slice | ShinyiPilot `29999` smoke remains a follow-up. This run did not touch live `2999`, `4800`, `4801`, or `4811`. |

## Difference Table

### Same As Node

- Tool descriptor normalization and dynamic tool exposure.
- Safe SDK tool result to Codex dynamic-tool response mapping.
- Codex model metadata mapping into SDK model list shape.
- Sandbox aliases and Codex thread/turn sandbox policy mapping.
- Command approval and file-change approval request/decision mapping.
- Protocol v2 dynamic tool calls through SDK `tool.call`.
- Protocol v3 dynamic tool calls through `external_tool.requested` plus
  `session.tools.handlePendingToolCall`.
- Durable session store file shape and incompatible resume tool-fingerprint
  gates.
- Selected-profile parity snapshot coverage via
  `nodejs/conformance/codexAdapterParitySnapshot.ts` and
  `python/test_codex_adapter_parity_snapshot.py`.

### Python Implementation Detail, Same Observable Behavior

- The TCP JSON-RPC server is implemented with `asyncio.start_server` instead of
  Node `net` plus `vscode-jsonrpc`.
- SDK callback requests (`tool.call`, `permission.request`) are sent by an
  adapter-owned `JsonRpcConnection` helper.
- Fake-gateway integration tests drive Codex app-server requests directly
  through the gateway interface instead of starting a real Codex subprocess.
- Tests use `CopilotClient.force_stop()` for external TCP teardown to avoid
  waiting on graceful session cleanup after the test assertion boundary.
- The parity snapshot normalizes per-run session ids and SDK-client error
  envelopes (`Request ... failed with message:` vs `JSON-RPC Error -32603:`)
  before comparing Node and Python artifacts, so the semantic adapter message
  remains the comparison unit.

### Gap Requiring Next Design Discussion

- ShinyiPilot `29999` CLI smoke has not yet been run against the Python-native
  adapter.
- The gateway has no production readiness/health endpoint beyond CLI startup
  output and summary writing.
- If strict cross-SDK exception-string parity matters, the Python SDK currently
  wraps adapter RPC failures with its own JSON-RPC error envelope instead of
  Node's `Request <method> failed with message: ...` text.
- The phase still uses a fake gateway for approval/tool fixture determinism; a
  future production-like lane may choose to add real side-effect approval probes
  against live Codex policy if a downstream app needs them.

## Verification

Commands run:

```sh
uv run pytest python/test_codex_adapter_mappers.py python/test_codex_adapter_server.py python/test_codex_adapter_session_store.py python/test_codex_adapter_parity_snapshot.py -q
```

Result:

```text
24 passed in 0.66s
```

```sh
cd python && uv run --extra dev ruff check copilot/codex_adapter copilot/experimental examples/codex_adapter_live_smoke.py test_codex_adapter_mappers.py test_codex_adapter_server.py test_codex_adapter_session_store.py test_codex_adapter_parity_snapshot.py
```

Result:

```text
All checks passed!
```

```sh
cd python && uv run python -m compileall copilot/codex_adapter copilot/experimental copilot/generated examples/codex_adapter_live_smoke.py test_codex_adapter_mappers.py test_codex_adapter_server.py test_codex_adapter_session_store.py test_codex_adapter_parity_snapshot.py
```

Result: all targeted adapter modules, compatibility wrappers, generated
permission-event models, smoke scripts, and parity tests compile.

```sh
cd python && uv run python examples/codex_adapter_live_smoke.py --out ../docs/integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json
```

Result:

- status: `pass`
- adapter summary sha256: `00176c3b8e9140deeb89ff89fb4f36cdb3479429ad87750d634d133fc3140cf0`
- sanitized live proof: [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](../artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json)
