# Codex Adapter Production Runbook

Created: 2026-06-09 11:45
Last Updated: 2026-06-15 01:33
Status: P0 operational contract for selected Chatpilot Codex adapter profile

This runbook is for operating the experimental Codex adapter as a Copilot SDK-compatible runtime backend.

## Required Login

Run `codex login` before starting the adapter.

The adapter starts `codex app-server` through the Codex CLI. For the ChatGPT subscription lane, the operator must log in with the intended ChatGPT account first. The adapter strips `OPENAI_API_KEY` from the child app-server environment so API-key mode does not accidentally override the ChatGPT-auth lane.

Phase 6 validation also proved the isolated Codex app-server lane can read the ChatGPT account with both `refreshToken=false` and `refreshToken=true`, and can list models from the copied runtime home. Keep raw auth smoke artifacts out of repo because they can contain account identity details; record only hashes and boolean evidence.

## ShinyiPilot Docker Smoke Lane

State-changing ShinyiPilot Codex adapter smokes should run in Docker by default.
Use [shinyipilot-docker-smoke/](./shinyipilot-docker-smoke/) as the current
smoke harness.

The Docker lane is the safety boundary for high-density or destructive-looking
experiments:

- The host Codex home is mounted read-only.
- The smoke copies only auth-required files from that mount into a
  container-local clean source home under `/runtime/codex-clean-home`.
- The smoke generates a minimal `config.toml` in the clean source home. Host
  `config.toml` is intentionally not copied, so host MCP/plugin/skill settings
  do not enter the Docker smoke lane.
- The adapter receives the clean source home and runs with
  `CODEX_ADAPTER_ISOLATE_CODEX_HOME=true`, so `gateway.py` copies those clean
  files into a container-local isolated Codex home before starting
  `codex app-server`.
- ShinyiPilot app state, SQLite DBs, Codex runtime session store, and fallback
  workspaces live under container-local `/runtime`.
- The container does not publish adapter `4873` or ShinyiPilot `29999` to the
  host. Those ports are container-internal only.
- The only host-writable path is the artifact directory mounted at `/artifacts`.

The default model for this Codex-backed daily-office experiment lane is
`gpt-5.4-mini`. This is a Codex runtime model policy, not a GitHub Copilot SDK
`list_models()` claim. ShinyiPilot notes about Copilot CLI / GitHub Copilot SDK
model-list behavior must not be used as evidence against Codex app-server model
availability. The Docker smoke proves the model by running an actual Codex turn
and checking ShinyiPilot DB/log/adapter-summary side effects.

Latest verified artifact:
`/tmp/shinyipilot-codex-docker-smoke-clean-20260615-0107`. That run reported
`codexHomeMode=clean-minimal-config`, returned CLI response `saved`, copied
`chatpilot.db` back to the host, read one matching `memory_memos` row from the
copied artifact DB, recorded ShinyiPilot `[tool_call] save_memo` /
`[tool_result] ... status=success`, and recorded adapter semantic events for
session creation, turn start, tool routing, SDK tool dispatch, and SDK tool
result.

Auth state for this smoke lane is intentionally ephemeral after container
startup: the host provides read-only login material, Codex app-server writes any
refresh/session state into container-local homes, and the container removes that
state at exit. That is acceptable for short state-changing smokes, but not yet a
long-running production auth strategy.

For exploratory tool-calling probes, use the same Docker lane in lab mode. Lab
mode starts the adapter and ShinyiPilot app inside the container, writes
`lab-ready.json`, and keeps both processes running without publishing host
ports. The 2026-06-15 01:24 lab at
`/tmp/shinyipilot-codex-docker-lab-live-20260615-0124` verified natural-language
CLI turns for memo, reminder, schedule, custom-prompt, list, cancel, and delete
tool flows with DB read-back and live `adapter-summary.json` inspection.
Adapter `semanticLog` is a control-plane view: lifecycle, routing, dispatch,
result, and assistant completion. Tool routing/result events include bounded
redacted previews of SDK tool arguments and results for quick scanability.
ShinyiPilot logs remain the business-payload view for full tool arguments, tool
result text, and DB mutation messages.

## Durable Resume Setup

Production resume requires three stable identities:

- `CODEX_ADAPTER_CODEX_HOME`: stable Codex runtime home that contains login and persisted thread state.
- `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH`: stable adapter mapping store for `sdkSessionId -> codexThreadId`.
- per-session workspace / `cwd`: stable execution workspace for the Codex thread.

