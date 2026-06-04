# Codex Adapter Production Readiness

Created: 2026-06-04 19:53
Last Updated: 2026-06-04 21:03
Status: Active production gate input — Phase 3.5 capability spike complete, Phase 4 re-planned from evidence

## Purpose

This document is the production-readiness inventory for the Codex adapter, captured for handoff to the adapter refactor session. It enumerates concrete gaps between the current spike-grade adapter and the bar required to run Chatpilot's live `localhost:2999` runtime on the Codex backend.

The list is grouped by category, severity-marked, and cross-referenced to specific code locations. Each item is intended to be directly actionable in the refactor session without re-deriving context.

## Decision Context

The driver for moving Codex adapter from spike to production is constraint-bound, not aesthetic:

- The user wants Chatpilot to be driven by a ChatGPT Plus/Pro subscription, not a metered OpenAI API key.
- The only ToS-compliant officially-supported path for using a ChatGPT subscription programmatically is the OpenAI `codex` CLI (`codex login` against ChatGPT account; usage flows from the subscription quota).
- Copilot CLI BYOK requires an OpenAI API key and does not accept ChatGPT subscription auth.
- Reverse-proxy and chatgpt.com-scraping frameworks (PandoraNext, ChatBox / OpenClaw, etc.) violate OpenAI ToS and are not acceptable for the 24/7 commercial Chatpilot deployment.

This means the Codex adapter path is not an experimental option — it is the unique path that satisfies the subscription constraint. Therefore the adapter must reach production grade. The architectural choice of keeping the adapter at the Copilot SDK protocol seam (rather than refactoring Chatpilot to own a `RuntimeBackend` abstraction) remains correct for now; revisit only when one of the deferred triggers in [runtime-backends.md](../runtime-backends.md) fires.

## Operational Pre-Requisite

Before the adapter starts in any environment, the operator must run:

```bash
codex login   # authenticate with the ChatGPT account that holds the Pro plan
```

This populates `~/.codex/auth.json`. The adapter's `prepareCodexHome` in `nodejs/src/experimental/codexAppServerGateway.ts:75-95` copies `auth.json`, `config.toml`, `installation_id`, `models_cache.json` into an isolated adapter home, so the spawned `codex app-server` inherits the ChatGPT subscription auth. Without this pre-step, the adapter has no usable credentials.

This pre-step belongs in the production runbook and the development setup doc, not implicit knowledge.

## Runtime Identity Model

Use this model when implementing A1/A4/A5 and when reviewing any future wording about "Codex session" behavior:

```text
Copilot SDK session
  -> adapter SessionState
  -> Codex thread
  -> Codex turns

Codex app-server process
  -> owns / loads many Codex threads
```

Precise meanings:

- **Codex app-server process** — the long-running runtime process spawned by the adapter gateway. It is the "station", not the traveler. One adapter gateway process should normally own one app-server process.
- **Codex thread** — the durable Codex agent session. In task semantics, this is closest to a Codex CLI session. A thread has its own `threadId`, rollout file, cwd/model/tool context, and turns.
- **Copilot SDK session** — the app-facing session id seen by Chatpilot / SDK consumers. The adapter maps it to one Codex thread unless a resume/tool-set policy explicitly forks or recreates the thread.
- **Codex turn** — one user prompt / model run inside a Codex thread. A no-turn thread may have a `threadId` and planned rollout path, but no persisted rollout file yet.

Therefore, the intended production model is **one app-server process, many Codex threads**, not one app-server process per SDK session. The careful wording is: `session.create` must not spawn a new `codex app-server` process per session; it should create or resume a Codex thread under the already-running app-server.

This distinction matters for restart continuity:

- App-server health only proves the station is open.
- A persisted `(sdkSessionId, codexThreadId, cwd, model, tool fingerprint, runtime home identity)` mapping proves the adapter knows which traveler to load.
- A successful `thread/resume` or `thread/read` proves the Codex thread was actually loaded from persisted rollout state.

Phase 4 must treat `thread/resume` / `thread/read` as the continuity proof. Merely checking that the app-server process exists is insufficient.

## Tool Execution Model (Confirmed Invariant)

For the refactor session: the tool execution model has been verified equivalent between Copilot CLI and Codex adapter paths.

- Tools registered in `session.create` reach Codex as `dynamicTools` descriptors only (name, description, inputSchema). No implementation reference crosses the boundary.
- When the Codex model emits `item/tool/call`, the adapter translates it to a Copilot SDK protocol tool request and forwards it back to the Chatpilot Python process.
- Chatpilot's Python handler executes inside the Chatpilot process (DB access, observers, async pipeline, all local).
- The result returns through `session.tools.handlePendingToolCall` and is translated back to a Codex tool response.

