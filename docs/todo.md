# Active Todo

Created: 2026-05-16
Last Updated: 2026-06-15 00:09
Status: Active

## P1: ShinyiPilot Codex Adapter Production Isolation Gate @2026-06-15-0009

Section source:

- Spec: [docs/spec.md](./spec.md)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Code/Surface: [python/copilot/tools.py](../python/copilot/tools.py), [python/copilot/experimental/codex_adapter](../python/copilot/experimental/codex_adapter), ShinyiPilot worktree `/Users/rickwen/code/copilot-sdk/shinyipilot-spike/src/chatpilot/tools/factory.py`, ShinyiPilot `src/chatpilot/sdk/session.py`, and ShinyiPilot route config examples.
- Completed proof: [docs/todo-finished.md](./todo-finished.md#completed-shinyipilot-codex-adapter-tool-dispatch-production-smoke-2026-06-15-0009)
- Source: production-like ShinyiPilot integration smoke using the Python-native Codex adapter and temp gpt-5.4 route config.

- [ ] Decide the production isolation lane for state-changing ShinyiPilot Codex adapter E2E.
  - Source: failed forced `save_memo` runs before the compatibility fixes caused Codex native fallback to write marker files under `/Users/rickwen/.codex/memories/`.
  - Code/Surface: Codex adapter runtime profile, `CODEX_HOME`/workspace isolation, adapter tool policy, and production runbook.
  - Done when: the runbook states whether production smokes use a locked-down container, clean `CODEX_HOME`, stricter runtime profile, or another explicit boundary, and a state-changing smoke cannot silently write outside the intended app state.
- [ ] Decide ShinyiPilot model config policy for Codex-backed production experiments.
  - Source: ShinyiPilot example config uses `gemini-3-flash`, which Codex app-server rejected in the current ChatGPT-account lane; temp gpt-5.4 config was required for the passing smoke.
  - Code/Surface: ShinyiPilot `config/route_settings.example.yaml`, runtime backend guide, and production smoke docs.
  - Done when: docs/config clarify whether gpt-5.4 is a temp-only override for Codex adapter experiments or the accepted Codex-backed model lane.

## P1: Runtime Adapter Refactor Architecture Guard @2026-06-03-1141

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- References: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [SHIP](../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md), [learning packet](./integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md), [prior cleanup draft](./integrations/codex-sdk-runtime-profile/module-cleanup-plan.md), and [runtime backend code map](./architecture/runtime-backend-code-map.md)
- Source: user request to consolidate side-thread learning/refactor context into canonical spec/plan before implementation

No active P1 Runtime Adapter Refactor Architecture Guard phases remain. Completed Phase 5-7 work has been moved to [docs/todo-finished.md](./todo-finished.md).

Current milestone state:

- Canonical spec: [docs/spec.md](./spec.md)
- Architecture diagram: [docs/architecture/skyeye.html](./architecture/skyeye.html)
- Python adapter sky eye: [docs/architecture/python-codex-adapter-skyeye.html](./architecture/python-codex-adapter-skyeye.html)
- Code map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Python adapter CodeTour: [.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour](../.tours/03-python-codex-adapter-skyeye-copilot-sdk.tour)
- Runtime backend guide: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md)
- Runtime profile plan: [docs/integrations/codex-sdk-runtime-profile/plan.md](./integrations/codex-sdk-runtime-profile/plan.md)
- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Production capability spike: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Python-native adapter spike: [docs/integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md](./integrations/codex-sdk-runtime-profile/python-native-codex-adapter-spike/spec.md)
- Python-native adapter live smoke: [python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/python-native-codex-adapter-live-smoke@2026-06-12-1650.summary.json)
- Conformance artifacts: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capabilities: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Completed todo archive: [docs/todo-finished.md](./todo-finished.md)

Completed work for the milestone has been moved to [docs/todo-finished.md](./todo-finished.md).
