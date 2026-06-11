# AUDIT: Codex Adapter Phase 5 Production Proof

Created: 2026-06-11 10:40
Status: Pass with explicit residual
Scope: Phase 5 production proof expansion for A6, B5, and the safe C2 slice
Reviewed head: `454cf038022e9c245deafd9f15d370e104006674`
Review tour: [.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour](../.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour)

## Verdict

Phase 5 production proof expansion is acceptable for merge/review: A6 multi-session acceptance and B5 26-tool schema round-trip have live passing evidence, and the C2 safe save/list slice passes under the full 26-tool availability profile.

This is not a full production gate close for the original C2 benchmark wording. The original C2 asked for representative prompts per tool and backend accuracy across the 26-tool matrix. That broader selection benchmark is now explicitly tracked as `C2 residual` in Phase 6.

## Findings

### P1 Residual: C2 is a safe slice, not the original full 26-tool selection benchmark

Evidence:

- Production-readiness C2 asks for representative LINE-style prompts per tool, N runs each, two lanes, and an accuracy table: [production-readiness@2026-06-04-1953.md](../docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- The Phase 5 artifact records safe `save_memo` / `list_memos` prompts under 26-tool availability, with external-side-effect tools intentionally not executed: [refactor-phase5-production-proof@2026-06-11-1038.summary.json](../docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-production-proof@2026-06-11-1038.summary.json)
- Active todo now carries `C2 residual` into Phase 6: [docs/todo.md](../docs/todo.md)

Impact:

Phase 5 can be considered complete as a production proof expansion, but the production readiness gate must not claim full C2 closure yet. The unresolved part is model-selection behavior across the whole tool catalog, not schema transport or app-level save/list dataflow.

Required follow-up:

Phase 6 should either produce the full 26-tool selection benchmark or write down an explicitly safer equivalent that avoids external side effects while still measuring selection behavior.

### P2 Risk: `all-chatbot` tool list is hardcoded in the acceptance runner

Evidence:

- `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot` expands from a TypeScript hardcoded list in [chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- The live report still compares SDK `session.create.tools` against Codex `thread/start.dynamicTools`, so B5 validates the descriptors that were actually registered in that run.

Impact:

This is acceptable for the current Phase 5 artifact because the run recorded 26 expected and 26 observed tools. The drift risk is future-oriented: if Chatpilot changes the chatbot-visible tool registry, this runner will need manual update or a real manifest discovery/export path.

Required follow-up:

When harness decomposition continues, prefer a Chatpilot-owned manifest export or fixture generated from the same source that production uses.

## Evidence Matrix

| Gate | Result | Evidence |
|---|---|---|
| A6 multi-session concurrent acceptance | Pass | `/tmp/chatpilot-codex-phase5-live-20260611-1037.json`, sha256 `ccff597a01cb24ef4c6becd250376f5bdcf12e55f40581641c0097af5c4fdbf8`; 2 concurrent Codex adapter routes, distinct SDK session ids, distinct SQLite memo markers |
| B5 26-tool schema round-trip | Pass | Both live artifacts report `expectedToolCount=26`, `observedToolCount=26`, and no failed tools |
| C2 safe save/list compliance slice | Pass | `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json`, sha256 `751317ac53ceff2c8e1ded28cf754ab838207b3145b7ff3b5a97d3dddbb3e941`; Copilot CLI and Codex adapter both select `save_memo` and `list_memos`; native Codex tool calls absent |
| Original C2 full benchmark | Residual | Tracked in Phase 6 as `C2 residual` |

## Verification Run

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 22 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx prettier --check conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npm run build` -> pass
- Live Codex adapter concurrent run -> pass
- Live cross-backend run -> pass

Note: local commands emitted `pyenv: cannot rehash: /Users/rickwen/.pyenv/shims isn't writable`, but exited successfully.

## Closeout

Phase 5 proof expansion is ready for user review. The next durable work items are Phase 6 `C2 residual` / model-behavior policy cleanup and the separate P1 experimental-path graduation decision.