Adapter is pure passthrough + format translation on the tool path. Chatpilot's 26 builtin tools run where they always ran. The gaps below are about translation fidelity, lifecycle hygiene, and surface-level model behavior controls — not about execution location.

## Issue Inventory

### A. Process / Session Lifecycle

| ID | Severity | Issue | Code Location | Root Cause |
|---|---|---|---|---|
| A1 | P0 | `session.destroy` does not notify Codex to end the thread | `nodejs/src/experimental/codexAdapter.ts:735-748` `handleSessionDestroy` | Only clears adapter-local maps; the Codex thread keeps living inside app-server as an orphan |
| A2 | P0 | `this.sessions` Map entry never deleted on destroy | Same | Only `threadToSession` is cleaned; main session table accumulates indefinitely |
| A3 | P1 | `transcript` arrays grow unbounded in both adapter and gateway | `nodejs/src/experimental/codexAdapter.ts` + `codexAppServerGateway.ts:132,175,203,236,256,272` | Long-lived server with append-only transcript and no ring buffer / size cap |
| A4 | P0 | Adapter restart loses all sessions; resume returns "Unknown session" even when Codex's `sessions/` dir still has the thread | `codexAdapter.ts:626-629` `handleSessionResume` | `sessions` Map is in-memory only; no `(sessionId, threadId, cwd, model, tools)` persistence |
| A5 | P1 | Codex app-server crash has no supervisor / restart strategy | `codexAppServerGateway.ts:155-165` `child.on("exit")` | Pending requests are rejected, but subsequent requests permanently throw `"codex app-server is not started"`; adapter does not self-heal |
| A6 | P1 | No multi-session concurrent acceptance test | `nodejs/examples/chatpilot-runtime-acceptance.ts` | Current harness validates only single-session new-session + run-session; behavior under N route concurrent send is unverified |

### B. Tool Protocol Fidelity (SDK ↔ Codex translation)

| ID | Severity | Issue | Code Location | Root Cause |
|---|---|---|---|---|
| B1 | P0 | SDK `excluded_tools` / `available_tools` not forwarded to Codex | `codexAdapter.ts:545-556` `thread/start` params | Adapter does not read these SDK parameters; Chatpilot's standard mechanism to suppress backend native tools (shell, file edit) is silently dropped on the Codex lane. Requires investigating whether Codex `thread/start` exposes an equivalent surface; if yes, map to it; if no, fall back to forced sandbox lockdown |
| B2 | P0 | `session.resume` does not sync updated dynamic tools to the Codex thread | `codexAdapter.ts:616-674` `handleSessionResume` | Only `cwd` and `model` are updated; `session.tools` and the Codex thread's `dynamicTools` are not refreshed. Chatpilot's per-route session reuse with different chatbot tool sets will surface stale tools |
| B3 | P1 | `pendingDynamicToolCalls` Map has no TTL | `codexAdapter.ts:213` + `handlePendingToolCall` | A slow Python tool that never returns leaves the Map entry forever, which also blocks the Hub's busy/idle gate on that route |
| B4 | P1 | Tool result `JSON.stringify` fallback leaks internal structure to the LLM | `codexAdapterMappers.ts:67-70` `mapSdkToolResultToCodexDynamicToolResponse` | If a Python tool returns a dict without `textResultForLlm`, the entire dict is `JSON.stringify`ed into `inputText`. Internal field names, IDs, ordering all reach the model, hurting reasoning quality and consuming context tokens |
| B5 | P0 | 24 of 26 Chatpilot builtin tools have no schema round-trip acceptance against Codex | Conformance harness only covers `save_memo` / `list_memos` | Python pydantic → JSON Schema → Codex `dynamicTools.inputSchema` fidelity is unverified for the other 24 tools (anyOf, oneOf, $ref, Literal, Optional handling can each silently misbehave) |
| B6 | P1 | Tool name namespace not audited against Codex native tools | N/A — missing check | Chatpilot tools named like `shell`, `read_file`, etc. would collide with Codex builtins; behavior is undefined |
| B7 | P2 | Tool result supports only `inputText` (no multimodal output) | `codexAdapterMappers.ts:48-87` | If a Chatpilot vision tool needs to return an image to the model, there is no path |

### C. Model Behavior Control (prompt and sandbox configuration)

