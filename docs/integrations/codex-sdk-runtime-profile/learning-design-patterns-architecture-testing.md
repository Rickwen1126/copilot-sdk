# Codex Adapter Cleanup Learning Packet

Created: 2026-06-01 16:13
Last Updated: 2026-06-01 16:13
Status: Draft / source-grounded learning support

## Purpose

This note expands the SHIP learning queue for Codex adapter module cleanup.

The question is not "which pattern names should we apply?" The question is:

> When a successful spike becomes production-shaped code, which seams reduce future change cost without turning the adapter into a generic framework too early?

Scope:

- Design-patterns lens: how to simplify modules without pattern theater.
- Software-architecture lens: how to keep runtime backend boundaries enforceable.
- Testing lens: how to refactor while preserving behavior evidence.

Deepening status:

- NotebookLM relation navigation was completed for `design-patterns`, `software-architecture`, and `testing`.
- Local source verification in this note uses family indexes and local source notes already present under `~/webric/learning-os`.
- This is a learning/design support artifact, not a final implementation plan.

NotebookLM conversations:

- `design-patterns`: `8811d9c8-6c9f-4e48-9249-f4694d80b26d`
- `software-architecture`: `8d21de41-bdd8-4bb9-807c-b128f09fda06`
- `testing`: `b2110e43-f4fe-4881-b345-0e901695c0b1`

## 1. Design Patterns: Cleanup Without Pattern Theater

### Mental Model

Think of the spike as a workbench where every tool was reachable from one spot. That is great for discovery, but bad for maintenance. Cleanup is not about putting fancy labels on drawers; it is about deciding which tools belong together because they change for the same reason.

In this lens, patterns are not decorations. A pattern is justified only when it absorbs a real axis of change:

- Protocol shape changes.
- Runtime IO changes.
- Tool/permission policy changes.
- Transcript normalization and evidence reporting change.

If there is no independent axis of change, a new class or interface is likely just ceremony.

### Source-Grounded Claims

- `A Philosophy of Software Design` is the main complexity-control source. Its useful concepts here are deep modules, information hiding, temporal decomposition, shallow/pass-through methods, and information leakage.
- `Refactoring` supplies the mechanical route: split phases, extract classes, and move transformation logic out of orchestration logic in small steps.
- GoF / Head First / Dive Into Design Patterns provide vocabulary for Facade, Adapter, and Strategy, but those patterns should be checked against complexity reduction, not applied because their names sound relevant.

Original reading path:

- `design-patterns/books/a-philosophy-of-software-design.md`: deep modules, information hiding, temporal decomposition, shallow modules, pass-through methods.
- `design-patterns/books/refactoring-2nd-edition.md`: split phase, extract class, change-function-declaration style moves that preserve behavior.
- `design-patterns/books/design-patterns-gof.md`: Facade, Adapter, Strategy applicability and consequences.
- `design-patterns/books/api-design-patterns.md`: if the extracted surface becomes a public API contract, read compatibility and lifecycle-related API patterns.

### Reasonable Inferences For This Repo

- The current adapter cleanup should start from pure mapper extraction because mapping functions are the easiest seam to characterize and least likely to require product-level judgment.
- A Facade is useful only if it hides protocol/runtime orchestration from callers. If it merely forwards calls to newly extracted functions, it becomes a shallow middleman.
- Strategy/Policy is justified for permission/tool behavior only if there are multiple interchangeable policies or versioned behaviors. If the behavior is stable and singular, a pure function is cleaner.
- The conformance harness should not be split by execution order alone. It should be split by knowledge ownership: scenarios know intent, ledger/transcript normalization knows observation shape, assertions know proof rules, report assembly knows artifact shape, and backend runners know runtime launch mechanics.

### Failure Modes

- Pattern theater: adding `Facade`, `Strategy`, or `Adapter` classes without reducing what future maintainers must understand.
- Shallow module explosion: many tiny wrappers whose interfaces are almost as complex as their implementations.
- Backdoor information leakage: protocol-specific assumptions appear in multiple modules even if no public type exposes them directly.
- Temporal decomposition: modules are named after execution steps rather than hidden knowledge or responsibility.

### Trade-Off

The cleanup will increase the number of files. That cost is acceptable only if each new file hides a real decision:

- Mapper modules hide protocol-to-SDK conversion.
- Runtime client modules hide Codex app-server IO.
- Policy modules hide permission/tool decision variants.
- Harness support modules hide evidence normalization and assertion logic.

