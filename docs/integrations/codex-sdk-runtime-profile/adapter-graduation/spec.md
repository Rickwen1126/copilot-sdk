# Codex Adapter Graduation Decision

Created: 2026-06-11 15:34
Last Updated: 2026-06-11 15:34
Status: Active

## Decision

Keep the Codex adapter under `nodejs/src/experimental/` and keep the package subpath as `./experimental/codex-adapter` for the next P1 refactor slice.

This is an intentional API-surface decision, not an unfinished migration. The adapter has passed the selected Chatpilot P0 production-readiness gate, but the runtime lane is still incubating as a profile-scoped backend rather than a stable general SDK API.

## Rationale

The adapter currently proves one selected runtime profile:

- `SDK Core Profile`
- `Coding Agent Profile`
- selected Chatpilot runtime acceptance through the SDK transport boundary

It does not claim full Copilot CLI parity. The adapter still explicitly defers the Interactive Profile, Fidelity Profile, Extended CLI Profile, direct dynamic-tool multimodal output, and live health/metrics integration.

The current package and test surface also protect this boundary:

- `nodejs/package.json` exports `./experimental/codex-adapter`, not a root SDK export or stable `./codex-adapter` subpath.
- `nodejs/test/codex-adapter.test.ts` verifies root SDK exports do not expose `CodexCopilotAdapterServer` or `CODEX_ADAPTER_CAPABILITIES`.
- `nodejs/test/codex-adapter.test.ts` verifies internal runtime implementation subpaths are not published.
- The adapter server bin remains `copilot-codex-adapter`, which is a runnable backend entrypoint but does not by itself make the source/package API stable.

Graduating now would create a stronger consumer promise than the codebase is ready to support. It would also force churn across package exports, source paths, runbook examples, code map references, conformance commands, and review tours before the Phase 5/6/7 architecture guard finishes decomposing the harness and closing refactor documentation.

## Current Contract

The supported contract remains:

- downstream applications may use the adapter through the explicit experimental subpath or the `copilot-codex-adapter` server bin;
- the adapter remains profile-scoped to the documented selected runtime profile;
- the root `@github/copilot-sdk` public API must stay free of Codex adapter internals;
- the experimental subpath must expose facade/options/capability API only, not raw gateway or JSON-RPC implementation classes;
- any future stable export must include a compatibility/deprecation plan for `./experimental/codex-adapter`.

## Graduation Trigger

Revisit graduation only after the architecture guard has completed enough closeout evidence to make the public promise stable:

- stale inline harness residue is deleted or archived as non-active reference;
- conformance harness responsibilities are split by evidence ownership;
- any Strategy/Policy extraction has real variants or documented near-term conformance need;
- before/after conformance artifacts show no behavioral weakening;
- `docs/spec.md` and `docs/architecture/runtime-backend-code-map.md` point to the final module surfaces.

## Completion Evidence

This decision completes the active P1 graduation todo by documenting why the adapter intentionally remains experimental for now. It does not complete the broader Runtime Adapter Refactor Architecture Guard; Phase 5/6/7 work remains active in `docs/todo.md`.
