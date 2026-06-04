# AUDIT: Codex Adapter Phase 2 Mapper Layer

Created: 2026-06-04 09:42
Status: Pass
Scope: Runtime adapter refactor Phase 2 pure mapper layer

## Verdict

Pass. Phase 2 is complete under the accepted plan definition: pure translation logic was moved out of adapter orchestration, each copied mapper brick has dedicated tests, live adapter insertion preserved behavior, and both selected-profile conformance plus Chatpilot acceptance passed after the full mapper layer was inserted.

This audit supersedes the narrower file-approval mapper audit at `.audit/AUDIT-codex-adapter-file-approval-mapper-v1@2026-06-04-0825.md`.

## Blocking Findings

None.

## Non-Blocking Findings

1. Watch: mapper result shapes are still broad.
   Location: `nodejs/src/experimental/codexAdapterMappers.ts:33`, `nodejs/src/experimental/codexAdapterMappers.ts:48`, `nodejs/src/experimental/codexAdapterMappers.ts:153`.
   Evidence: `dynamicToolsFromDescriptors`, `mapSdkToolResultToCodexDynamicToolResponse`, and `codexSandboxPolicy` return `Record<string, unknown>` rather than named internal result types.
   Impact: acceptable for Phase 2 copy-transfer, but weaker as long-term internal API documentation if mapper reuse grows.
   Suggested next step: do not block Phase 2. Revisit after Phase 3/4 reveals stable module boundaries; add named adapter-local result types only where repeated shapes reduce ambiguity.

2. Watch: protocol-v2/v3 dynamic tool handling remains in the adapter facade by design.
   Location: `nodejs/src/experimental/codexAdapter.ts:1273`.
   Evidence: the branch touches `pendingDynamicToolCalls`, SDK connection IO, transcript emission, and `external_tool.requested` lifecycle events.
   Impact: this is not a Phase 2 miss because the plan only allowed extracting this behavior "when separable without creating fake Strategy objects".
   Suggested next step: revisit during Phase 4 facade slimming or Phase 6 Strategy/Policy extraction only if a real variant seam appears.

## Contract Check

SHIP / plan max rule: "在保留 spike 功能完整正確的情況下，做module 正確邊界區分的 refactor".

Result: satisfied.

The implementation followed the per-brick loop across Phase 2 rather than treating it as a one-time phase:

- command approval mapper extracted, tested, inserted into live adapter, and verified by no-regression gates;
- file-change approval mapper extracted, tested, inserted into live adapter, and verified by no-regression gates;
- SDK tool descriptor mapper extracted, tested, inserted into live adapter;
- SDK tool result mapper extracted, tested, inserted into both protocol-v2 and protocol-v3 result paths;
- model list mapper extracted, tested, inserted into `models.list`;
- sandbox thread/turn request shape mapper extracted, tested, inserted into `thread/start` and `turn/start`.

The mapper module does not import the runtime gateway, does not read or mutate session state, and does not perform logging or IO.

## Evidence

Local verification:

- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed.
- `npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed.
- `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed with 2 files and 24 tests.
- `npm run build` passed.

Selected-profile conformance:

- Raw artifact: `/tmp/copilot-codex-refactor-phase2-complete-20260604-0940.json`
- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json`
- Run ID: `dd467a11-24b7-4241-8ee4-93d19e8eb270`
- Verdict: `pass`
- Checks: 7/7 pass
- Ledger counts: `copilotCli=421`, `codexAdapter=1674`
- Behavior evidence: assistant message `READY`, resumed assistant message `READYREADY`, approval/file/tool assertion failure arrays all empty.

Chatpilot runtime acceptance:

- Raw artifact: `/tmp/chatpilot-codex-refactor-phase2-complete-20260604-0945.json`
- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json`
- Run ID: `15ec983d-293e-4142-9a67-fd203e64ffec`
- Status: `pass`
- Backends: `copilot-cli=pass`, `codex-adapter=pass`
- Cross-backend assertions: same app-level flow pass, memo side effect persisted on both backends, same SDK-visible `save_memo` / `list_memos` tool intents.

## Review Tour

CodeTour-backed review:

- `.tours/audit-codex-adapter-phase2-mapper-layer-20260604-0942.tour`

The tour focuses on the mapper boundary and the adapter insertion points:

- `nodejs/src/experimental/codexAdapterMappers.ts:20` for tool descriptor mapping;
- `nodejs/src/experimental/codexAdapterMappers.ts:48` for SDK tool result mapping;
- `nodejs/src/experimental/codexAdapterMappers.ts:89` for model/sandbox conversion;
- `nodejs/src/experimental/codexAdapter.ts:17` for facade delegation;
- `nodejs/src/experimental/codexAdapter.ts:1273` for the intentionally unextracted protocol branch;
- `nodejs/test/codex-adapter-mappers.test.ts:17` for mapper contract tests.

## Exit Criteria

- Each copied mapper brick has dedicated tests: satisfied.
- Each mapper brick is inserted into live adapter flow: satisfied.
- Mapper tests fail on mapping drift: satisfied for command approval, file approval, tool descriptors, dynamic tool results, model conversion, sandbox conversion, and missing evidence cases.
- `CodexCopilotAdapterServer` has less translation logic embedded in orchestration: satisfied for Phase 2 candidates except conditional protocol-v2/v3 dynamic tool request normalization, which remains intentionally unextracted.
- Existing adapter conformance still passes: satisfied.

## Bank Handoff

Potential learning note:

- A mapper layer is a customs desk, not a runtime mini-framework: it should translate evidence, refuse to invent missing facts, and stay away from IO/session lifecycle until a real reusable seam appears.

Potential future audit probe:

- During Phase 4/6, re-check whether protocol-v2/v3 dynamic tool handling now has two durable variants worth extracting, or whether it should stay explicit in the facade.