If a file does not hide a decision, it should probably remain a function near its caller.

### Exit Questions

1. If a protocol field changes, which module should need edits, and which modules should remain untouched?
2. Which proposed extraction would still force the reader to jump between parent and child modules to understand one idea?
3. Is each extracted interface simpler than the implementation it hides?

## 2. Software Architecture: Boundary Before Framework

### Mental Model

The runtime backend is a plug adapter, not the appliance. Chatpilot/app semantics are the appliance: route identity, memory ownership, tool intent, and product workflow. Codex, Copilot CLI, Gemini CLI, or another runtime are replaceable plugs that provide coding-agent capability.

The architecture question is therefore:

> How do we let the app use a runtime without letting runtime details become app semantics?

### Source-Grounded Claims

- `Clean Architecture` is the primary source for dependency direction, policy/detail separation, partial boundaries, and test boundaries.
- `Enterprise Integration Patterns` supplies language for Messaging Gateway and Messaging Mapper: wrap external messaging/transport systems and translate between external and internal representations.
- `Fundamentals of Software Architecture` contributes fitness functions: architecture rules should become executable checks where possible, not only diagrams or comments.
- `Software Architecture in Practice` is the companion lens when the decision must be tied back to quality attributes and review criteria.

Original reading path:

- `software-architecture/books/clean-architecture.md`: dependency rule, boundaries, partial boundaries, test boundary.
- `software-architecture/books/enterprise-integration-patterns.md`: messaging gateway, messaging mapper, endpoint/channel vocabulary.
- `software-architecture/books/fundamentals-of-software-architecture.md`: modularity, coupling, architecture characteristics, fitness functions.
- `software-architecture/books/software-architecture-in-practice.md`: quality attribute scenarios and architecture evaluation framing.

### Reasonable Inferences For This Repo

- The adapter should be treated as an outer detail around a runtime capability. Product/app code should not import runtime-specific types unless the import is intentionally part of an adapter layer.
- The current "small runtime facade" is a partial boundary. That is probably the right cost level now: enough separation to prevent coupling, not enough ceremony to become a full framework.
- Protocol mapping is closer to Messaging Mapper than domain logic. It translates between external runtime protocol shape and internal SDK-facing intent.
- Runtime IO is closer to Messaging Gateway: it owns calls to the external runtime/app server and shields callers from connection details.
- The conformance harness can become an architectural fitness function: it fails when the adapter boundary leaks, not just when runtime behavior breaks.

### Failure Modes

- Framework creep: product/app semantics start depending on runtime-specific structures because the runtime is convenient.
- Transitive leakage: the facade looks clean, but exported TypeScript types still expose runtime details.
- Boundary inflation: the team builds a universal runtime framework before more than one backend has proven the common abstractions.
- Test boundary coupling: tests mirror internal structure too closely, making refactor harder instead of safer.

### Trade-Off

A partial boundary is cheaper than a full plugin framework, but it relies on discipline and tests. The trade-off is acceptable if we make the boundary visible and enforceable:

- Public exports stay small.
- Runtime-specific details stay under experimental/runtime adapter modules.
- Architecture rules become tests or static checks where practical.
- Future backends are allowed to inform the abstraction, not forced into a premature one.

### Exit Questions

1. What app concepts must never be owned by a runtime backend?
2. If another runtime backend is added, which existing types should it reuse, and which should remain Codex-specific?
3. What automated check would fail if app code imports runtime-specific internals?

## 3. Testing: Proof Infrastructure, Not Green-Light Theater

### Mental Model

A refactor changes code shape while promising behavior continuity. The test suite is the witness. A weak witness says, "the process exited successfully." A strong witness says, "the same intent traveled through the same observable protocol path and produced the same durable effects."

For this adapter, the evidence chain is:

```text
scenario intent
-> SDK send/request shape
-> runtime transcript/tool-call behavior
-> adapter mapping behavior
-> app/tool side effect
-> report/log/artifact proof
```

### Source-Grounded Claims

- Local `E2E testing philosophy` is the repo delivery contract: status code, exit code, or UI/log presence alone is not proof.
- `xUnit Test Patterns` supplies vocabulary for behavior verification, test spies, custom assertions, test utility methods, obscure tests, eager tests, and brittle fixture repair.
- `Testing Library guide` is frontend-focused, but its transferable lesson is to test observable behavior and stable contracts, not internal implementation details.

Original reading path:

- `testing/books/e2e-philosophy-local-anchor.md`: data-level verification, full-chain consistency, silent failure, spec cross-check.
- `testing/books/xunit-test-patterns.md`: behavior verification, test doubles/spies, fixtures, custom assertions, obscure/eager tests.
- `testing/books/testing-library-guide.md`: behavior-focused testing and implementation-detail avoidance.
- `testing/validation/semantic-smoke@2026-05-14-2223/README.md`: smoke vs proof, local contract vs durable side-effect evidence, brittle legacy test repair.

### Reasonable Inferences For This Repo

- Before extraction, keep a characterization baseline: current conformance/acceptance artifacts become the "same behavior" reference.
- Transcript normalization should become a test utility/custom assertion layer, not remain fused to scenario execution.
- Backend runners should be separate from scenario definitions. Otherwise every scenario also knows process lifecycle and report shape.
- Test spies are useful at the adapter boundary to capture transcript/dataflow. They must not replace L3/L4 read-back when durable side effects are the thing being proven.
- The harness split should separate scenario intent, observation capture, assertion logic, report assembly, and backend execution.

### Failure Modes

- Silent pass: logs exist but the intended tool call or side effect did not happen.
- Obscure test: a failure occurs but the mixed harness makes it unclear whether the scenario, runner, normalization, assertion, or report failed.
- Eager test: one test tries to prove too many behaviors and becomes brittle.
- Over-mocking: tests pass against fake behavior while the real runtime path is broken.
- Internal-detail lock-in: tests assert extracted module internals, making harmless refactors fail.

### Trade-Off

Behavior verification with spies catches protocol/dataflow regressions early, but it can be more coupled to contract shape than pure black-box state checks. The right split is layered:

- L1: process starts and does not crash.
- L2: SDK payload/transcript/tool-call contract is correct.
- L3: durable side effects are read back from the owning store/log/file/state.
- L4: async ordering, repeated session behavior, and cross-backend parity are verified.

For this cleanup, L2 protects extraction mechanics; L3/L4 protect the claim that Codex can replace the scoped Copilot SDK + CLI behavior.

### Exit Questions

1. Which assertions prove behavior contract, and which merely prove implementation shape?
2. If the adapter drops one transcript chunk but exits zero, which test fails?
3. Which harness module owns scenario intent, and which owns evidence formatting?

## Combined Design Guidance

Use the three lenses together:

| Pressure | Primary Lens | Design Response | Test Response |
|---|---|---|---|
| Mixed adapter responsibilities | design-patterns | Extract by hidden knowledge and variation axis, not execution order | Characterize mapper behavior before moving it |
| Runtime details leaking upward | software-architecture | Treat runtime as outer detail; use gateway/mapper boundary | Add boundary checks and conformance artifacts |
| Harness too large to trust | testing | Split scenario, observation, assertion, report, runner | Preserve transcript/dataflow/side-effect proof |
| Risk of generic framework creep | software-architecture + design-patterns | Keep partial boundary; generalize only after another backend proves the seam | Audit for unnecessary abstractions |

## Local Verification Checklist For Implementation

- Adapter facade exposes high-level semantic operations, not orchestration chores.
- Pure mappers can be unit-tested without runtime IO.
- Runtime IO module can be swapped or faked without changing mapper tests.
- Permission/tool policy is either a clear pure function or a real strategy with multiple variants; no fake strategy.
- Protocol-v2/v3 variants are explicit and tested.
- Harness modules split into scenario, transcript/ledger normalization, assertions, reporting, and backend runners.
- Conformance artifacts before and after cleanup prove the same scoped behavior.
- No app/product semantic import depends on Codex-specific runtime internals.

## Source-Grounded / Inferred / Needs Verification

Source-grounded:

- Complexity should be judged by interface depth, information hiding, and whether modules reduce cognitive load.
- Architecture boundaries should protect policy/app semantics from external runtime details.
- Testing proof must include data-level and side-effect evidence when those are the claimed outcomes.

Reasonable inference:

- The right first extraction order is mapper/test-support first, then runtime IO/facade reshaping, then optional policy strategy.
- The conformance harness should be treated as architecture governance, not just an example script.
- A partial boundary is the correct current level; a full generic runtime framework is premature.

Needs verification:

- Whether permission/tool behavior has enough variants to justify Strategy/Policy objects.
- Whether TypeScript exports currently leak runtime-specific types across the desired boundary.
- Whether CI/static checks can enforce the boundary cheaply.
- Whether after extraction the same Chatpilot acceptance and Codex conformance artifacts remain byte-for-byte or semantically equivalent enough for audit.
