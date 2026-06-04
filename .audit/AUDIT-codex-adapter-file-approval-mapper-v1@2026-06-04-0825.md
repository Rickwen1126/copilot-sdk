# AUDIT: Codex Adapter File Approval Mapper

Created: 2026-06-04 08:25
Status: Review Ready
Scope: Phase 2 pure mapper brick for file approval request/result mapping.

## Verdict

Pass. No blocking finding.

The milestone satisfies the refactor contract for this brick:

- file approval translation moved from `CodexCopilotAdapterServer` into the pure mapper module;
- adapter orchestration still owns runtime/session/connection work;
- dedicated mapper tests cover normal and missing-evidence cases;
- selected-profile conformance and Chatpilot acceptance both pass after insertion into the live adapter flow.

## Blocking Findings

None.

## Non-Blocking Findings

### 1. Mapper return types remain structural `Record<string, unknown>`

- Severity: non-blocking
- Location: `nodejs/src/experimental/codexAdapterMappers.ts:155`
- Problem: extracted mapper functions still return broad structural objects.
- Evidence: `mapCodexFileChangeApprovalToPermissionRequest()` returns `Record<string, unknown>`.
- Impact: acceptable for copy-transfer, but repeated mapper shapes may become harder to review if left unnamed after Phase 2 grows.
- Suggested fix: defer until more mapper bricks are extracted; introduce adapter-local internal types only if repeated shapes stabilize and reduce ambiguity.

## SHIP / Contract Check

- SHIP choice was Pattern-guided extraction around real seams. This brick follows that path: it extracts a proven mapper seam, not a generic runtime framework.
- SHIP risk "Pattern selection by variation axis" remains controlled. The change uses a mapper because the code already has translation pressure; it does not add Strategy/Policy ceremony.
- SHIP risk "Conformance harness as architecture guard" is satisfied for this brick. The broad conformance artifact proves file approval behavior after the extraction.
- SHIP risk "Protocol-v2/v3 and tool-call split" is unaffected by this brick.

## Architecture Boundary Check

- Mapper purity: pass. `nodejs/src/experimental/codexAdapterMappers.ts` does not import runtime gateway, mutate session state, log, or perform IO.
- Facade boundary: pass. `nodejs/src/experimental/codexAdapter.ts` still orchestrates `permission.request` and delegates shape conversion.
- Public API leakage: unchanged. The mapper module is not exposed through package `exports`.

## Evidence

Local verification:

```bash
cd nodejs
npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts
npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts src/experimental/codexAdapterMappers.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts
npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts
npm run build
```

Result:

- `vitest`: 2 files, 15 tests passed.
- `build`: pass.

Broad no-regression evidence:

- Selected-profile conformance artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-file-approval-mapper@2026-06-04-0822.summary.json`
- Selected-profile run: `runId=4f54f8b5-46bf-484e-a281-55631edf8458`, verdict `pass`, 7/7 checks pass.
- Chatpilot acceptance run: `runId=40cf07a3-9bff-4d6e-aa05-8d4f0027dd6f`, status `pass`, both `copilot-cli` and `codex-adapter` pass.

## CodeTour / Review

Review tour:

- `.tours/review-phase2-file-approval-mapper-20260604.tour`

Key review surfaces:

- `nodejs/src/experimental/codexAdapterMappers.ts`
- `nodejs/src/experimental/codexAdapter.ts`
- `nodejs/test/codex-adapter-mappers.test.ts`
- `docs/todo.md`

## Bank Handoff

Candidate learning:

- Pure mapper extraction should be audited by both local shape tests and one broad behavior proof when the mapping affects durable side effects.
- Named types should follow stabilized repeated shapes, not precede them.

## Next

- User review required before continuing.
- Next candidate mapper brick: SDK tool descriptor to Codex dynamic tool shape, or SDK tool result to Codex dynamic tool response.