| ID | Severity | Issue | Code Location | Root Cause |
|---|---|---|---|---|
| C1 | P0 | Codex sandbox + Chatpilot `PermissionHandler.approve_all` interaction is not locked down | Chatpilot side: `src/chatpilot/sdk/session.py` permission handler. Adapter side: `codexAdapter.ts:545-556` sandbox / approvalPolicy passthrough | If the Codex sandbox is not forced to `readOnly` with `networkAccess: false` for the Chatpilot lane, and the Codex model decides to invoke its native `local_shell` or `apply_patch`, Chatpilot's `approve_all` will auto-approve the request. This is a real RCE-shaped risk for the LINE chatbot use case where no shell execution should ever happen. Mitigation depends on B1 (`excluded_tools` forwarding) — if B1 cannot fully disable native tools, C1 hardening becomes mandatory |
| C2 | P0 | No tool-call compliance benchmark | N/A — missing test | The two backends have different model priors (Copilot CLI's default agent vs Codex's coder-leaning agent). Same input may yield different tool-call decisions. Without measuring the rate at which each lane correctly selects Chatpilot's intended tool over Codex native tools or text-only answers, the production gate is uninformed. Benchmark: representative LINE-style prompts per tool, N runs each, two lanes, accuracy table |
| C3 | P1 | Chatpilot `system_message` may need strengthening against Codex's coder prior | `src/chatpilot/sdk/session.py` create_session, flows to `baseInstructions` in `codexAdapter.ts:543,554` | Chatpilot's system message becomes Codex's `baseInstructions`, but Codex layers its own internal agent prompt on top. Explicit instructions ("you are a chat assistant, not a coding agent; prefer the listed SDK tools; do not attempt shell") may be needed to compete |
| C4 | P1 | The 26 tool `description` fields are not audited for model selection effectiveness | `codexAdapterMappers.ts:36-44` `dynamicToolsFromDescriptors` — falls back to `SDK tool ${name}` when description is missing | Codex model selects tools based on description text. Single-line descriptions hurt selection accuracy. Audit and rewrite each tool's description to be selection-quality |

### D. Operational and Deployment

| ID | Severity | Issue | Location | Root Cause |
|---|---|---|---|---|
| D1 | P0 | `codex login` operational workflow not documented as required pre-step | Missing from `docs/integrations/` | Operators / developers must `codex login` with the ChatGPT Pro account before adapter starts. No runbook captures this today |
| D2 | P1 | `~/.codex/auth.json` inheritance into adapter isolated home not validated for production | `codexAppServerGateway.ts:87-95` `prepareCodexHome` | The copy step is mechanically present but production validation of Pro-subscription token inheritance and refresh flow is missing |
| D3 | P2 | Adapter and Codex app-server processes are not integrated into Chatpilot's observability | N/A — no metric / health endpoint | Adapter transcript is only dumped on SIGTERM via `CODEX_ADAPTER_SUMMARY_PATH`; no live metric, no health endpoint, no log forwarding into Chatpilot's existing observability surfaces |

## Severity Summary

- **P0 (correctness / safety / blocking): 9** — A1, A2, A4, B1, B2, B5, C1, C2, D1
- **P1 (stability / maintainability): 9** — A3, A5, A6, B3, B4, B6, C3, C4, D2
- **P2 (nice-to-have): 2** — B7, D3

Total tracked issues: 20.

## Comparison Against Copilot CLI Lane

- **Category A** — Copilot CLI lane does not face these issues; Microsoft handles process management and persistence internally. These are mandatory spike-to-production gaps for the adapter.
- **Category B** — Copilot CLI also performs protocol translation but Microsoft owns the translation. Adapter introduces a new translation layer, so these are new risks specific to this path.
- **Category C** — Both lanes face the same fundamental model-prior issue (any LLM has training-derived agent identity). The lanes differ in *configurability* of native-tool suppression: Copilot SDK's `excluded_tools` reaches Copilot CLI cleanly, but B1 must be resolved for parity on the Codex lane. Once B1 is closed, the remaining gap reduces to prompt tuning (C3, C4).
- **Category D** — Specific to the Codex lane because Copilot CLI does not require `codex login` (it uses GitHub auth).

## Spike Classification

Phase 3.5 is complete. Evidence summary:

- Spike artifact: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Probe script: [nodejs/examples/codex-app-server-capability-spike.ts](../../../nodejs/examples/codex-app-server-capability-spike.ts)
- Raw live artifact: `/tmp/codex-app-server-capability-spike-20260604-live.json`
- Codex CLI: `codex-cli 0.137.0`
- Upstream source clone checked for protocol shape: `/private/tmp/openai-codex-capability-spike-20260604`, commit `16d02ec`

Results:

- **A1 (partial-supported)** — no `thread/end` or `thread/close` request exists. Use `thread/unsubscribe` for listener detach and `thread/archive` for persisted-thread cleanup after a rollout exists.
- **A4 (supported-with-condition)** — Codex can resume a non-ephemeral thread by id across app-server restart after at least one turn persists a rollout file. The no-turn probe failed with `no rollout found`, which is expected and is not evidence against resume.
- **B1 / C1 (partial-supported)** — Codex does not expose SDK-shaped `available_tools` / `excluded_tools`. The available controls are sandbox, permission profiles, config, and `dynamicTools` on `thread/start`. Phase 4 must implement the locked Chatpilot lane with those controls, then benchmark native-tool suppression.
- **B2 (unsupported)** — upstream `ThreadStartParams` supports `dynamic_tools`, but `ThreadResumeParams` does not. A live `thread/resume` request carrying `dynamicTools` succeeds, which should be treated as unknown-field tolerance or ignored field behavior, not tool refresh support.
- **D2 (basic-supported)** — isolated `CODEX_HOME` copied from the logged-in source can start app-server and `account/read` succeeds. Token refresh / 401 recovery still needs later production-like validation.

The following items do not need feasibility spike and should be implemented or tested in their assigned phase:

- **Phase 4 session/facade workflow** — A2, A3, A5, B3, B4, plus A1/A4/B1/B2/C1 after the spike defines the supported path or fallback.
- **Phase 5 proof infrastructure** — A6, B5, C2.
- **Phase 6 policy / behavior controls** — B6, B7, C3, C4.
- **Operational docs / observability** — D1 directly, D3 when the production lane needs live observability.

## Suggested Execution Order

The order below minimizes rework — close protocol surfaces and lifecycle correctness before benchmarking or prompt tuning.

1. **Phase 4 session lifecycle and tool-set policy** — implement A1/A2/A4/B2 from the Phase 3.5 evidence: non-ephemeral persisted sessions for resumable production threads, explicit unsubscribe/archive lifecycle, and recreate/fork/reject policy for incompatible tool-set resume.
2. **B1 / C1** — implement locked Chatpilot lane through Codex sandbox / permission profile / config controls, then benchmark whether native tools are effectively suppressed.
3. **A3, A5, B3, B4** — lifecycle stability cleanup: transcript caps, app-server supervisor, pending tool TTL, and safe tool-result text extraction.
4. **D1** — write `codex login` runbook so subsequent validation can be reproduced.
5. **Phase 5 proof expansion** — A6, B5, and C2: multi-session concurrent acceptance, 26-tool schema round-trip, and tool-call compliance benchmark.
6. **Phase 6 policy / behavior controls** — B6, B7, C3, C4, D2, D3, including auth refresh validation and observability once the production lane is structurally correct.

## Validation Gates Before Production

Before flipping Chatpilot's live `2999` runtime from Copilot CLI lane to Codex adapter lane:

- All P0 items closed with evidence in `conformance-artifacts.md`
- C2 benchmark shows tool-call compliance within an acceptable delta vs Copilot CLI lane (acceptable delta to be defined by the user — proposed default: within 5 percentage points across all 26 tools)
- Multi-session concurrent acceptance (A6) passes
- Adapter survival across `codex app-server` crash (A5) demonstrated in a staged environment
- `codex login` runbook (D1) executed by someone other than the original author

## Cross-References

- Canonical spec: [docs/spec.md](../../spec.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](../runtime-backends.md)
- Existing conformance index: [conformance-artifacts.md](./conformance-artifacts.md)
- Unsupported capabilities (current scope): [unsupported-capabilities.md](./unsupported-capabilities.md)
- Current adapter spec / plan: [plan.md](./plan.md)
- Architecture diagram: [docs/architecture/skyeye.html](../../architecture/skyeye.html)
- Code map: [docs/architecture/runtime-backend-code-map.md](../../architecture/runtime-backend-code-map.md)
- Adapter module: `nodejs/src/experimental/codexAdapter.ts`
- Adapter mappers: `nodejs/src/experimental/codexAdapterMappers.ts`
- Adapter server bin: `nodejs/src/experimental/codexAdapterServer.ts`
- Codex app-server gateway: `nodejs/src/experimental/codexAppServerGateway.ts`
- Chatpilot SDK seam: `~/code/shinyipilot/src/chatpilot/sdk/session.py`

## Open Questions For The Refactor Session

Phase 3.5 resolved the initial protocol feasibility questions:

1. Native tool exclusion is not SDK-shaped. Phase 4 must choose the concrete sandbox/profile/config mapping and benchmark behavior.
2. There is no `thread/end` / `thread/close`; lifecycle must use `thread/unsubscribe` and `thread/archive`.
3. Resume by id across app-server restart works after a non-ephemeral thread has at least one persisted turn.
4. There is no supported `dynamicTools` update surface after `thread/start`; incompatible resume must recreate/fork or reject.
5. Isolated auth inheritance has a basic positive result; token refresh / 401 recovery remains a later production validation.
