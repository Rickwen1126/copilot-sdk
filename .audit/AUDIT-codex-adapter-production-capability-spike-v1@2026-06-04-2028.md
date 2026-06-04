# AUDIT: Codex Adapter Production Capability Spike

Created: 2026-06-04 20:28
Status: Review Ready

## Verdict

Pass for Phase 3.5. The spike answered the pre-Phase-4 production capability questions with durable protocol / transcript evidence and re-planned active todo from evidence rather than guesses.

Phase 4 may start after user review. No P0 capability requires stopping the route, but several items are only partially supported and must remain explicit implementation constraints.

## Blocking Findings

None for Phase 3.5.

## Non-Blocking Findings

- **A1 lifecycle is partial, not a generic close primitive.**
  Evidence: Codex exposes `thread/unsubscribe` and `thread/archive`, but no `thread/end` or `thread/close`.
  Impact: Phase 4 must not invent SDK-style close semantics. Adapter destroy should detach listener and archive persisted thread when production cleanup is intended.

- **B2 dynamic tool refresh is unsupported on resume.**
  Evidence: upstream `ThreadStartParams` has `dynamic_tools`; `ThreadResumeParams` does not. Live resume accepting a `dynamicTools` field is likely unknown-field tolerance or ignored-field behavior.
  Impact: Phase 4 must implement recreate/fork/reject behavior for incompatible tool-set resume, not hot-update.

- **B1/C1 native-tool suppression remains a behavior proof item.**
  Evidence: protocol exposes sandbox / permission profiles / config, not SDK-shaped `available_tools` / `excluded_tools`.
  Impact: Phase 4 can implement the locked Chatpilot lane, but Phase 5/production proof still needs benchmark evidence that native shell/file-edit behavior is actually suppressed in representative prompts.

- **D2 auth inheritance is only basic-supported.**
  Evidence: isolated `CODEX_HOME` starts app-server and `account/read` succeeds.
  Impact: token refresh and 401 recovery must stay in later production validation; this spike only proves startup inheritance.

## Evidence And Tests

- Probe script: `nodejs/examples/codex-app-server-capability-spike.ts`
- Summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json`
- Raw live artifact: `/tmp/codex-app-server-capability-spike-20260604-live.json`
- Live evidence: thread `019e929a-7f57-7980-b000-7be3e99e4afc`, turn `019e929a-804c-7012-9316-4ae39940631a`, completed answer `CODEX_CAPABILITY_SPIKE_OK`
- Verification commands:
  - `npx tsc --noEmit --allowImportingTsExtensions examples/codex-app-server-capability-spike.ts`
  - `npx eslint examples/codex-app-server-capability-spike.ts`
  - `npx tsx examples/codex-app-server-capability-spike.ts`
  - `CODEX_CAPABILITY_SPIKE_RUN_LIVE_TURN=1 CODEX_CAPABILITY_SPIKE_OUT=/tmp/codex-app-server-capability-spike-20260604-live.json npx tsx examples/codex-app-server-capability-spike.ts`

## Contract Drift Check

The plan change is acceptable adaptation: Phase 3.5 was introduced before Phase 4 because production-readiness questions could alter facade workflow design. The result does not change the architecture boundary; it sharpens Phase 4 constraints.

No CodeTour was generated for this audit because the completed slice is a capability spike plus docs/todo re-plan, not a new runtime workflow implementation.

## Bank Handoff Candidates

- Persisted rollout is the evidence boundary for Codex `thread/resume`; no-turn thread creation is not enough.
- Unknown-field tolerance is not capability support; dynamic tool refresh must be proven from schema/source plus behavior, not from a request merely succeeding.
