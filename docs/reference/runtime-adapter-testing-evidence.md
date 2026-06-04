# Runtime Adapter Testing Evidence

Created: 2026-06-03 16:56
Last Updated: 2026-06-03 16:56
Status: Reference

## Context

This note records testing principles for the Codex runtime adapter refactor.

Related anchors:

- Architecture boundary reference: [runtime-adapter-architecture-boundary.md](./runtime-adapter-architecture-boundary.md)
- Learning packet: [../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md](../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md)
- Conformance artifacts: [../integrations/codex-sdk-runtime-profile/conformance-artifacts.md](../integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Runtime backend code map: [../architecture/runtime-backend-code-map.md](../architecture/runtime-backend-code-map.md)

## Core Principle

Testing evidence must match feature intent.

```text
Evidence must match intent.
For continuity features, evidence must prove continuity, not just existence.
```

For runtime adapter work, a passing process, HTTP response, or non-empty log is not enough. Tests must prove that the intended runtime flow happened and left the expected observable evidence.

## Smoke vs Proof

Smoke proves that the gate opens.

Proof proves that the traveler was processed correctly.

Smoke-level checks:

- server starts
- request returns
- process exits `0`
- response body is non-empty

Proof-level checks:

- SDK request / response contract shape is correct
- runtime transcript contains the expected event flow
- tool calls are observed and paired with results
- session id and request/tool ids line up across logs and artifacts
- side effects are written and can be read back
- unsupported capabilities and errors are explicit, not silently normalized away

Refactor rule:

```text
L1 smoke may be useful during development, but it cannot be the completion evidence.
```

## Behavior Contract / Test Boundary

Tests should be strict about behavior and loose about implementation shape.

Verify:

- input request, tools, approval policy, and session context are accepted as stable adapter workflow semantics
- transcript / tool-call / completion / error outputs match the public contract
- session create, reuse, resume, and recreate behavior matches the intended workflow
- runtime-specific details are translated before they reach app-level assertions

Do not bind tests to:

- private helper call order
- mapper branch internals
- report-builder implementation details
- constructor order
- implementation-only temporary state

Refactor rule:

```text
Tests should protect behavior contracts, not freeze the old spike structure.
```

## Test Spy Placement

Spy on semantic boundaries, not implementation steps.

Good spy points:

- SDK send/request boundary
- runtime transcript receive boundary
- tool-call dispatch boundary
- tool-result return boundary
- session log/artifact boundary
- durable read-back boundary

Bad spy points:

- every private helper
- every mapper branch
- string assembly steps inside report generation
- constructor call order
- temporary implementation state

Refactor rule:

```text
Too many spies create implementation noise.
Too few spies miss dataflow truth.
```

## Transcript Normalization And Custom Assertions

Normalization should preserve absence.

```text
Normalize shape, do not invent facts.
Missing evidence is evidence.
```

Allowed normalization:

- normalize timestamps, ids, and event envelope shape
- extract session id, tool-call id, event type, and payload
- classify events as observed, missing, unsupported, parse-failed, or errored
- produce a stable evidence ledger for assertions and audit

Disallowed normalization:

- turn missing events into empty success values
- treat parse failure as no-op
- invent default session ids
- hide unsupported capabilities
- remove error transcript chunks from the evidence ledger

Refactor rule:

```text
If a required event is absent, the normalized ledger must make that absence visible.
```

## Evidence Levels

Use the point / line / cross-line model.

```text
L2 = point: this interaction's contract shape is correct.
L3 = line: this interaction reached durable side effects and can be read back.
L4 = cross-line: repeated, multi-turn, cross-session, cross-backend, or time-sensitive behavior stays consistent.
```

L2 examples:

- SDK payload shape is correct
- response shape is correct
- transcript contains expected event/tool-call/result shapes
- protocol v2/v3 conversion matches the adapter contract

L3 examples:

- memory, file, log, or session artifact is actually written
- side effect can be read back from the owning store
- adapter/system logs can be correlated by session/request/tool id
- session state persists beyond the immediate response

L4 examples:

- create session / reuse session / resume session behavior stays consistent
- multi-turn transcript ordering is correct
- cross-backend behavior is app-observable equivalent
- repeated tool-call/result flows stay attached to the correct session continuity
- unsupported, approval, and error behavior remains explicit across backends

Refactor rule:

```text
The required evidence level depends on feature intent.
Session continuity features need L4 evidence, not only L2 shape checks.
```

## Silent Failure Checks

Silent failure means the system reports no error, but the intended behavior did not happen.

Runtime adapter silent failures include:

- request succeeds but runtime was not actually invoked
- transcript exists but misses a required event
- tool call is not dispatched
- tool result is not returned to the session
- response exists but memory/log/file side effect is missing
- session id exists but reuse accidentally creates a new session
- unsupported capability is swallowed and omitted from the report

Minimum session-reuse proof:

- initial create returns a session id
- follow-up request explicitly uses that session id
- runtime transcript/logs show the same session id
- tool calls, results, and side effects attach to the same continuity
- repeated reuse still reads prior context or state
- accidentally spawned new sessions cause the test to fail

Refactor rule:

```text
For continuity features, prove continuity directly. Do not accept mere existence of a session id.
```

## Implementation Checklist

- Add or preserve characterization evidence before extraction.
- Split tests by behavior intent, not by implementation module.
- Keep raw evidence available when normalized assertions fail.
- Make transcript normalization strict about missing / unsupported / parse-failed evidence.
- Verify at least L2 for mapper extraction.
- Verify L3 when a tool, memory, file, log, or session artifact is part of the claim.
- Verify L4 for session reuse/resume, multi-turn flows, async ordering, and cross-backend parity.
- Pair behavior conformance with architecture boundary checks from [runtime-adapter-architecture-boundary.md](./runtime-adapter-architecture-boundary.md).

## Review Questions

1. Is this test a smoke check or proof?
2. Does the evidence level match the feature intent?
3. Is the test asserting behavior contract or old implementation shape?
4. Are spies placed at semantic boundaries?
5. Does normalization preserve missing and unsupported evidence?
6. Would a silent session-reuse failure be caught?
