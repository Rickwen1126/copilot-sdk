# AUDIT: Codex Adapter P1 Closeout v1

Created: 2026-06-11 23:36
Last Updated: 2026-06-11 23:36
Status: Passed
Tags: [audit, codex-adapter, p1, conformance-harness, policy]

## 0. Scope

- Artifact: P1 Runtime Adapter Refactor Architecture Guard closeout after the previous P1 progress audit.
- Previous audit artifact: `.audit/AUDIT-codex-adapter-p1-progress-v1@2026-06-11-1941.md`
- Previous audit coverage: implementation through `9e1baa1893d148163316eb8239f2ccdcafc67553`.
- Current implementation scope:
  - `f7ea09346db43182b663352dd767ff6141ef17e7 refactor: extract codex conformance report assembly`
  - `4c6f75624936a2a7aee87c79ab1180645f0903ed refactor: centralize optional probe status checks`
  - `0354f274addcffc6dfbe02eb8721552383416375 refactor: extract codex tool probe assertions`
  - `3fcfcd08c44c833dde8e1cd2a6755baa70b18c95 refactor: extract codex approval probe helpers`
  - `c8168a06f13a0d2810f11f616810091c091be67e refactor: extract codex tool factory helpers`
  - `9087c8c31d4f098d2f1bd9f920f60f422f0c5d4d refactor: extract codex protocol recorder`
  - `31b6a5ffa1e97fbc65bbac214facb8e31e1e8dc9 refactor: extract codex scenario event state`
  - `fcaa5e1c6a38a28bad3ded9de8a9a89d7f97ed0a docs: close codex conformance decomposition phase`
  - `6c0a8dbb91b0becf0629d6acd849a093fa0c8499 refactor: extract codex dynamic tool policy`
- SHIP record: `.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md`
- CodeTour: `.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour`
- Tests / evidence:
  - `npx vitest run test/codex-adapter-tool-policy.test.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` -> pass, 36 tests
  - `npx vitest run test/codex-conformance-scenario-state.test.ts test/codex-conformance-protocol-recorder.test.ts test/codex-conformance-tool-factory.test.ts test/codex-conformance-approval-probe.test.ts test/codex-conformance-tool-probe.test.ts test/codex-conformance-report.test.ts test/codex-conformance-ledger.test.ts test/codex-conformance-proof.test.ts` -> pass, 41 tests
  - scoped `npx tsc` for touched adapter/policy/harness files -> pass
  - scoped `npx eslint` for touched adapter/policy/harness files -> pass
  - `npm run build` -> pass
  - selected-profile comparison `/tmp/copilot-codex-selected-profile-20260611-2320.json` -> pass, run `e627ec9c-5ae6-4a36-b843-df215cd728bd`
  - selected-profile comparison `/tmp/copilot-codex-phase6-policy-20260611-2330.json` -> pass, run `1024a103-364b-4b94-ac54-6de5e808ddf1`

## 1. Verdict

**Result**: Passed

**Reason**: The post-audit work completes Phase 5 conformance harness decomposition, completes Phase 6 conditional policy extraction without pattern theater, preserves selected-profile behavior with full comparison artifacts, and updates canonical docs/code map to reflect the final module surfaces.

**Blocking count**: 0

**Bank candidates**: 2

## 2. Findings

### Blocking

| Severity | Location | Problem                                                                             | Evidence                                                                                        | Impact             | Fix / verification                                                                                           |
| -------- | -------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| blocking | none     | No blocking correctness, security, boundary, or evidence issue found in this scope. | Code review of changed adapter/conformance surfaces plus selected-profile comparison artifacts. | Phase 7 can close. | Keep final docs/todo/archive in sync and preserve raw artifact hashes instead of committing raw transcripts. |

### Non-Blocking

| Severity     | Location | Problem                                                                | Evidence                                                                                                 | Impact                   | Fix / verification                                                                           |
| ------------ | -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| non-blocking | none     | No non-blocking implementation issue found that should delay closeout. | The new policy helper has real v2/v3 variants, dedicated tests, and live selected-profile pass evidence. | Current scope can stand. | Re-audit only if future work adds another backend or changes dynamic-tool protocol behavior. |

### Learning Findings

| Location                                               | Pattern                                                                           | Exit question                                                                                      | Gap | Next action     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --- | --------------- |
| `nodejs/src/experimental/codexAdapterToolPolicy.ts:34` | Strategy/Policy extraction is justified by real variation, not naming aesthetics. | Why is protocol-v2/v3 dynamic-tool routing a valid policy while approval mapping remains a mapper? | B   | Bank candidate. |
| `nodejs/conformance/codexConformanceReport.ts:45`      | Conformance evidence needs explicit pass/fail/not-run semantics.                  | What silent-failure case would `statusFromOptionalProbe()` catch?                                  | B   | Bank candidate. |

## 3. SHIP Contract Check

