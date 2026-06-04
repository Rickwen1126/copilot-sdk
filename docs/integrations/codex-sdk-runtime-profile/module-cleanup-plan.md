# Codex Adapter Module Cleanup Plan

Created: 2026-06-01 17:20
Last Updated: 2026-06-03 17:02
Status: Superseded by [refactor/spec.md](./refactor/spec.md) and [refactor/plan.md](./refactor/plan.md)

This draft was absorbed into the canonical refactor spec/plan pair on 2026-06-03. Keep it as source context for the original design-pattern cleanup reasoning, but do not use it as the active implementation plan.

## Goal

Turn the current successful Codex adapter spike into a cleaner module shape without changing the scoped `Copilot SDK + Copilot CLI` behavioral contract.

The cleanup goal is not to introduce a generic runtime framework. The goal is to reduce information leakage, make variation axes local, and keep conformance evidence strong while preserving the current adapter boundary.

Reference context:

- SHIP: [.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md](../../../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md)
- Learning packet: [learning-design-patterns-architecture-testing.md](./learning-design-patterns-architecture-testing.md)
- Runtime profile plan: [plan.md](./plan.md)
- Code map: [runtime-backend-code-map.md](../../architecture/runtime-backend-code-map.md)

## Design Principles

### 1. Extract By Hidden Knowledge, Not By File Size

Do not split a large file merely because it is large.

Split only when the extracted module hides a real decision:

- protocol shape
- SDK/runtime mapping
- runtime app-server IO
- permission/tool policy
- transcript normalization
- assertion/report evidence shape

If a new module forces readers to jump back and forth to understand one idea, it is likely a shallow split.

### 2. Mapper Means Translation Only

Mapper modules should stay pure.

Allowed:

- convert Codex event/tool/approval shape to SDK-facing normalized shape
- convert SDK tool result to Codex dynamic tool response
- convert permission result to runtime decision shape
- expose explicit handling for protocol-v2/v3 differences

Not allowed:

- read or mutate session state
- call runtime/app-server IO
- decide permission policy
- write logs as side effects
- own tool registry lifecycle

### 3. Facade Must Hide Decisions

`CodexCopilotAdapterServer` or its successor should become a small orchestration facade.

It should hide:

- protocol-version handling
- low-level runtime request/response shape
- permission/tool conversion details
- app-server transport details

It should not hide:

- unsupported capabilities
- meaningful runtime failures
- evidence needed for conformance and audit

### 4. Strategy/Policy Only When There Is Real Variation

Do not introduce `Strategy` objects for a single stable rule.

Use pure functions first. Promote to Strategy/Policy only when there are real variants such as:

- always-approve approval
- interactive approval
- deny dangerous command
- workspace-policy-based approval
- protocol-v2/v3 handler variants that materially differ

### 5. Tests Are Architecture Guards

The harness must remain proof infrastructure, not only example code.

Every cleanup step should preserve:

- SDK-visible behavior
- normalized transcript/dataflow evidence
- real side-effect assertions
- cross-backend parity where currently available
- unsupported-capability reporting

## Cleanup Phases

### Phase 0: Characterization Lock

Purpose: freeze the current scoped behavior before moving code.

Actions:

- Run the existing TypeScript build/unit checks and Chatpilot acceptance path before extraction.
- Preserve the current conformance artifact shape as the comparison baseline.
- Identify which assertions are L2 contract proof and which are L3/L4 durable side-effect proof.

Exit criteria:

- A known-good baseline exists for adapter tests and runtime acceptance.
- Failures after extraction can be compared against pre-cleanup behavior.

### Phase 1: Pure Mapper Extraction

Purpose: remove low-risk pure transformations from adapter orchestration.

Likely extraction targets:

- command approval request/result mapping
- file-change approval request/result mapping
- SDK tool descriptor to Codex dynamic tool shape
- SDK tool result to Codex dynamic tool response
- Codex event/session message to SDK-facing transcript shape
- protocol-v2/v3 dynamic tool call normalization, if separable without over-abstracting

Design check:

- extracted functions must not perform IO
- extracted functions must not depend on mutable session lifecycle
- tests should cover key mappings directly

Exit criteria:

- Adapter server class is smaller because translation knowledge moved out.
- Mapper tests fail on protocol/mapping drift.
- Existing conformance still passes.

### Phase 2: Runtime IO Gateway Boundary

Purpose: make Codex app-server IO a clear gateway, separate from SDK protocol handling.

Likely extraction targets:

