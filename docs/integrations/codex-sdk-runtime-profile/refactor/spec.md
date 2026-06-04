# Codex Runtime Adapter Refactor Spec

Created: 2026-06-03 17:02
Last Updated: 2026-06-03 22:19
Status: Active

## Purpose

This spec defines the architecture and testing contract for refactoring the Codex runtime adapter after the selected `SDK Core Profile + Coding Agent Profile` parity milestone.

The goal is to turn the successful spike-graduated adapter into a cleaner module shape without changing the scoped `Copilot SDK + Copilot CLI` behavioral contract.

## Max Implementation Principle

Refactor module boundaries while preserving the spike's functional completeness and correctness.

In practical terms:

- Functional behavior is protected first.
- Module shape is improved second.
- Tests must not lock in the current messy module boundaries.
- Boundary fitness functions should verify the target architecture after the relevant refactor phase, not pretend the current spike shape is already clean.

The first implementation moves should therefore add top-down functional characterization tests around stable inputs and outputs. Those tests should be large enough to prove behavior, but small enough to be easy to update when the internals are split.

## Refactor Method: Incremental Copy-Transfer

Use incremental copy-transfer instead of direct in-place extraction.

The live adapter behavior is the oracle and temporary integration scaffold. The authoritative source is the current exported adapter path in [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts), plus [nodejs/src/experimental/codexAdapterServer.ts](../../../../nodejs/src/experimental/codexAdapterServer.ts) for long-running backend mode, verified by selected-profile conformance and Chatpilot acceptance artifacts.

The older inline minimal implementation still present inside [nodejs/examples/copilot-codex-adapter-spike.ts](../../../../nodejs/examples/copilot-codex-adapter-spike.ts) is not the oracle. Do not copy from that stale inline harness code unless the behavior is first verified against the live adapter path.

The new refactor code should be built as clean, minimal modules with stable inputs and outputs. It is acceptable for the temporary bridge between old live adapter code and new modules to be a little dirty during development, as long as the new module interfaces stay clean and the dirty bridge has an explicit removal path.

Rules:

- Start from the smallest useful behavior brick.
- Copy or translate only the logic needed for that brick into a clean module boundary.
- Write a dedicated test for the new brick as soon as it exists.
- Insert the new brick back into the live adapter flow through the smallest temporary bridge possible.
- Run the Phase 1 functional no-regression suite after each insertion.
- Grow from brick tests to composed flow tests, then to full conformance and E2E evidence before closeout.
- Do not let temporary spike compatibility shapes become public new-module interfaces.
- Every duplicated adapter path must have an explicit deletion or replacement condition.

End state:

```text
live adapter behavior
  == preserved by functional characterization
  == reimplemented through clean mapper / gateway / facade / harness modules
  == proven by module tests + conformance + E2E evidence
```

## Audience And Scope

This spec is for the SDK/runtime-adapter implementation layer, not for teaching downstream applications how to use the Copilot SDK.

Primary audience:

- maintainers refactoring the Codex adapter module;
- reviewers checking adapter boundary, public exports, mapper/gateway separation, and conformance evidence;
- future runtime-backend implementers comparing Codex with another backend.

Non-audience:

- normal Copilot SDK consumers who only create sessions, send prompts, register tools, and read results.

For a normal SDK consumer, the intended experience after integration should remain essentially the same as using the SDK with the bundled Copilot CLI. At most, the consumer may opt into a configured runtime backend or adapter entrypoint. The consumer should not need to understand Codex app-server startup, JSON-RPC transport, protocol branches, transcript normalization, or gateway internals.

Therefore, this spec targets the internal implementation boundary:

```text
Copilot SDK public workflow
  -> experimental Codex adapter facade
  -> Codex adapter mapper / gateway internals
  -> Codex app-server runtime detail
```

When this document says "consumer-facing" or "SDK-facing", it means the stable SDK semantics observed by downstream app code. When it says "adapter", "mapper", or "gateway", it means implementation surfaces inside the experimental Codex runtime adapter.

## Source References

