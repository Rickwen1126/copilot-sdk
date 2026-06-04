# Codex SDK Runtime Profile Plan

Created: 2026-06-01 11:21
Last Updated: 2026-06-01 14:05
Status: Draft

## Goal

Make the Codex adapter behaviorally indistinguishable from `Copilot SDK + Copilot CLI` for the selected Chatpilot runtime profile.

This means:

- SDK-facing behavior must match what an app observes through `CopilotClient` and `CopilotSession`.
- Codex app-server can have a different internal protocol, but the adapter must translate it into the same SDK-visible control flow, callback flow, event flow, and side-effect outcomes.
- Full Copilot CLI cloning is not the default goal. Any CLI capability becomes required only when the selected SDK runtime profile or Chatpilot product path actually consumes it.

## Target Profile

The first implementation target is:

- `SDK Core Profile`
- `Coding Agent Profile`

These are defined in [runtime-backends.md](../runtime-backends.md).

In practical terms, the first target includes:

- session creation, resume, message send, history replay, disconnect, and idle/error completion
- final assistant message behavior through `sendAndWait()`
- command/file approval flow through SDK permission handling
- custom tool call flow through SDK tool handlers
- tool result delivery back into the runtime
- deny-path correctness for permissions and tools

The following profiles remain capability-gated until Chatpilot needs them:

- `Interactive Profile`
- `Fidelity Profile`
- `Extended CLI Profile`

## Correctness Model

A test passes only when all four layers agree:

- **Trace completeness**: Codex app-server, adapter, and SDK-side callbacks all emit a correlated structured trace for the same run.
- **Dataflow correctness**: every critical request/response pair is mapped to the expected next hop with the expected payload shape.
- **Behavior correctness**: the SDK-visible result matches the result from `Copilot SDK + Copilot CLI` for the same scenario.
- **Intent correctness**: the side effect or refusal matches the test's intended policy, not merely the runtime's exit code.

Logs are therefore evidence, not the verdict by themselves. The verdict comes from machine-parsed trace assertions plus data-level assertions.

## Trace Contract

Every scenario must produce a normalized ledger with these fields:

- `runId`
- `backend`: `copilot-cli` or `codex-adapter`
- `sessionId`
- `turnId`
- `requestId`
- `source`: `sdk`, `adapter`, or `codex`
- `target`: `sdk`, `adapter`, or `codex`
- `method`
- `direction`: `request`, `response`, `notification`, or `event`
- `payloadShape`
- `sanitizedPayload`
- `resultShape`
- `timestamp`
- `durationMs`
- `status`: `ok`, `denied`, `error`, or `timeout`

The adapter should preserve enough payload detail to prove semantics while sanitizing secrets and large content. Large payloads may be represented by hashes plus selected structural fields.

## Baseline Oracle

Each conformance scenario should run twice:

1. Against real `Copilot SDK + Copilot CLI`
2. Against `Copilot SDK + Codex adapter + Codex app-server`

The harness then compares:

- normalized ledger sequence
- critical payload shapes
- SDK-observed events
- final SDK return values
- real side effects
- denial behavior

The comparison should allow runtime-specific implementation details, but not missing critical semantic steps.

## Required Scenarios

### 1. Core New Session

Intent: prove a fresh session behaves like Copilot CLI from the SDK's point of view.

Pass requirements:

- `session.create` succeeds
- `session.start` is observed
- `session.send` returns a message id
- `assistant.message` is observed
- `session.idle` is observed
- `sendAndWait()` returns the final assistant message
- trace shows the complete SDK -> adapter -> Codex -> adapter -> SDK chain

### 2. Resume And Stateful Continuation

Intent: prove resume is not only reconnect, but stateful continuation.

Pass requirements:

- first turn produces a deterministic value
- session disconnects
- a fresh SDK client resumes the same session id
- `getMessages()` includes prior user and assistant messages
- second turn depends on the previous answer
- trace proves events were replayed or reconstructed intentionally

### 3. Command Approval Happy Path

