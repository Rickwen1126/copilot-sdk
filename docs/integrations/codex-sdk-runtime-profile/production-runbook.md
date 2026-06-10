# Codex Adapter Production Runbook

Created: 2026-06-09 11:45
Last Updated: 2026-06-09 11:45
Status: Phase 4 operational contract

This runbook is for operating the experimental Codex adapter as a Copilot SDK-compatible runtime backend.

## Required Login

Run `codex login` before starting the adapter.

The adapter starts `codex app-server` through the Codex CLI. For the ChatGPT subscription lane, the operator must log in with the intended ChatGPT account first. The adapter strips `OPENAI_API_KEY` from the child app-server environment so API-key mode does not accidentally override the ChatGPT-auth lane.

## Durable Resume Setup

Production resume requires three stable identities:

- `CODEX_ADAPTER_CODEX_HOME`: stable Codex runtime home that contains login and persisted thread state.
- `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH`: stable adapter mapping store for `sdkSessionId -> codexThreadId`.
- per-session workspace / `cwd`: stable execution workspace for the Codex thread.

Do not treat the default isolated temporary Codex home as durable. It is useful for local spike isolation, but it cannot be the production resume source of truth.

Do not resume the same SDK session into a different workspace unless that behavior has an explicit product-level migration policy. The adapter store records the original `cwd` and falls back to it when `resumeSession()` does not provide `workingDirectory`. If a developer changes the tool set or workspace while experimenting, starting a new SDK session is the cleaner path because it creates a fresh Codex thread with a fresh `thread/start` shape.

Recommended production shape:

```sh
CODEX_ADAPTER_CODEX_HOME="$HOME/.codex"
CODEX_ADAPTER_ISOLATE_CODEX_HOME=false
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="$HOME/.codex/copilot-sdk-runtime-sessions.json"
```

Continuity proof is not "the app-server process is alive". The proof is that the adapter can recover the persisted mapping for the intended SDK session and workspace, then Codex accepts `thread/resume` for the mapped thread.

## Chatpilot Locked Lane

The default adapter lane is intentionally locked down for Chatpilot-style chatbot use:

```sh
CODEX_ADAPTER_APPROVAL_POLICY=never
CODEX_ADAPTER_SANDBOX_MODE=readOnly
CODEX_ADAPTER_NETWORK_ACCESS=false
```

These are also the adapter defaults. They prevent the Codex coding-agent prior from turning a chatbot request into native shell/file side effects. If a coding-agent product path needs broader native Codex tools, run it as a separate explicit runtime profile and prove it with its own conformance artifact.

## Resume Tool-Set Policy

Codex supports dynamic tools on `thread/start`, not supported hot-update semantics on `thread/resume`.

The adapter therefore rejects incompatible resume requests:

- in-memory resume with a different SDK tool set is rejected before `thread/resume`
- adapter-restart resume for a session that originally had tools must provide the matching tool set
- adapter-restart resume with a different tool set is rejected before `thread/resume`

The current Phase 4 policy is reject rather than fork or recreate. Fork/recreate can be added later only if a product path needs that behavior and has evidence for the resulting semantics.

## Operational Knobs

Common environment variables:

```sh
CODEX_ADAPTER_PORT=4873
CODEX_ADAPTER_PROTOCOL_VERSION=2
CODEX_ADAPTER_MODEL=gpt-5.4
CODEX_ADAPTER_REQUEST_TIMEOUT_MS=45000
CODEX_ADAPTER_TRANSCRIPT_LIMIT=500
CODEX_ADAPTER_SUMMARY_PATH=/tmp/codex-adapter-summary.json
```

`CODEX_ADAPTER_REQUEST_TIMEOUT_MS` controls Codex request timeout and protocol-v3 pending dynamic tool timeout. `CODEX_ADAPTER_TRANSCRIPT_LIMIT` keeps adapter and gateway summaries bounded for long-running processes.

## Minimal Start Command

```sh
CODEX_ADAPTER_PORT=4873 \
CODEX_ADAPTER_PROTOCOL_VERSION=2 \
CODEX_ADAPTER_CODEX_HOME="$HOME/.codex" \
CODEX_ADAPTER_ISOLATE_CODEX_HOME=false \
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="$HOME/.codex/copilot-sdk-runtime-sessions.json" \
CODEX_ADAPTER_APPROVAL_POLICY=never \
CODEX_ADAPTER_SANDBOX_MODE=readOnly \
CODEX_ADAPTER_NETWORK_ACCESS=false \
node dist/experimental/codexAdapterServer.js
```

Use `cliUrl: "127.0.0.1:4873"` from the SDK consumer.