Do not treat the default isolated temporary Codex home as durable. It is useful for local spike isolation, but it cannot be the production resume source of truth.

If the SDK consumer does not provide `workingDirectory`, the adapter now creates a session-specific UUID workspace under `CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT`. If that variable is unset, the parent is the system temp default `copilot-codex-adapter-workspaces` directory. This fallback prevents unrelated SDK sessions from silently sharing the adapter process cwd, but production apps should still pass an explicit workspace when the user/project identity is known.

Do not resume the same SDK session into a different workspace unless that behavior has an explicit product-level migration policy. The adapter store records the original `cwd` and falls back to it when `resumeSession()` does not provide `workingDirectory`. If a developer changes the tool set or workspace while experimenting, starting a new SDK session is the cleaner path because it creates a fresh Codex thread with a fresh `thread/start` shape.

Multiple SDK sessions may intentionally point at the same explicit workspace. The adapter does not block that pattern because product-level collaboration and concurrent task models may need it. When it detects another active session with a different Codex thread id and the same `cwd`, it writes an `adapter.workspace.concurrent_threads` entry to the bounded adapter transcript so operators can reconstruct overlap from `CODEX_ADAPTER_SUMMARY_PATH`.

Recommended production shape:

```sh
CODEX_ADAPTER_CODEX_HOME="$HOME/.codex"
CODEX_ADAPTER_ISOLATE_CODEX_HOME=false
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="$HOME/.codex/copilot-sdk-runtime-sessions.json"
```

Continuity proof is not "the app-server process is alive". The proof is that the adapter can recover the persisted mapping for the intended SDK session and workspace, then Codex accepts `thread/resume` for the mapped thread.

## Self-Reviewed Workspace Lane

The default adapter lane is intentionally bounded but usable for SDK clients that use broad permission handlers such as `approve_all`:

```sh
CODEX_ADAPTER_APPROVAL_POLICY=on-request
CODEX_ADAPTER_APPROVALS_REVIEWER=auto_review
CODEX_ADAPTER_SANDBOX_MODE=workspaceWrite
CODEX_ADAPTER_NETWORK_ACCESS=false
```

These are also the adapter defaults. The sandbox lets Codex work inside the explicit workspace without asking for every routine local action. Network access is disabled by default, but it is an explicit runtime knob rather than a permanent lock: set `CODEX_ADAPTER_NETWORK_ACCESS=true` when the selected product lane needs network-capable workspace execution. When a proposed action crosses the active sandbox boundary, such as writing outside the workspace or using blocked network access, `approvalPolicy=on-request` makes Codex ask for approval and `approvalsReviewer=auto_review` routes that request through Codex's reviewer agent instead of blindly forwarding it to the SDK permission handler.

Codex has two separate control planes here:

- `approvalPolicy` / `approvalsReviewer`: when a boundary crossing requires review, and who reviews it.
- `sandboxMode` / `sandboxPolicy`: what local filesystem and network boundary Codex is allowed to operate inside.

Auto-review is not a permission grant. It does not expand the workspace, enable network access, or weaken protected paths. It only reviews actions that already need approval. Actions that stay inside `workspaceWrite` proceed without extra review. If the runtime explicitly sets `CODEX_ADAPTER_NETWORK_ACCESS=true`, the same workspace sandbox is used, but `turn/start.sandboxPolicy.networkAccess` is set to `true`.

For a pure observation lane, explicitly set:

```sh
CODEX_ADAPTER_APPROVAL_POLICY=never
CODEX_ADAPTER_SANDBOX_MODE=readOnly
CODEX_ADAPTER_NETWORK_ACCESS=false
```

Use that read-only lane only when the product should not let Codex make workspace edits. For runtime agents expected to perform bounded work, the self-reviewed workspace lane is safer than SDK-side `approve_all` alone while still letting ordinary workspace-local actions complete.

## Tool Selection And Media Policy

The selected Chatpilot lane treats the 26 chatbot-visible SDK tools as the model-facing tool catalog. Phase 6 policy proof checks that tool names do not collide with known Codex native tools and that every tool has a safe selection benchmark prompt case.

External-side-effect tools must be benchmarked as `dry-run-only` unless the test harness replaces their handlers with safe fakes. Do not run WorkProof push, browser control, web search, schedule mutation, media download, document edit, or memory writes as uncontrolled production-like benchmark calls.