Intent: prove side-effect approval can pass through the SDK permission handler.

Pass requirements:

- Codex emits command approval request
- adapter maps it to SDK permission request
- SDK handler returns approved
- adapter maps the result back to the Codex decision shape
- Codex executes the command
- SDK observes completion and idle
- data-level assertion verifies the side effect, such as exact file contents

### 4. Command Approval Assertive Path

Intent: prove the adapter is not passing through malformed or semantically wrong requests.

Pass requirements:

- SDK permission handler asserts `kind`, command text, paths, and relevant request metadata
- handler approves only if the request shape matches the expected scenario
- any mismatch fails the test before the side effect executes

### 5. Command Approval Deny Path

Intent: prove deny policy is honored and does not silently execute.

Pass requirements:

- SDK permission handler denies the request
- adapter maps denial back to Codex
- Codex does not execute the side effect
- SDK receives a coherent completion/error event
- data-level assertion proves the forbidden file/process/network side effect did not happen

### 6. File Change Approval

Intent: prove file write/edit approvals map correctly, not only shell command approvals.

Pass requirements:

- Codex file-change approval request is captured
- adapter maps it to an SDK permission request with file/write semantics
- approve and deny paths are both tested
- data-level assertions verify exact file content or absence of modification

### 7. Custom Tool Call

Intent: prove SDK tool handlers can act as Chatpilot runtime tools through the adapter.

Pass requirements:

- app registers a custom SDK tool
- runtime requests that tool
- adapter maps the runtime request to the SDK tool handler path
- SDK handler receives expected args and invocation metadata
- tool result returns to Codex
- final assistant turn completes after the runtime receives the tool result
- trace includes request, handler result, runtime continuation, and final message
- exact final assistant wording is recorded as evidence, but is not a protocol gate; real `Copilot SDK + Copilot CLI` can transform the final answer even when the SDK handler result was delivered correctly

### 8. Tool Deny Or Failure Path

Intent: prove failed or unavailable tools do not become silent success.

Pass requirements:

- denied tool result and throwing tool handler cases are distinguishable
- SDK-visible events represent failure correctly
- Codex receives a result that lets the turn continue or fail intentionally
- final assertion checks behavior, not only event presence
- missing/unavailable tool behavior remains an adapter hardening case unless the selected SDK runtime profile exposes a real app-level path that can request an unregistered tool

## Optional Scenarios

These should not block the first goal, but should be added when the profile expands:

- user input request
- elicitation request and response
- attachment handling
- streaming message deltas
- reasoning deltas
- usage events
- MCP discovery and runtime MCP calls
- custom agents and skills
- session workspace / plan / shell RPC escape hatches

## Conformance Report

Every full run should emit a machine-readable report with this matrix:

| Capability | Copilot CLI baseline | Codex adapter | Trace parity | Data assertion | Intent assertion | Status |
|---|---|---|---|---|---|---|
| core new session | required | required | required | required | required | pass/fail |
| resume continuation | required | required | required | required | required | pass/fail |
| command approval approve | required | required | required | required | required | pass/fail |
| command approval deny | required | required | required | required | required | pass/fail |
| file approval approve/deny | required | required | required | required | required | pass/fail |
| custom tool call | required | required | required | required | required | pass/fail |
| tool deny or failure | required | required | required | required | required | pass/fail |

The report must fail if:

- a critical trace hop is missing
- a payload shape is incompatible with the SDK expectation
- the SDK-visible event sequence diverges in a behaviorally meaningful way
- a side effect is missing when it should happen
- a side effect happens when it should be denied
- the test only proves process exit code or log presence

## Definition Of Done

The Codex adapter can claim parity for the first target only when:

- all required scenarios pass against both baseline and adapter
- the normalized ledgers are retained as artifacts
- side effects are verified at data level
- denial paths are verified at data level
- the conformance report clearly states which SDK runtime profile is covered
- unsupported profiles are explicitly marked as not covered, not silently ignored

## Current Implementation Status

As of 2026-06-01 14:05:

