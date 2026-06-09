# AUDIT: Codex Adapter Phase 4 Final Hardening

Created: 2026-06-09 11:50
Status: Pass with explicit post-Phase-4 residual risks
Commit: `742f559 refactor: harden codex adapter production workflow`

## Verdict

Pass.

Phase 4 can move to user review as one complete slice. The adapter now has the session lifecycle, adapter-restart mapping, tool-set resume policy, bounded transcript behavior, protocol-v3 pending tool timeout, safer tool-result text mapping, and production runbook needed by the Phase 4 production-readiness queue.

## Blocking Findings

None.

## Non-Blocking Findings

1. Severity: post-Phase-4 production proof
   File: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-final-hardening@2026-06-09-1145.summary.json`
   Problem: Native tool suppression is implemented as a locked lane, but not yet benchmarked across representative Chatpilot prompts.
   Evidence: Phase 4 uses `approvalPolicy=never`, `sandboxMode=readOnly`, and `networkAccess=false`; the summary explicitly assigns representative tool-call compliance benchmark to Phase 5.
   Impact: Safe defaults are in place, but production confidence still needs evidence that Codex's model behavior consistently chooses Chatpilot tools rather than native coding-agent behavior.
   Suggested fix: Keep this as Phase 5 C2 benchmark work, not a Phase 4 blocker.

2. Severity: post-Phase-4 fidelity scope
   File: `nodejs/src/experimental/codexAdapter.ts`
   Problem: Adapter restart resume restores runtime continuity, not full SDK event history replay.
   Evidence: the earlier runtime session store brick reconstructs minimal session state from persisted mapping; the Phase 4 final summary keeps this as a residual risk.
   Impact: `resumeSession()` can continue the Codex thread, but `getMessages()` after adapter process restart is not yet a complete replay of pre-restart SDK events.
   Suggested fix: Decide in Phase 5/6 whether the selected Chatpilot path actually consumes post-restart `getMessages()`. If yes, add transcript/event hydration evidence; if no, document as out-of-profile.

3. Severity: post-Phase-4 auth operations
   File: `docs/integrations/codex-sdk-runtime-profile/production-runbook.md`
   Problem: The runbook documents login and stable home requirements, but token refresh / 401 recovery remains unvalidated.
   Evidence: production-readiness classified D2 as basic-supported and later production validation; Phase 4 did not attempt to prove refresh behavior.
   Impact: Normal logged-in startup is documented, but long-lived unattended production operation still needs auth-refresh evidence.
   Suggested fix: Keep D2 in Phase 6 production validation.

## Contract Check

- A1/A2: accepted. `disconnect()`/destroy detaches with `thread/unsubscribe`; delete archives with `thread/archive`.
- A3: accepted. Adapter and gateway transcripts now use bounded `transcriptLimit`.
- A4: accepted. Runtime session mapping store supports adapter-restart resume by persisted `sdkSessionId -> codexThreadId`.
- A5: accepted for Phase 4. Gateway marks exited app-server as restartable and subsequent `request()` can restart a previously-started child.
- B1/C1: accepted as a locked-lane mitigation. Codex lacks SDK-shaped `available_tools` / `excluded_tools`; Phase 4 uses safe defaults instead.
- B2: accepted. Incompatible resume tool-set changes are rejected before `thread/resume`.
- B3: accepted. Protocol-v3 pending dynamic tools now timeout and return failure to Codex.
- B4: accepted. Arbitrary object tool-result structure is no longer JSON-stringified into LLM text when `textResultForLlm` is absent.
- D1: accepted. `codex login` runbook exists.

## Evidence

- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-final-hardening@2026-06-09-1145.summary.json`
- Selected-profile conformance: `/tmp/copilot-codex-refactor-phase4-final.json`, run `d83f7062-a944-40cb-a0d9-3f56a436c85c`, verdict `pass`
- Chatpilot acceptance: `/tmp/chatpilot-codex-refactor-phase4-final.json`, run `15aade97-d245-43e7-ab78-58c8a9ae631e`, status `pass`
- Local tests: `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` -> 34 tests pass
- Type check: scoped `npx tsc --noEmit ...` -> pass
- Lint: scoped `npx eslint ...` -> pass
- Build: `npm run build` -> pass

## CodeTour / Review

Review tour:

- `.tours/audit-codex-adapter-phase4-final-20260609-1150.tour`

This is the consolidated Phase 4 tour. Earlier Phase 4 tours still exist for the session lifecycle and runtime session store bricks, but this final tour is the main review entry.

## Bank Handoff Candidates

- Runtime session continuity model: persisted mapping proves "which traveler", `thread/resume` proves "traveler was loaded".
- Tool-set compatibility model: dynamic tools are start-time shape, not resume-time hot updates; reject is safer than pretending compatibility.
- Locked lane model: when a coding-agent runtime is reused for a chatbot, safety is a runtime-profile default, not an afterthought.
