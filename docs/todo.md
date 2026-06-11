# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-10 16:03
Status: Active

## P0: Codex Adapter Production Readiness Queue @2026-06-04-2016

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Phase 3.5 evidence: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Code/Surface: adapter facade/session workflow, gateway lifecycle, Chatpilot acceptance harness, production runbook docs
- Source: production-readiness issue inventory split into spike-required and direct implementation phases

- [ ] Phase 5 production proof expansion.
  - Assigned issues: A6, B5, C2.
  - Completion evidence: multi-session concurrent acceptance, 26-tool schema round-trip acceptance, and tool-call compliance benchmark exist with machine-readable artifacts.
  - Current partial evidence: [refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json) adds the shared schema round-trip and tool-call compliance proof language, unit coverage, `toolCallCompliance` report shape, and `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS` multi-session harness entrypoint in Chatpilot runtime acceptance.
  - Remaining: add real Chatpilot 26-tool manifest/schema round-trip runner, representative compliance benchmark prompts, and live multi-session concurrent acceptance artifact.

- [ ] Phase 6 production policy and model-behavior cleanup.
  - Assigned issues: B6, B7, C3, C4, D2, D3.
  - Completion evidence: namespace/policy decisions are explicit, model-selection prompt/tool-description audits are backed by benchmark evidence, auth inheritance has production-like proof, and lower-priority multimodal/observability gaps are closed or explicitly deferred.

## P1: Codex Adapter Experimental Path Graduation @2026-06-05-1121

Section source:

- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 7
- Current package surface: [nodejs/package.json](../nodejs/package.json), `./experimental/codex-adapter`
- Current source surface: [nodejs/src/experimental](../nodejs/src/experimental)
- Source: user noticed the cleaned adapter modules still live under `experimental/`

- [ ] Decide and execute the adapter graduation path after Phase 4/5 production evidence.
  - Current decision: keep `nodejs/src/experimental/` and `./experimental/codex-adapter` while the Codex backend is still an incubating runtime lane.
  - Graduation trigger: Phase 4 production workflow hardening has passed; wait for Phase 5 proof expansion to pass without adapter-boundary blockers.
  - Completion evidence: either document why the adapter intentionally remains experimental, or move implementation to a stable source path, add a stable package export, keep `./experimental/codex-adapter` as an explicit compatibility/deprecation alias if needed, and update tests/docs/code map together.

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
  - Current partial evidence: [nodejs/examples/conformance/codexConformanceProof.ts](../nodejs/examples/conformance/codexConformanceProof.ts) owns proof assertions for schema round-trip and tool-call compliance; [nodejs/test/codex-conformance-proof.test.ts](../nodejs/test/codex-conformance-proof.test.ts) covers pass/fail/not-run evidence states.

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