- `copilot-codex-adapter-spike.ts` emits a first `conformanceReport`.
- The Codex bridge is now a reusable experimental Node module:
  - module: [nodejs/src/experimental/codexAdapter.ts](../../../nodejs/src/experimental/codexAdapter.ts)
  - package subpath: `./experimental/codex-adapter`
  - primary API: `CodexCopilotAdapterServer`
  - transport API: `CodexAppServerClient`
  - client helper: `createCodexCopilotClientOptions`
  - capability flags: `CODEX_ADAPTER_CAPABILITIES`
- The conformance harness now instantiates `CodexCopilotAdapterServer`; it no longer proves only an inline example-local class.
- The report includes normalized ledgers for `copilotCli` and `codexAdapter`.
- The report includes `ledgerCounts` for both backends.
- The report includes per-capability `backendStatus`, so an adapter-only run can show Codex progress while the full verdict remains `not-run` until baseline scenarios exist.
- `SPIKE_PHASE=none` validates report generation without starting either runtime.
- Custom SDK tools now bridge through Codex app-server dynamic tools:
  - Codex `thread/start.experimental.dynamicTools` registers SDK tool descriptors.
  - Codex `item/tool/call` maps to SDK `external_tool.requested`.
  - SDK `session.tools.handlePendingToolCall` maps back to Codex `DynamicToolCallResponse`.
  - The adapter emits `external_tool.completed` after returning the tool result.
- Tool failure/denial now covers:
  - throwing SDK tool handler
  - SDK tool handler returning `resultType: "denied"`
  - adapter mapping both cases to Codex `success: false`
  - final assistant completion after the runtime receives the failure/denial result
- `SPIKE_PHASE=adapter` live-smoke proves the Codex adapter side of:
  - core new session
  - resume continuation
  - command approval approve
  - command approval deny
  - file approval approve/deny
  - custom tool call
  - tool deny/failure
- `SPIKE_PHASE=record` records the matching real `Copilot SDK + Copilot CLI` baseline for core/resume and any enabled approval/file/tool probes.
- `SPIKE_PHASE=all` currently produces cross-backend conformance artifacts. Current passing capabilities:
  - `core new session`
  - `resume continuation`
  - `command approval approve`
  - `command approval deny`
  - `file approval approve/deny`
  - `custom tool call`
  - `tool deny/failure`
- The current best full artifact is `/tmp/copilot-codex-all-tool-failure-20260601-v1.json`:
  - `conformanceReport.verdict = "pass"`
  - `ledgerCounts.copilotCli = 417`
  - `ledgerCounts.codexAdapter = 1621`
  - command approve verifies exact fresh `hello` file contents on both backends
  - command deny verifies the denied marker file does not exist on both backends
  - file approve verifies exact fresh `file-approval-hello\n` file contents on both backends
  - file deny verifies the denied file does not exist on both backends
  - custom tool verifies SDK handler args, tool name, tool call id, handler result, `session.tools.handlePendingToolCall`, `external_tool.completed`, and final assistant completion on both backends
  - custom tool exact final wording is intentionally recorded but not used as a protocol pass gate:
    - baseline `finalUsesResult = false`, because real Copilot CLI transformed the final assistant text after receiving the correct handler result
    - adapter `finalUsesResult = true`
    - both backends delivered the expected handler result hash `f6ae7fa8edcf41fc`
  - tool deny/failure verifies both throwing and denied-result SDK tool handlers on both backends:
    - failure error hash: `578d4872efdcf06b`
    - denied result hash: `336e1a265f8ce513`
