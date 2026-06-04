# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-04 09:42
Status: Active

## P1: Runtime Adapter Refactor Architecture Guard @2026-06-03-1141

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- References: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [SHIP](../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md), [learning packet](./integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md), [prior cleanup draft](./integrations/codex-sdk-runtime-profile/module-cleanup-plan.md), and [runtime backend code map](./architecture/runtime-backend-code-map.md)
- Source: user request to consolidate side-thread learning/refactor context into canonical spec/plan before implementation

- [ ] Phase 3: Runtime IO gateway boundary.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), future gateway modules
  - Source: refactor plan Phase 3; `boundary-fitness.md` expected violation for `CodexAppServerClient` public export
  - Completion evidence: gateway bricks have dedicated tests, runtime transcript/error observability is preserved, raw gateway class no longer leaks through public adapter API, and conformance remains green.

- [ ] Phase 4: Adapter facade slimming.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), mapper/gateway/session workflow modules
  - Source: refactor plan Phase 4
  - Completion evidence: facade delegates mapper and gateway work through clean seams, session workflow behavior remains SDK-visible equivalent, and Phase 1 no-regression gate remains green.

- [ ] Phase 5: Conformance harness decomposition.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), future scenario/runner/ledger/assertion/report/fixture modules
  - Source: refactor plan Phase 5; subagent review finding about stale inline harness code
  - Completion evidence: stale inline minimal harness code is deleted or archived as non-active reference, harness responsibilities are split by evidence ownership, and selected-profile artifacts remain semantically equivalent or intentionally improved.

- [ ] Phase 6: Conditional Strategy / Policy extraction.
  - Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
  - Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
  - Code/Surface: adapter mapper/facade/gateway modules after Phase 2-5
  - Source: refactor plan Phase 6
  - Completion evidence: every Strategy/Policy brick has at least two meaningful variants or documented near-term conformance need, with dedicated variant tests and no pattern theater.

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
- Conformance artifacts: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capabilities: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)

Completed work for the milestone has been moved to [docs/todo-finished.md](./todo-finished.md).
