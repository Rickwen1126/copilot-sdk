# AUDIT: Codex Adapter Phase 3 Gateway Boundary

Created: 2026-06-04 17:10
Status: Pass
Scope: Runtime adapter refactor Phase 3 runtime IO gateway boundary

## Verdict

Pass. Phase 3 is complete under the accepted plan definition: Codex app-server process and JSON-RPC IO now live behind an adapter-internal gateway module, the adapter public subpath no longer exposes raw gateway classes or gateway injection types, gateway errors remain observable, and selected-profile conformance plus Chatpilot acceptance still pass.

## Blocking Findings

None.

## Non-Blocking Findings

1. Watch: internal gateway remains concrete.
   Location: `nodejs/src/experimental/codexAppServerGateway.ts:126`.
   Evidence: `CodexAppServerGateway` is the only gateway implementation.
   Impact: acceptable for Phase 3; adding Strategy now would be premature because no second gateway variant exists in this module yet.
   Suggested next step: revisit during Phase 6 only if another runtime backend proves a durable shared gateway contract.

2. Watch: tests use private-field replacement for fake gateway injection.
   Location: `nodejs/test/codex-adapter.test.ts:268`.
   Evidence: the characterization test replaces `adapter.codex` after construction so the public constructor does not expose internal gateway types.
   Impact: acceptable for Phase 3; the alternative public constructor injection leaked gateway types into `codexAdapter.d.ts`, which violated the boundary more directly.
   Suggested next step: if Phase 4 facade slimming creates an adapter-local factory/test seam, move fake gateway injection there.

## Contract Check

Phase 3 plan requirements:

- Move `CodexAppServerClient` or successor behind an internal gateway module: satisfied by `nodejs/src/experimental/codexAppServerGateway.ts`.
- Introduce a small internal gateway capability shape for facade tests: satisfied by adapter-local `CodexRuntimeGateway` shape inside `nodejs/src/experimental/codexAdapter.ts`.
- Remove raw gateway class exposure from experimental package public surface: satisfied by source guard and build-time declaration check.
- Keep runtime process, JSON-RPC request/response, timeout, and transcript capture in gateway: satisfied by the new gateway module.
- Preserve observability and avoid silent success: satisfied by pre-start gateway error test and broad conformance evidence.

Boundary fitness update:

- `docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md` now marks "Experimental Codex adapter subpath does not expose raw gateway class" as `passing-now`.

## Evidence

Local verification:

- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts src/experimental/codexAppServerGateway.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed.
- `npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts src/experimental/codexAppServerGateway.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed.
- `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed with 2 files and 26 tests.
- `npm run build` passed.
- Build-time declaration check: `nodejs/dist/experimental/codexAdapter.d.ts` exposes no `CodexAppServerGateway`, `CodexAppServerClient`, `CodexRuntimeGateway`, `codexAppServerGateway`, or `JsonRpc` imports.

Selected-profile conformance:

- Raw artifact: `/tmp/copilot-codex-refactor-phase3-gateway-20260604-1706.json`
- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json`
- Run ID: `4d82c62d-19b2-4749-9248-50d31b39c99c`
- Verdict: `pass`
- Checks: 7/7 pass
- Ledger counts: `copilotCli=396`, `codexAdapter=1473`
- Gateway transcript evidence includes `adapter->codex initialize`, `codex->adapter response`, `adapter->codex initialized`, `codex->adapter remoteControl/status/changed`, and `adapter->codex account/read`.
- Behavior evidence: assistant message `READY`, resumed assistant message `READYREADY`, approval/file/tool assertion failure arrays all empty.

Chatpilot runtime acceptance:

- Raw artifact: `/tmp/chatpilot-codex-refactor-phase3-gateway-20260604-1710.json`
- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json`
- Run ID: `546a6ab7-5476-46d3-b315-d2caf6dae322`
- Status: `pass`
- Backends: `copilot-cli=pass`, `codex-adapter=pass`
- Assertions: `copilot-cli=11/11`, `codex-adapter=12/12`
- Cross-backend assertions: same app-level acceptance flow, memo side effect persisted on both backends, same SDK-visible tool intents.

## Review Tour

CodeTour-backed review:

- `.tours/audit-codex-adapter-phase3-gateway-boundary-20260604-1710.tour`

The tour focuses on:

- `nodejs/src/experimental/codexAppServerGateway.ts:1` for runtime IO ownership;
- `nodejs/src/experimental/codexAdapter.ts:17` for import-without-export boundary;
- `nodejs/src/experimental/codexAdapter.ts:71` for constructor/API cleanliness;
- `nodejs/test/codex-adapter.test.ts:219` for public leakage guard;
- `nodejs/test/codex-adapter.test.ts:312` for gateway error observability.

## Exit Criteria

- Each copied gateway brick has a dedicated test before replacing live behavior: satisfied for public surface leakage and pre-start error observability; runtime process/JSON-RPC/transcript behavior is preserved through selected-profile and Chatpilot composed gates.
- Each gateway brick can be inserted into live adapter flow without breaking Phase 1 no-regression checks: satisfied.
- Public export leakage guard passes: satisfied.
- Adapter facade depends on gateway capability rather than concrete external-runtime class knowledge: satisfied.
- Existing conformance still passes: satisfied.

## Bank Handoff

Potential learning note:

- A gateway is the room with wires: it may touch process, env, transport, timeout, and transcript, but it must not own SDK-facing semantics. Keeping public constructor types clean is part of the boundary, not just hiding runtime exports.

Potential future audit probe:

- During Phase 4, check whether private-field test injection can be replaced by a cleaner adapter-local test seam without re-exposing gateway types in public declarations.