- app-server request/response transport
- session create/resume/send calls
- app-server error normalization
- timeout/cancellation handling if currently mixed into adapter logic

Design check:

- mapper modules do not import runtime client
- facade callers do not know app-server request internals
- runtime-specific failure details are normalized but not swallowed

Exit criteria:

- `CodexAppServerClient` or equivalent owns runtime IO.
- Adapter facade coordinates IO but does not encode low-level transport behavior.
- Error paths remain observable in conformance reports.

### Phase 3: Adapter Facade Slimming

Purpose: make the adapter server a real facade/orchestrator rather than a knowledge warehouse.

Actions:

- Keep SDK-facing entrypoints stable.
- Delegate translation to mappers.
- Delegate runtime calls to gateway/client.
- Delegate permission/tool handling to pure functions or policies only where justified.
- Keep unsupported capabilities explicit.

Design check:

- facade method signatures are simpler than their hidden implementation.
- callers do not choose protocol version/tool-call shape/permission mapping manually.
- public exports do not leak runtime-specific types unless intentionally adapter-local.

Exit criteria:

- Adapter facade exposes high-level semantic operations.
- Protocol/runtime details are not required knowledge for normal SDK-facing callers.

### Phase 4: Conformance Harness Decomposition

Purpose: turn the large spike harness into maintainable proof infrastructure.

Split by responsibility:

- `scenarios`: user/runtime intent and expected outcomes
- `backend runners`: Copilot CLI baseline and Codex adapter execution
- `transcript/ledger`: normalization and event sequence capture
- `assertions`: contract, dataflow, side-effect, and intent checks
- `reports`: artifact assembly and matrix output
- `fixtures`: temporary workspace, file state, config, process lifecycle helpers

Design check:

- scenario definitions should not know process lifecycle details
- assertion modules should not launch backends
- report assembly should not decide pass/fail semantics
- transcript normalization should be reusable across backends

Exit criteria:

- A new scenario can be added without editing runner/report internals.
- A new backend can be compared without rewriting scenario intent.
- Failure output identifies whether scenario, runner, ledger, assertion, or report failed.

### Phase 5: Conditional Strategy/Policy Extraction

Purpose: introduce real variation handlers only where evidence proves a stable seam.

Candidate areas:

- permission approval modes
- protocol-v2/v3 dynamic tool handling
- tool failure/deny result behavior

Do not extract:

- single-rule behavior with no real variants
- speculative future runtime hooks
- generic runtime framework interfaces not exercised by a second backend

Exit criteria:

- every Strategy/Policy has at least two meaningful variants or a documented near-term conformance need.
- no pattern exists only to make the code look architectural.

## Implementation Order

Recommended order:

```text
1. Characterization lock
2. Pure mapper extraction
3. Runtime IO gateway boundary
4. Adapter facade slimming
5. Conformance harness decomposition
6. Conditional strategy/policy extraction
```

Reason:

- Mapper extraction gives immediate clarity with low behavior risk.
- Runtime IO separation reduces architecture leakage.
- Facade slimming becomes easier after mapper/gateway extraction.
- Harness decomposition is larger and should happen after core seams are stable.
- Strategy/Policy should wait for confirmed variation.

## Review Checklist

Use these five reflex questions during review:

1. If a protocol field changes, which module changes and which modules stay untouched?
2. Does the facade make callers know less, or only add an extra hop?
3. Is this behavior a single pure function or a real Strategy/Policy variation?
4. Did a mapper start making decisions, reading state, logging, or doing IO?
5. Did the cleanup reduce the number of concepts needed to change one behavior?

## Verification Requirements

Minimum checks after each phase:

- TypeScript compile/build still passes.
- Existing adapter unit/conformance tests still pass.
- Existing Chatpilot acceptance path still passes when the phase touches SDK-visible behavior.
- Conformance artifacts still prove transcript/dataflow/side-effect intent.
- Unsupported capability notes remain accurate.

Audit-specific checks:

- compare before/after conformance artifacts
- inspect public exports for runtime-specific type leakage
- inspect module imports for boundary violations
- confirm no test was weakened from side-effect proof to smoke proof

## Non-Goals

- Do not create a generic `RuntimeBackend` framework in this cleanup milestone.
- Do not add Strategy/Policy interfaces for single-rule behavior.
- Do not collapse conformance proof into logs-only assertions.
- Do not move Chatpilot app semantics into the Codex adapter.
- Do not rewrite the whole harness before locking current behavior.
