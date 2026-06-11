# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-11 22:57
Status: Active

## P1: Runtime Adapter Refactor Architecture Guard @2026-06-03-1141

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- References: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [SHIP](../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md), [learning packet](./integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md), [prior cleanup draft](./integrations/codex-sdk-runtime-profile/module-cleanup-plan.md), and [runtime backend code map](./architecture/runtime-backend-code-map.md)
- Source: user request to consolidate side-thread learning/refactor context into canonical spec/plan before implementation

- [ ] Phase 5: Conformance harness decomposition.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), future scenario/runner/ledger/assertion/report/fixture modules
  - Source: refactor plan Phase 5; subagent review finding about stale inline harness code
  - Completion evidence: stale inline minimal harness code is deleted or archived as non-active reference, harness responsibilities are split by evidence ownership, production proof expansion issues are covered or explicitly re-planned, and selected-profile artifacts remain semantically equivalent or intentionally improved.
  - Current partial evidence: [nodejs/conformance/codexConformanceProof.ts](../nodejs/conformance/codexConformanceProof.ts) owns proof assertions for schema round-trip and tool-call compliance; [nodejs/test/codex-conformance-proof.test.ts](../nodejs/test/codex-conformance-proof.test.ts) covers pass/fail/not-run evidence states; Phase 5 production proof expansion is completed and archived in [docs/todo-finished.md](./todo-finished.md), with audit [.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md](../.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md). The stale inline `RawCodexAppServerClient` / `_MinimalCopilotAdapterServer` residue has been deleted from [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), and [boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md) now records that oracle fitness rule as `passing-now`. [nodejs/conformance/codexConformanceLedger.ts](../nodejs/conformance/codexConformanceLedger.ts) now owns transcript-to-ledger normalization, baseline/adapter ledger collection, and hop matching; [nodejs/test/codex-conformance-ledger.test.ts](../nodejs/test/codex-conformance-ledger.test.ts) covers normalized payload evidence, error status detection, hop counts, and recording collection. [nodejs/conformance/codexConformanceReport.ts](../nodejs/conformance/codexConformanceReport.ts) now owns conformance status aggregation, check assembly, report artifact envelope, optional probe status handling, and trace/data/intent status triplets; [nodejs/test/codex-conformance-report.test.ts](../nodejs/test/codex-conformance-report.test.ts) covers status precedence, boolean status conversion, check status aggregation, missing optional probe fail/not-run behavior, status triplets, ledger counts, default profiles, and unsupported profile defaults. [nodejs/conformance/codexConformanceToolProbe.ts](../nodejs/conformance/codexConformanceToolProbe.ts) now owns custom-tool and tool-failure probe data/intent predicates plus handler-call summaries; [nodejs/test/codex-conformance-tool-probe.test.ts](../nodejs/test/codex-conformance-tool-probe.test.ts) covers expected and mutated handler evidence, final assistant result usage, paired failure/denied calls, and summary output. The P1 progress audit [.audit/AUDIT-codex-adapter-p1-progress-v1@2026-06-11-1941.md](../.audit/AUDIT-codex-adapter-p1-progress-v1@2026-06-11-1941.md) and tour [.tours/audit-codex-adapter-p1-progress-20260611-1941.tour](../.tours/audit-codex-adapter-p1-progress-20260611-1941.tour) review the work from the previous formal audit through `9e1baa1`. This broader refactor-plan item remains active because scenario/runner/assertion/fixture responsibilities still need decomposition and selected-profile conformance comparison is still needed before closeout.

- [ ] Phase 6: Conditional Strategy / Policy extraction.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: adapter mapper/facade/gateway modules after Phase 2-5
  - Source: refactor plan Phase 6
  - Completion evidence: every Strategy/Policy brick has at least two meaningful variants or documented near-term conformance need, production policy/model-behavior issues are closed or explicitly deferred with rationale, with dedicated variant tests and no pattern theater.

- [ ] Phase 7: Audit and canonical closeout.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: final adapter modules, harness modules, [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md), [docs/spec.md](./spec.md), [docs/todo-finished.md](./todo-finished.md)
  - Source: refactor plan Phase 7
  - Completion evidence: before/after conformance artifacts compared, public export/import boundary checks pass, new modules have dedicated tests plus composed conformance/E2E evidence, stale active todos are archived, and canonical docs/code map reflect final module surfaces.

Current milestone state:

- Canonical spec: [docs/spec.md](./spec.md)
- Architecture diagram: [docs/architecture/skyeye.html](./architecture/skyeye.html)
- Code map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Runtime profile plan: [docs/integrations/codex-sdk-runtime-profile/plan.md](./integrations/codex-sdk-runtime-profile/plan.md)
- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Production capability spike: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Conformance artifacts: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capabilities: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)

Completed work for the milestone has been moved to [docs/todo-finished.md](./todo-finished.md).