- `SPIKE_ADAPTER_APPROVAL_POLICY=untrusted` plus `SPIKE_ADAPTER_APPROVALS_REVIEWER=user` is required for deterministic Codex command approval conformance. `on-request` is not a stable gate because Codex can execute some shell commands without surfacing `item/commandExecution/requestApproval`.
- File approval maps Codex `item/fileChange/requestApproval` to SDK `permission.request(kind=write)` and maps SDK denial back to Codex `decision: "decline"`.
- The real Copilot CLI baseline may emit a `read` permission before the `write` permission for file denial; conformance allows read preflight but requires a write permission decision and data-level write blocking.
- Stage 3 conformance for the selected `SDK Core Profile + Coding Agent Profile` is satisfied. The remaining work is graduation and integration, not more spike proof for the selected profile.
- Stage 4 adapter graduation is satisfied for the repo-local experimental boundary. The remaining work is downstream Chatpilot runtime node integration and final milestone closeout.
- Current adapter-module proof artifact:
  - `/tmp/copilot-codex-all-module-20260601-v1.json`
  - `conformanceReport.verdict = "pass"`
  - `ledgerCounts.copilotCli = 412`
  - `ledgerCounts.codexAdapter = 1801`
  - all required capabilities pass on both backends
- Runtime-node integration now has a minimal downstream seam:
  - `nodejs/src/experimental/codexAdapterServer.ts` runs the adapter as a long-lived Copilot-protocol TCP server.
  - `nodejs/package.json` exposes the runner as `copilot-codex-adapter`.
  - Chatpilot `src/chatpilot/sdk/session.py` can select an external Copilot-protocol backend with `CHATPILOT_COPILOT_CLI_URL`.
  - Chatpilot can label the backend with `CHATPILOT_RUNTIME_BACKEND=codex-adapter` without changing app-level routing, execution identity, memory ownership, or tool registration.
  - The adapter supports protocol v3 by default for the current Node SDK conformance harness.
  - The adapter supports protocol v2 with `CODEX_ADAPTER_PROTOCOL_VERSION=2` for Chatpilot's current Python SDK package.
  - Protocol v2 custom tools use SDK `tool.call` request/response instead of v3 `external_tool.requested` + `session.tools.handlePendingToolCall`.
  - SDK `system_message.mode=replace` content is mapped to Codex `thread/start.baseInstructions`.
- Downstream Chatpilot smoke evidence:
  - Adapter command:
    `CODEX_ADAPTER_PORT=4873 CODEX_ADAPTER_PROTOCOL_VERSION=2 CODEX_ADAPTER_APPROVAL_POLICY=never CODEX_ADAPTER_SANDBOX_MODE=readOnly CODEX_ADAPTER_MODEL=gpt-5.4 CODEX_ADAPTER_CLIENT_NAME=chatpilot-smoke node dist/experimental/codexAdapterServer.js`
  - Chatpilot env:
    `CHATPILOT_RUNTIME_BACKEND=codex-adapter CHATPILOT_COPILOT_CLI_URL=127.0.0.1:4873`
  - `SdkClient` new-session + `send_and_wait()` returned `chatpilot-codex-adapter-smoke`.
  - Custom tool smoke invoked the Python SDK handler exactly once with `tool_name=protocol_smoke` and `arguments={"marker":"chatpilot"}`.
  - Custom tool smoke final result was `tool-smoke-result-42`.
  - Post-compat adapter-only regression artifact: `/tmp/copilot-codex-adapter-post-v2-compat-20260601-v1.json`.
  - The post-compat adapter-only artifact has all Codex adapter backend statuses passing for core new session, resume continuation, command approval approve/deny, file approval approve/deny, custom tool call, and tool deny/failure.
- Downstream Chatpilot app-level acceptance now has a reusable harness:
  - harness: [nodejs/examples/chatpilot-runtime-acceptance.ts](../../../nodejs/examples/chatpilot-runtime-acceptance.ts)
  - command:
    `CHATPILOT_ACCEPTANCE_BACKENDS=all CHATPILOT_ACCEPTANCE_OUT=/tmp/chatpilot-codex-phase6-all-20260601-v1.json npx tsx examples/chatpilot-runtime-acceptance.ts`
  - artifact: `/tmp/chatpilot-codex-phase6-all-20260601-v1.json`
  - `status = "pass"`
  - both `copilot-cli` and `codex-adapter` pass the same isolated Chatpilot `/cli/chat` flow:
    - first turn creates or resumes a stable SDK session for a fresh `cli:<user>` route
    - first turn invokes `save_memo`
    - SQLite `memory_memos` contains the exact marker for that route
    - second turn reuses the same app-level runtime session
    - second turn invokes `list_memos`
    - final response includes the persisted marker
  - cross-backend assertions pass:
    - both backends pass the same app-level flow
    - both backends persist one or more memo rows for their route
    - both backends use the same SDK-visible `save_memo` and `list_memos` tool intents
  - adapter-specific assertion passes:
    - adapter summary contains both Codex `item/tool/call` and protocol-v2 SDK `tool.call`
