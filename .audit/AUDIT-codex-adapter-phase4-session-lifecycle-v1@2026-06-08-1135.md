# AUDIT: Codex Adapter Phase 4 Session Lifecycle

Created: 2026-06-08 11:35
Status: Pass with residual Phase 4 work
Commit: `64b89c6 refactor: harden codex session lifecycle`

## Verdict

No blocking findings for this slice.

This milestone brick correctly moves Codex adapter session lifecycle from the Phase 3 spike shape toward the Phase 3.5 production constraints: persisted Codex threads, explicit Codex resume, unsubscribe on SDK disconnect, archive on SDK delete, and idempotent disconnect cleanup.

Phase 4 is not complete. This audit only accepts the session lifecycle brick.

## Blocking Findings

None.

## Non-Blocking Findings

- Severity: residual Phase 4 scope
- File: `nodejs/src/experimental/codexAdapter.ts:628`
- Problem: adapter session lookup is still backed by the in-memory `sessions` map.
- Evidence: `handleSessionResume` still returns `Unknown session` if the adapter process has lost its SDK-session-to-Codex-thread mapping.
- Impact: this slice proves disconnect/resume within the same adapter process and live app-server thread subscription lifecycle. It does not yet prove adapter-process restart continuity.
- Suggested next step: implement or explicitly design the persisted adapter mapping for `(sdkSessionId, codexThreadId, cwd, model, tools)` before marking A4 fully closed.

- Severity: residual Phase 4 scope
- File: `nodejs/src/experimental/codexAdapter.ts:642`
- Problem: `session.resume` does not yet enforce the Phase 3.5 `dynamicTools` policy.
- Evidence: resume forwards Codex lifecycle params but does not compare resumed SDK tool descriptors against the stored session tool set.
- Impact: Chatpilot route reuse with incompatible tool sets may still reuse a stale Codex thread unless later policy rejects, forks, or recreates.
- Suggested next step: add a tool-set compatibility policy brick and tests before closing B2/B3-style resume policy work.

## Contract Check

- Phase 3.5 constraint matched: `session.create` uses non-ephemeral Codex threads at `nodejs/src/experimental/codexAdapter.ts:547`.
- Phase 3.5 constraint matched: `session.resume` calls Codex `thread/resume` before reporting SDK resume success at `nodejs/src/experimental/codexAdapter.ts:642`.
- Phase 3.5 constraint matched: SDK `disconnect()` / `session.destroy` maps to `thread/unsubscribe` without deleting adapter session state at `nodejs/src/experimental/codexAdapter.ts:753`.
- Phase 3.5 constraint matched: SDK `deleteSession()` maps to Codex `thread/archive` and removes adapter state at `nodejs/src/experimental/codexAdapter.ts:785`.
- Boundary discipline held: changes stay inside the experimental adapter public subpath and its tests; root SDK exports are unchanged.

## Evidence

- Unit / mapper tests: `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed, 27 tests.
- Type check: scoped `npx tsc --noEmit ...` passed.
- Lint: scoped `npx eslint ...` passed.
- Build: `npm run build` passed.
- Selected-profile conformance: `/tmp/copilot-codex-refactor-phase4-lifecycle-3.json`, run `954753ec-dcd8-4f58-b293-f209819f74c0`, verdict `pass`.
- Chatpilot acceptance: `/tmp/chatpilot-codex-refactor-phase4-lifecycle.json`, run `a599a278-329e-499c-93a3-5396b092c96e`, status `pass`.
- Repo summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-session-lifecycle@2026-06-08-1130.summary.json`.

## Review Notes

- CodeTour was not generated for this slice because the diff is narrowly contained in one workflow file plus one characterization test.
- Suggested user review path: read the lifecycle methods in `nodejs/src/experimental/codexAdapter.ts`, then the fake-gateway test in `nodejs/test/codex-adapter.test.ts`, then the summary artifact.

## Bank Handoff

Potential learning note: SDK disconnect is not deletion. In this adapter boundary, disconnect means "detach this traveler from the station" (`thread/unsubscribe`), while delete means "archive/remove the journey" (`thread/archive`). Resume must reopen the Codex-side journey (`thread/resume`) before the SDK-facing session can claim continuity.