- Problem Statement drift: no drift. The SHIP target was spike gravity in adapter/harness code; the closeout splits harness evidence ownership and isolates the one real policy variation axis.
- Solution choice drift: no drift. The implementation follows pattern-guided extraction around real seams and explicitly avoids a generic runtime framework.
- Technical decision drift: no drift. The adapter remains experimental; raw gateway classes and internal runtime implementation subpaths remain out of the public package API.
- [B]lock status: none in the SHIP.
- [R]isky status:
  - Pattern choice by variation axis: validated. Phase 6 extracted only protocol-v2/v3 dynamic-tool routing and documented no-extraction decisions for non-variant candidates.
  - Runtime adapter boundary: validated. Chatpilot route identity, memory ownership, and tool registration remain outside adapter internals.
  - Conformance harness as architecture guard: validated for this milestone. Before/after selected-profile artifacts pass all seven checks with `missing=[]`.
  - Protocol-v2/v3 and tool-call split: validated. The policy helper keeps the split explicit, and selected-profile custom tool / tool failure checks still pass.
- Audit probes:
  - "Fewer mixed responsibilities without large generic abstraction layer": answered yes.
  - "Same conformance/acceptance artifacts still prove behavior": answered yes for selected-profile conformance; Chatpilot P0 acceptance remains indexed from the prior P0 closeout.
  - "Protocol-v2/v3 tool lanes remain explicit": answered yes in `codexAdapterToolPolicy.ts`.

## 4. LOS Learning Check

| Learning point                           | LOS family             | Audit probe                                                    | Result    | Bank candidate | Follow-up                                               |
| ---------------------------------------- | ---------------------- | -------------------------------------------------------------- | --------- | -------------- | ------------------------------------------------------- |
| Pattern choice by variation axis         | design-patterns        | Did the extraction follow real variation pressure?             | validated | yes            | Bank the "policy needs a second behavior" checklist.    |
| Runtime adapter boundary                 | software-architecture  | Did app substrate semantics stay outside runtime backend code? | validated | no             | Keep watching if future runtime backends are added.     |
| Conformance harness as contract evidence | testing                | Did decomposition preserve data/trace/intent proof quality?    | validated | yes            | Bank the optional-probe pass/fail/not-run mental model. |
| Protocol/tool type boundaries            | typescript-type-system | Did v2/v3 behavior remain explicit?                            | validated | no             | Re-audit if protocol API becomes public.                |

## 5. CodeTour / Understanding Re-Audit

**Tour created by `codetour`**: `.tours/audit-codex-adapter-p1-closeout-20260611-2336.tour`

| Question                                                                                                | Type      | Expected anchor                                                                                              | User answer | Status  | Follow-up                                                                                             |
| ------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ | ----------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Why is `planDynamicToolCallRouting()` a legitimate policy helper but approval mapping remains a mapper? | trade-off | `nodejs/src/experimental/codexAdapterToolPolicy.ts:34`, `nodejs/src/experimental/codexAdapterMappers.ts:224` | pending     | pending | User should identify the real v2/v3 behavior split and the lack of second live approval strategy.     |
| What fails first if v3 dynamic-tool request ids are not stable?                                         | failure   | `nodejs/src/experimental/codexAdapter.ts:1226`, selected-profile custom tool check                           | pending     | pending | User should connect request id stability to `session.tools.handlePendingToolCall`.                    |
| Why does the report module need `not-run` instead of just pass/fail?                                    | mechanism | `nodejs/conformance/codexConformanceReport.ts:72`                                                            | pending     | pending | User should distinguish unconfigured optional probes from configured probes missing backend evidence. |

## 6. Evidence And Tests

- Tests run:
  - `npx vitest run test/codex-adapter-tool-policy.test.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` -> pass, 36 tests
  - `npx vitest run test/codex-conformance-scenario-state.test.ts test/codex-conformance-protocol-recorder.test.ts test/codex-conformance-tool-factory.test.ts test/codex-conformance-approval-probe.test.ts test/codex-conformance-tool-probe.test.ts test/codex-conformance-report.test.ts test/codex-conformance-ledger.test.ts test/codex-conformance-proof.test.ts` -> pass, 41 tests
  - scoped `npx tsc` -> pass
  - scoped `npx eslint` -> pass
  - `npm run build` -> pass
- Data-level verification:
  - Selected-profile comparison `/tmp/copilot-codex-selected-profile-20260611-2320.json` passed all seven checks for both backends, with `traceParity`, `dataAssertion`, and `intentAssertion` all passing and `missing=[]`.
  - Selected-profile comparison `/tmp/copilot-codex-phase6-policy-20260611-2330.json` passed the same seven checks after policy extraction.
- Logs / traces:
  - Raw artifacts remain in `/tmp` and are indexed by command, run id, and sha256 in `docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md`.
- Visual verification:
  - Not applicable.
- Missing evidence:
  - No missing evidence for the Phase 7 closeout claim. Full Chatpilot acceptance was not rerun in this final P1 closeout because this scope did not change Chatpilot runtime acceptance code or app-level data paths after the P0 closeout.

## 7. Bank Handoff Candidates

| Candidate                                                                         | Type         | Why stable enough?                                                                 | Target |
| --------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ------ |
| "A policy helper needs a real second behavior; otherwise keep a pure mapper."     | checklist    | Phase 6 contains both the positive example and documented no-extraction decisions. | bank   |
| "Optional conformance probes need pass/fail/not-run, not only boolean pass/fail." | mental-model | The report module and selected-profile artifacts now encode the distinction.       | bank   |

## 8. Next Action

- [x] Archive Phase 7 in `docs/todo-finished.md`.
- [x] Keep `docs/todo.md` empty of completed P1 phases.
- [ ] Use BANK later if the two learning candidates are worth depositing.