- Milestone closeout artifacts are now in place:
  - canonical spec: [docs/spec.md](../../spec.md)
  - architecture diagram: [docs/architecture/skyeye.html](../../architecture/skyeye.html)
  - code map: [docs/architecture/runtime-backend-code-map.md](../../architecture/runtime-backend-code-map.md)
  - conformance artifact index: [conformance-artifacts.md](./conformance-artifacts.md)
  - unsupported capability notes: [unsupported-capabilities.md](./unsupported-capabilities.md)
  - completed todo archive: [docs/todo-finished.md](../../todo-finished.md)

## Graduation And Integration Roadmap

This plan is intended to carry the work from spike to integration completion.

### Stage 1: Profile Lock

Lock the selected target as `SDK Core Profile + Coding Agent Profile`. Any behavior outside that profile remains capability-gated unless a Chatpilot path directly consumes it.

Stage exit:

- the selected profile is named in the conformance report
- unsupported profiles are documented as unsupported or deferred
- the goal cannot be misread as full Copilot CLI parity

### Stage 2: Conformance Harness

Build the baseline-vs-adapter testing loop before expanding adapter capability.

Stage exit:

- the same scenario can run against `Copilot SDK + Copilot CLI`
- the same scenario can run against `Copilot SDK + Codex adapter + Codex app-server`
- both runs produce normalized ledgers and machine-readable verdicts

### Stage 3: Adapter Capability Iteration

Iterate on the adapter until the selected profile passes the conformance gate. Scenario details may change as real protocol behavior is discovered; the stable requirement is the correctness model, not a frozen checklist.

Stage exit:

- required scenarios pass with trace, dataflow, behavior, and intent assertions
- data-level side effects and deny paths are verified
- gaps are either fixed or explicitly moved out of the selected profile

### Stage 4: Adapter Graduation

Move from experiment to reusable adapter boundary.

Stage exit:

- the bridge is no longer only an example script
- the adapter has a named API/module boundary
- capability flags are explicit
- unsupported behavior is documented

### Stage 5: Runtime Node Integration

Integrate the adapter into the target runtime node without leaking vendor-specific semantics into the app substrate.

Stage exit:

- the downstream runtime can switch between Copilot and Codex backends
- app-level routing, execution identity, memory ownership, and policy semantics remain stable
- SDK-level downstream smoke proves new session, send/wait, and custom tool dataflow through the runtime seam

### Stage 6: Downstream Acceptance

Run real Chatpilot new-session and run-session flows through the runtime switch and compare them against the same selected SDK profile.

Stage exit:

- real new-session and run-session flows pass the conformance gate
- Chatpilot logs can correlate route/runtime/session/tool dataflow across SDK, adapter, and Codex app-server
- behavior-intent assertions prove the runtime did the expected thing, not merely that a process returned text

### Stage 7: Milestone Closeout

Close the integration as a documented project milestone.

Stage exit:

- canonical spec reflects the implemented behavior
- architecture diagram and code map/CodeTour are updated
- conformance artifacts are retained or linked
- active todos are moved to `docs/todo-finished.md` with enough context to audit later

## Immediate Next Steps

1. Preserve the conformance harness as the adapter module's regression gate.
2. Keep raw runtime transcripts available for debugging, but treat the machine-readable reports and data assertions as the durable conformance artifacts.
3. Treat Gemini CLI, Opencode, OpenClaw-core reuse, and AgentAPI as post-graduation backend candidates, not blockers for this milestone.
