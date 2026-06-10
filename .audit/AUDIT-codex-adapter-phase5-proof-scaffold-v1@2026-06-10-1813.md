# AUDIT: codex-adapter-phase5-proof-scaffold v1

Created: 2026-06-10-1813
Last Updated: 2026-06-10-1813
Status: Needs More Evidence
Tags: [audit, codex-adapter, phase5, testing, conformance]

## 0. Scope

- Artifact: Phase 5 proof scaffold for Codex adapter conformance infrastructure.
- Diff / commits: `3d68227 test: scaffold codex adapter phase 5 proof reports`; audit-discovered fix `fac582b fix: guard chatpilot acceptance session count`.
- SHIP record: `.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md`.
- CodeTour: `.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour`.
- Tests / evidence: unit/type/build checks listed in section 6; no live Chatpilot/Codex acceptance artifact for A6/B5/C2 yet.

## 1. Verdict

**Result**: Needs More Evidence
**Reason**: The scaffold correctly creates reusable proof language and a multi-session harness entrypoint, but it intentionally does not yet satisfy Phase 5 production proof completion. Live A6 multi-session evidence, B5 full tool schema round-trip evidence, and C2 representative tool-call benchmark evidence remain open.
**Blocking count**: 0 after `fac582b`.
**Bank candidates**: proof-language mental model; conformance harness checklist.

## 2. Findings

### Blocking

| Severity | Location | Problem | Evidence | Impact | Fix / verification |
|---|---|---|---|---|---|
| blocking-fixed | `nodejs/examples/chatpilot-runtime-acceptance.ts:118` | `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS` originally used `Math.max(1, Number(value))`, so invalid input could become `NaN` and produce no sessions. | Audit review of `3d68227`; fixed in `fac582b` by `positiveIntegerEnv()` at `nodejs/examples/chatpilot-runtime-acceptance.ts:430`. | A bad env value could make the acceptance harness fail before producing useful evidence. | Fixed; single-file typecheck and scoped Vitest passed. |

### Non-Blocking

| Severity | Location | Problem | Evidence | Impact | Fix / verification |
|---|---|---|---|---|---|
| non-blocking | `docs/todo.md:17` | Phase 5 remains open even though the scaffold exists. | `docs/todo.md:20-21` explicitly marks partial evidence and remaining live artifacts. | Correctly prevents over-claiming production readiness. | Produce live A6/B5/C2 artifacts before moving todo to finished. |
| non-blocking | `nodejs/examples/chatpilot-runtime-acceptance.ts:859` | Native-tool detection is conservative and report-level, not prompt-local. | `extractKnownNativeToolCalls()` scans the adapter summary and attaches matches to both save/list observations. | Good enough as a first safety alarm; not enough for final C2 benchmark attribution. | C2 runner should record prompt-local native tool calls from structured ledger entries. |
| non-blocking | `nodejs/src/experimental/codexConformanceProof.ts:67` | Schema round-trip helper is ready but not yet wired to a real Chatpilot 26-tool manifest. | Unit tests cover two synthetic tools, missing tools, mutation, and unexpected tools. | B5 is not closed until the real descriptor source feeds this report. | Build/choose manifest extraction, then run `buildToolSchemaRoundTripReport()` over all Chatpilot tools. |

### Learning Findings

| Location | Pattern | Exit question | Gap | Next action |
|---|---|---|---|---|
| `nodejs/src/experimental/codexConformanceProof.ts:137` | Proof helpers separate evidence interpretation from live process orchestration. | Why is this safer than putting pass/fail logic directly inside the acceptance runner? | A | Bank after live evidence confirms the shape holds. |
| `nodejs/examples/chatpilot-runtime-acceptance.ts:236` | Multi-session acceptance should prove isolation by session evidence, not just process success. | Which assertion would fail first if two concurrent routes reused the same SDK session id? | B | Run live A6 artifact and inspect per-session `sessions[]`. |

## 3. SHIP Contract Check

- Problem Statement drift: none. The work keeps targeting spike-to-proof infrastructure cleanup, not a generic runtime framework.
- Solution choice drift: acceptable adaptation. Phase 5 started with proof-language extraction before full harness decomposition, which matches the plan's "split by responsibility" direction.
- Technical decision drift: none. Chatpilot route/memory/tool semantics remain outside the Codex adapter; the new module is pure proof interpretation.
- [B]lock status: no new block.
- [R]isky status: "Conformance harness as contract evidence" remains risky until live A6/B5/C2 artifacts exist.
- Audit probes: partially answered. Unit checks prove report semantics; live send/response, tool call transcript, memory side effects, and backend parity remain pending for Phase 5.

## 4. LOS Learning Check

| Learning point | LOS family | Audit probe | Result | Bank candidate | Follow-up |
|---|---|---|---|---|---|
| Runtime adapter boundary | software-architecture | No Chatpilot route/memory ownership leaks into Codex adapter internals | validated for scaffold | yes | Keep B5/C2 manifest/runner outside adapter runtime modules. |
| Conformance harness as contract evidence | testing | Same evidence must prove SDK send/response, tool calls, memory side effects, and parity | partial | yes | Live A6/B5/C2 artifacts needed before Phase 5 pass. |
| Protocol/tool lanes expose variants without hiding validation | typescript-type-system | Tool proof report should preserve missing/mutated/not-run evidence | validated for helper tests | maybe | Bank after real 26-tool run verifies the abstraction. |

## 5. CodeTour / Understanding Re-Audit

**Tour used / created by `codetour`**: `.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour`

| Question | Type | Expected anchor | User answer | Status | Follow-up |
|---|---|---|---|---|---|
| Where does a tool-call benchmark observation become a failing assertion? | mechanism | `nodejs/src/experimental/codexConformanceProof.ts:155` and `:187` | pending | pending | Review tour steps 2-3. |
| If a multi-session run silently reuses the same SDK session id, which assertion catches it? | failure | `nodejs/examples/chatpilot-runtime-acceptance.ts:310` | pending | pending | Run A6 live artifact and inspect report. |
| Why is this audit result not "Passed"? | trade-off | `docs/todo.md:20-21` and `conformance-artifacts.md:100-103` | pending | pending | Keep Phase 5 todo open until live evidence lands. |

## 6. Evidence And Tests

- Tests run:
  - `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 22 tests
  - `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/chatpilot-runtime-acceptance.ts` -> pass
  - prior scaffold run: `npx tsc --noEmit` -> pass
  - prior scaffold run: `npx prettier --check src/experimental/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
  - prior scaffold run: `npm run build` -> pass
- Data-level verification: not run in this audit; A6 live artifact still needed.
- Logs / traces: not run in this audit; C2 prompt-local structured ledger still needed.
- Visual verification: not applicable.
- Missing evidence: live multi-session acceptance, real 26-tool schema round-trip, representative compliance benchmark.

## 7. Bank Handoff Candidates

| Candidate | Type | Why stable enough? | Target |
|---|---|---|---|
| "Proof language before live benchmark scale" | mental-model | The scaffold shows a reusable way to keep pass/fail interpretation pure before adding live runners. | bank |
| "Do not close production proof from scaffold evidence" | checklist | The todo/artifact split is a useful review guard against over-claiming readiness. | bank |

## 8. Next Action

- [ ] Commit this AUDIT and tour.
- [ ] Produce live A6 with `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS`.
- [ ] Build B5 Chatpilot 26-tool manifest/schema round-trip runner.
- [ ] Design C2 prompt matrix with prompt-local native-tool attribution.