- SHIP: [../../../../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md](../../../../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md)
- Architecture boundary reference: [../../../reference/runtime-adapter-architecture-boundary.md](../../../reference/runtime-adapter-architecture-boundary.md)
- Design-pattern reference: [../../../reference/runtime-adapter-design-patterns.md](../../../reference/runtime-adapter-design-patterns.md)
- Testing evidence reference: [../../../reference/runtime-adapter-testing-evidence.md](../../../reference/runtime-adapter-testing-evidence.md)
- Boundary fitness status: [boundary-fitness.md](./boundary-fitness.md)
- Learning packet: [../learning-design-patterns-architecture-testing.md](../learning-design-patterns-architecture-testing.md)
- Prior cleanup draft, now absorbed by this spec/plan pair: [../module-cleanup-plan.md](../module-cleanup-plan.md)
- Runtime backend code map: [../../../architecture/runtime-backend-code-map.md](../../../architecture/runtime-backend-code-map.md)
- Runtime profile plan: [../plan.md](../plan.md)

## Current State

The current adapter path is behaviorally useful but structurally still carries spike gravity.

Important current surfaces:

- [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts)
- [nodejs/src/experimental/codexAdapterServer.ts](../../../../nodejs/src/experimental/codexAdapterServer.ts)
- [nodejs/examples/copilot-codex-adapter-spike.ts](../../../../nodejs/examples/copilot-codex-adapter-spike.ts)
- [nodejs/examples/chatpilot-runtime-acceptance.ts](../../../../nodejs/examples/chatpilot-runtime-acceptance.ts)
- [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts)

Current risk shape:

- `codexAdapter.ts` mixes facade, gateway, protocol conversion, session state, permission/tool mapping, and transcript summary.
- `copilot-codex-adapter-spike.ts` mixes scenario intent, backend process lifecycle, transcript normalization, assertions, report assembly, and evidence output.
- The package subpath `./experimental/codex-adapter` exposes the adapter boundary, but the public surface must be guarded against raw runtime implementation leakage.

## Boundary Contract

The runtime adapter boundary is a partial boundary, like an MVP customs counter. It protects SDK consumer-facing semantics from Codex runtime implementation mechanics.

Design rule:

```text
SDK consumer-facing semantics
  -> Runtime Adapter Workflow Contract
  -> Runtime Implementation Detail
```

Current module mapping:

| Boundary layer | Current module / surface | Refactor expectation |
|---|---|---|
| SDK consumer-facing semantics | SDK public root exports in [nodejs/src/index.ts](../../../../nodejs/src/index.ts), SDK-facing client/session behavior in [nodejs/src/client.ts](../../../../nodejs/src/client.ts) and [nodejs/src/session.ts](../../../../nodejs/src/session.ts), downstream usage through `CopilotClient` / `CopilotSession` | Keep normal SDK usage stable. Do not require SDK consumers to learn Codex app-server mechanics. |
| Runtime Adapter Workflow Contract | Experimental adapter subpath `./experimental/codex-adapter`, implemented today by [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts) and executable server wrapper [nodejs/src/experimental/codexAdapterServer.ts](../../../../nodejs/src/experimental/codexAdapterServer.ts) | Keep the public adapter facade/config/capability surface explicit and small. Move mapper and gateway internals behind adapter-local seams. |
| Runtime Implementation Detail | Codex app-server process and JSON-RPC protocol reached through the current `CodexAppServerClient` implementation inside [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts) | Treat as gateway/internal runtime detail. It may be test-injectable, but should not be public package API after cleanup. |
| Conformance / evidence surface | [nodejs/examples/copilot-codex-adapter-spike.ts](../../../../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../../../../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts) | Prove the same SDK-visible behavior, transcript/dataflow, side effects, and continuity after module cleanup. |

Allowed consumer-facing knowledge:

- A downstream app can know it is using an agent runtime.
- A downstream app can submit stable identity, prompt, tools, metadata, approval policy, and session context through SDK-shaped APIs.
- A downstream app can receive stable transcript, tool intent, completion, and error semantics.
- A downstream app may opt into a configured Codex adapter backend, but only through a stable SDK/adapter configuration surface.

Disallowed consumer-facing leakage:

- Downstream app code must not import Codex app-server internals.
- Downstream app code must not depend on provider-specific event unions, error enums, request methods, or protocol branches.
- Downstream app code must not choose Codex-specific endpoints or raw transport details.
- Public SDK root exports must not expose experimental runtime internals.

Experimental adapter subpath policy:

- `./experimental/codex-adapter` may expose the Codex adapter facade and explicitly documented adapter options/capabilities.
- It must not expose raw Codex app-server gateway classes, raw JSON-RPC message types, or provider-specific event/error unions as public API.
- Gateway internals may remain test-injectable through internal module seams, but they should not be part of the package public API contract.

## Design Pattern Contract

Patterns are justified only when they hide real knowledge or absorb a real source of variation.

### Mapper

Mapper modules are pure translation.

Allowed mapper responsibilities:

- Convert SDK session/tool/permission inputs into Codex runtime request shapes.
- Convert Codex approval/tool/event payloads into SDK-facing request/result shapes.
- Convert SDK tool results into Codex dynamic tool responses.
- Make protocol-v2/v3 differences explicit when those differences affect SDK-visible behavior.

Disallowed mapper responsibilities:

- Runtime IO.
- Session lifecycle mutation.
- Permission policy decisions.
- Logging side effects.
- Tool registry ownership.

### Gateway

Gateway modules touch the outside world.

Allowed gateway responsibilities:

- Start/stop Codex app-server.
- Send Codex app-server JSON-RPC requests, notifications, and responses.
- Receive runtime notifications and requests.
- Own timeout, process, connection, and low-level runtime failure behavior.
- Produce raw runtime transcript evidence.

Disallowed gateway responsibilities:

- SDK-facing semantic decisions.
- Chatpilot route, memory, or tool ownership.
- Public SDK workflow contract expansion.

### Facade

The adapter facade should make callers know less.

It should hide:

- Protocol-version handling.
- Low-level runtime request/response mechanics.
- Permission/tool conversion details.
- App-server transport details.

It should not hide:

- Unsupported capabilities.
- Meaningful runtime failures.
- Evidence needed for conformance and audit.

### Strategy / Policy

Do not introduce Strategy or Policy objects for single stable rules.

Strategy/Policy extraction is allowed only when there are real variants, such as:

- protocol-v2 vs protocol-v3 tool handling that materially differs;
- always-approve vs interactive vs deny-by-policy approval behavior;
- tool failure/deny behavior with distinct SDK-visible semantics.

## Testing Evidence Contract

Testing evidence must match feature intent.

Smoke proves the gate opens. Proof proves the traveler was processed correctly.

Required evidence model:

- L1 smoke is allowed during development but cannot be final completion evidence.
- L2 point evidence proves request/response or contract shape.
- L3 line evidence proves durable side effects can be read back from the owner.
- L4 cross-line evidence proves continuity across repeated, multi-turn, cross-session, cross-backend, or time-sensitive behavior.

Functional characterization order:

- Start at the largest practical in/out seam that ignores current internal module boundaries.
- Then add smaller tests only for stable behavior pockets that will survive refactor, such as mapper input/output semantics.
- Avoid writing exhaustive tests against the current mixed class structure, because that would preserve the wrong shape.
- Prefer tests that can remain correct after mapper/gateway/facade extraction with little or no rewrite.
- Reuse the Phase 1 functional characterization suite as the no-regression gate whenever a new copy-transfer module is inserted into the live adapter flow.
- New module tests should start narrow, then mature to full feature and E2E coverage before the old adapter path is removed.

Minimum rules:

- Mapper extraction needs L2 evidence.
- Tool, memory, file, log, or session artifact claims need L3 evidence.
- Session reuse/resume and cross-backend parity need L4 evidence.
- Normalization must preserve absence: missing evidence, unsupported behavior, parse failure, and runtime errors must remain visible.
- Tests should spy on semantic boundaries, not private implementation steps.

## Required Fitness Functions

The refactor is not complete unless it has explicit guards for clear boundary violations.

Required checks:

- Root SDK public exports do not expose experimental runtime adapter internals.
- Package `exports` do not expose new internal runtime implementation subpaths.
- Experimental Codex adapter public subpath does not export raw gateway classes or raw provider event/error types.
- App/downstream-facing code does not import Codex runtime implementation mechanics outside allowed adapter modules and examples.
- Conformance artifacts include transcript/dataflow/side-effect evidence, not just exit code or log presence.

## Success Criteria

This refactor succeeds when all of these are true:

- Existing selected-profile conformance still passes.
- Existing Chatpilot runtime acceptance still passes when SDK-visible behavior is touched.
- The adapter facade is smaller because translation and runtime IO knowledge moved behind explicit seams.
- Pure mapper logic can be tested without starting Codex app-server.
- Runtime gateway logic can be tested or faked without asserting mapper internals.
- Public export leakage checks pass.
- The conformance harness is split by evidence responsibility, not by old execution order.
- Unsupported and deferred capabilities remain explicit.

## Non-Goals

- Do not build a generic multi-runtime framework in this milestone.
- Do not make Chatpilot route identity, memory ownership, or tool registration a Codex adapter concern.
- Do not add Strategy/Policy interfaces for single-rule behavior.
- Do not weaken proof-level tests into smoke checks.
- Do not rewrite the entire harness before characterization evidence is locked.