Multimodal tool-result output is not required for the selected profile:

- `batch_image_analyze` and `download_media` execute inside Chatpilot and must return text-to-LLM summaries when the model needs a result.
- `show_image` sends media to the user-facing conversation channel, not back into Codex as dynamic-tool image output.

If a future product path needs Codex to receive image/audio/file content directly as a dynamic-tool result, that is a new capability gate and must not be inferred from this profile.

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
CODEX_ADAPTER_MODEL=gpt-5.4-mini
CODEX_ADAPTER_APPROVAL_POLICY=on-request
CODEX_ADAPTER_APPROVALS_REVIEWER=auto_review
CODEX_ADAPTER_SANDBOX_MODE=workspaceWrite
CODEX_ADAPTER_NETWORK_ACCESS=false
CODEX_ADAPTER_REQUEST_TIMEOUT_MS=45000
CODEX_ADAPTER_TRANSCRIPT_LIMIT=500
CODEX_ADAPTER_SUMMARY_PATH=/tmp/codex-adapter-summary.json
CODEX_ADAPTER_FALLBACK_WORKSPACE_PARENT=/tmp/copilot-codex-adapter-workspaces
```

`CODEX_ADAPTER_REQUEST_TIMEOUT_MS` controls Codex request timeout and protocol-v3 pending dynamic tool timeout. `CODEX_ADAPTER_TRANSCRIPT_LIMIT` keeps adapter and gateway summaries bounded for long-running processes.

`CODEX_ADAPTER_NETWORK_ACCESS=false` is the safer default for production-like runs that do not need outbound network. Use `CODEX_ADAPTER_NETWORK_ACCESS=true` for runtime agents whose normal workspace task requires network access, and keep `CODEX_ADAPTER_SANDBOX_MODE=workspaceWrite` so local file operations stay scoped to the selected workspace.

For P0 observability, always set `CODEX_ADAPTER_SUMMARY_PATH` in staged/prod-like runs and retain process stdout/stderr. Live metrics or health endpoints remain a P2 follow-up until the deployment environment needs them; bounded transcript summaries are the current evidence contract.

When dynamic SDK tools run, inspect `semanticLog` first to verify routing and
tool outcome. `tool.routing:requested` includes `argumentsPreview`,
`argumentsPreviewRedacted`, and `argumentsPreviewTruncated`. `tool.sdk_result`
includes `resultPreview`, `resultPreviewRedacted`, and
`resultPreviewTruncated`. These fields are intentionally previews: common
secret-bearing keys and opaque token-like strings are redacted, long strings and
large collections are truncated, and ShinyiPilot remains the source for full
business-payload logs.

## Minimal Start Command

```sh
CODEX_ADAPTER_PORT=4873 \
CODEX_ADAPTER_PROTOCOL_VERSION=2 \
CODEX_ADAPTER_MODEL=gpt-5.4-mini \
CODEX_ADAPTER_CODEX_HOME="$HOME/.codex" \
CODEX_ADAPTER_ISOLATE_CODEX_HOME=false \
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH="$HOME/.codex/copilot-sdk-runtime-sessions.json" \
CODEX_ADAPTER_APPROVAL_POLICY=on-request \
CODEX_ADAPTER_APPROVALS_REVIEWER=auto_review \
CODEX_ADAPTER_SANDBOX_MODE=workspaceWrite \
CODEX_ADAPTER_NETWORK_ACCESS=false \
node dist/experimental/codexAdapterServer.js
```

Use `cliUrl: "127.0.0.1:4873"` from the SDK consumer.

## ShinyiPilot Python App Notes

The ShinyiPilot spike proves a Python app can use the local Python SDK source and
connect to a Codex adapter as an external Copilot-protocol runtime. The language
split is not the primary risk; the adapter must be deployed as a sidecar or
sibling service with explicit process ownership, start order, readiness, logs,
Codex auth home, and durable session-store policy.

For state-changing ShinyiPilot validation, prefer the Docker smoke lane above
before host-local or production deployment experiments. Host-local `4873` /
`29999` smokes are useful historical evidence, but the next production-safety
gate is containerized DB/log/adapter-summary read-back.

See
[shinyipilot-python-node-spike/spec.md](./shinyipilot-python-node-spike/spec.md)
for the spike commit, live CLI proof, and deployment notes.
