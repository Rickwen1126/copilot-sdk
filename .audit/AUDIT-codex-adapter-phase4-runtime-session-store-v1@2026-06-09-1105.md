# AUDIT: Codex Adapter Phase 4 Runtime Session Store

Created: 2026-06-09 11:05
Status: Pass with residual Phase 4 work
Commit: `044f5d5 refactor: persist codex runtime session mapping`

## Verdict

No blocking findings for this slice.

This brick fixes the adapter-side half of A4: after an adapter server process restart, `resumeSession(sessionId)` no longer has to fail immediately because `this.sessions` is empty. The adapter can now recover the SDK-session-to-Codex-runtime-session mapping from a persisted store and call `thread/resume` for the mapped Codex thread.

Phase 4 is still active.

## Blocking Findings

None.

## Non-Blocking Findings

- Severity: residual production setup
- File: `nodejs/src/experimental/codexAdapter.ts:862`
- Problem: the persisted mapping includes `codexHomeIdentity`, but production restart continuity also requires the new adapter/app-server to use the same durable Codex runtime storage.
- Evidence: this brick stores the mapping; it does not change the gateway's default isolated temporary Codex home behavior.
- Impact: if runtime uses a new temp Codex home after restart, the mapping may point to a thread id whose rollout is not in that runtime home.
- Suggested fix: document and/or enforce stable `CODEX_ADAPTER_CODEX_HOME` plus `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH` for production resume lanes.

- Severity: residual Phase 4 policy
- File: `nodejs/src/experimental/codexAdapter.ts:880`
- Problem: resumed sessions rebuild `tools` from the resume request but do not yet compare against the stored `toolFingerprint`.
- Evidence: store records `toolFingerprint`, but no compatibility policy rejects, forks, or recreates incompatible tool-set resumes yet.
- Impact: Chatpilot route reuse with changed tool sets may still resume a Codex thread whose dynamic tool set was created under a prior session.create shape.
- Suggested fix: implement the B2/B3 tool-set compatibility policy brick.

- Severity: fidelity follow-up
- File: `nodejs/src/experimental/codexAdapter.ts:893`
- Problem: a session reconstructed from store starts with an empty SDK-visible `events` list.
- Evidence: `sessionFromRecord` initializes `events: []`.
- Impact: restart resume can continue the runtime conversation, but `getMessages()` after adapter restart does not replay pre-restart SDK event history.
- Suggested fix: decide whether product acceptance needs SDK event replay. If yes, reconstruct from Codex `thread/read`, persist adapter SDK events, or explicitly document reduced fidelity.

## Contract Check

- Runtime-adapter boundary held: the new store persists adapter mapping state, not Codex internal rollout data.
- Gateway/mapper boundary held: no Codex IO moved into the store; it remains a pure file-backed mapping layer.
- A4 adapter-side gap improved: `handleSessionResume` now falls back to `sessionStore.get(sessionId)` before returning `Unknown session` at `nodejs/src/experimental/codexAdapter.ts:661`.
- Delete lifecycle remained correct: `session.delete` removes the persisted mapping after `thread/archive` at `nodejs/src/experimental/codexAdapter.ts:843`.

## Evidence

- Unit / mapper tests: `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` passed, 28 tests.
- Type check: scoped `npx tsc --noEmit ...` passed.
- Lint: scoped `npx eslint ...` passed.
- Build: `npm run build` passed.
- Selected-profile conformance: `/tmp/copilot-codex-refactor-phase4-store.json`, run `27a75582-8f74-41b6-8199-892466c70b83`, verdict `pass`.
- Chatpilot acceptance: `/tmp/chatpilot-codex-refactor-phase4-store.json`, run `ef283cd1-3423-45ad-8f29-0fae12409106`, status `pass`.
- Repo summary artifact: `docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-runtime-session-store@2026-06-09-1102.summary.json`.

## Review Notes

- A focused CodeTour is recommended only if the user wants to review store mechanics in detail. The diff is small enough to review from the store file, resume handler, and restart simulation test.
- The key semantic distinction remains: the store is an index from SDK session identity to Codex conversation identity. It is not a second transcript database.

## Bank Handoff

Potential learning note: durable restart continuity has two separate proofs. The adapter must remember which Codex conversation belongs to the SDK session, and Codex must be able to load that conversation from stable runtime storage. A mapping store solves the first; stable Codex home / rollout identity solves the second.
