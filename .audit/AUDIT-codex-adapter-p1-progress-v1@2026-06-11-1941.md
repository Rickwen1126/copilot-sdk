# AUDIT: Codex Adapter P1 Progress v1

Created: 2026-06-11 19:41
Last Updated: 2026-06-11 19:41
Status: Passed
Tags: [audit, codex-adapter, p1, conformance-harness]

## 0. Scope

- Artifact: P1 progress after the previous formal audit, from `dacc3db` to `9e1baa1`.
- Previous audit: `.audit/AUDIT-codex-adapter-p0-production-readiness-v1@2026-06-11-1150.md`
- Diff / commits:
  - `7954cea62b509b11e81eaa6ab8c648c19047c0e7 docs: record codex adapter graduation decision`
  - `8f8cf12fcefc6bedc4bdc4965dcce164313f9572 refactor: remove stale inline codex harness`
  - `9e1baa1893d148163316eb8239f2ccdcafc67553 refactor: extract codex conformance ledger`
- SHIP record: `.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md`
- CodeTour: `.tours/audit-codex-adapter-p1-progress-20260611-1941.tour`
- Tests / evidence:
  - `npx vitest run test/codex-conformance-ledger.test.ts test/codex-conformance-proof.test.ts`
  - `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/copilot-codex-adapter-spike.ts test/codex-conformance-ledger.test.ts conformance/codexConformanceLedger.ts`
  - `npx eslint examples/copilot-codex-adapter-spike.ts conformance/codexConformanceLedger.ts test/codex-conformance-ledger.test.ts`
  - `npm run build`
  - `git diff dacc3db..HEAD --check`

## 1. Verdict

**Result**: Passed for the current P1 progress slice.

**Reason**: The changes preserve the P0 selected-profile boundary, make the adapter graduation decision explicit, remove stale inactive inline harness code, and extract the first conformance harness brick without changing runtime adapter behavior.

**Blocking count**: 0

**Bank candidates**: 2

This audit does not close Phase 5. `docs/todo.md` correctly keeps Phase 5 active because scenario, runner, assertion, report, and fixture responsibilities still need decomposition.

## 2. Findings

### Blocking

| Severity | Location | Problem                                                                    | Evidence                                           | Impact                   | Fix / verification                                                    |
| -------- | -------- | -------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| blocking | none     | No blocking correctness, security, or boundary issues found in this scope. | Review of `dacc3db..HEAD` plus tests listed above. | Current slice can stand. | Continue Phase 5 by extracting the next harness responsibility brick. |

### Non-Blocking

| Severity     | Location          | Problem                                                                       | Evidence                                                                                                                                        | Impact                                                                                                                | Fix / verification                                                                                                    |
| ------------ | ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| non-blocking | `docs/todo.md:17` | Full selected-profile conformance was not rerun after the harness extraction. | The rerun evidence covers unit tests, typecheck, lint, build, and whitespace checks, but not a full live selected-profile conformance artifact. | Acceptable for this pure ledger brick, but not enough to close Phase 5 or claim before/after conformance equivalence. | Before Phase 5 closeout, run or compare the selected-profile conformance artifact and record the before/after result. |

### Learning Findings

| Location                                                                   | Pattern                                               | Exit question                                                                                                        | Gap | Next action                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------- |
| `docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md:9` | Graduation is an API promise, not a readiness trophy. | Why does keeping the adapter experimental reduce future compatibility risk even after P0 readiness passed?           | B   | Bank candidate.                               |
| `nodejs/conformance/codexConformanceLedger.ts:45`                          | Harness extraction should follow evidence ownership.  | Which evidence does ledger normalization own, and which evidence still belongs to assertions/report/scenario layers? | B   | Use next Phase 5 brick to sharpen the answer. |

## 3. SHIP Contract Check

- Problem Statement drift: no drift. The SHIP problem was spike gravity in adapter/harness code; this scope reduces that gravity in the graduation decision, stale inline harness removal, and ledger extraction.
- Solution choice drift: no drift. The scope follows "pattern-guided extraction around real seams" rather than building a generic runtime framework.
- Technical decision drift: no drift. The adapter remains behind `./experimental/codex-adapter`, and the new conformance module is harness support, not a new public runtime framework.
- [B]lock status: no `[B]` items were present in the SHIP.
- [R]isky status:
  - Pattern choice by variation axis: validated for this slice. The new module exists because ledger observation is a real ownership boundary.
  - Runtime adapter boundary: validated. No Chatpilot route/memory semantics moved into adapter internals.
  - Contract tests as architecture guard: partially validated. Unit tests cover ledger behavior, but full selected-profile conformance remains a future Phase 5 closeout requirement.
  - Protocol/type boundaries: unchanged by this scope.
- Audit probes:
  - "Fewer mixed responsibilities without large generic abstraction layer": answered yes for ledger normalization.
  - "Same artifacts prove behavior before/after extraction": partially answered; unit/build evidence exists, full selected-profile artifact comparison is still deferred.

## 4. LOS Learning Check

| Learning point                       | LOS family             | Audit probe                                                                      | Result              | Bank candidate | Follow-up                                                         |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------------------- | ------------------- | -------------- | ----------------------------------------------------------------- |
| Pattern choice by variation axis     | design-patterns        | Does extraction follow pressure/ownership instead of pattern catalog aesthetics? | validated           | yes            | Bank the "API promise vs readiness trophy" distinction if useful. |
| Runtime adapter boundary             | software-architecture  | Did app substrate semantics stay outside the runtime backend?                    | validated           | no             | Continue watching next harness bricks.                            |
| Contract tests as architecture guard | testing                | Did the refactor preserve dataflow evidence and silent-failure detection?        | partially validated | yes            | Run selected-profile conformance before Phase 5 closeout.         |
| Protocol/type boundaries             | typescript-type-system | Did protocol-v2/v3 behavior remain explicit?                                     | unchanged           | no             | Re-audit if next extraction touches protocol/tool lanes.          |

## 5. CodeTour / Understanding Re-Audit

**Tour created by `codetour`**: `.tours/audit-codex-adapter-p1-progress-20260611-1941.tour`

| Question                                                                         | Type      | Expected anchor                                                            | User answer | Status  | Follow-up                                                                                        |
| -------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------ |
| Why is `./experimental/codex-adapter` still the correct surface after P0 passed? | trade-off | `docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md:9` | pending     | pending | User should distinguish selected-profile readiness from stable general SDK API promise.          |
| What exact evidence does `codexConformanceLedger.ts` own now?                    | mechanism | `nodejs/conformance/codexConformanceLedger.ts:45`                          | pending     | pending | User should name transcript normalization, baseline/adapter ledger collection, and hop matching. |
| What would make this Phase 5 slice unsafe to close without more evidence?        | failure   | `docs/todo.md:17`                                                          | pending     | pending | User should identify missing full selected-profile conformance comparison.                       |

## 6. Evidence And Tests

- Tests run:
  - `npx vitest run test/codex-conformance-ledger.test.ts test/codex-conformance-proof.test.ts` -> pass, 11 tests
  - `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/copilot-codex-adapter-spike.ts test/codex-conformance-ledger.test.ts conformance/codexConformanceLedger.ts` -> pass
  - `npx eslint examples/copilot-codex-adapter-spike.ts conformance/codexConformanceLedger.ts test/codex-conformance-ledger.test.ts` -> pass
  - `npm run build` -> pass
  - `git diff dacc3db..HEAD --check` -> pass
- Data-level verification:
  - Ledger tests assert normalized payload fields, error status detection, hop counts, and recording collection.
  - No DB, schema, or runtime service state changed.
- Logs / traces:
  - No new live runtime transcript was generated in this slice.
- Visual verification:
  - Not applicable.
- Missing evidence:
  - Full selected-profile conformance comparison is still missing for Phase 5 closeout. This is explicitly non-blocking for the current pure ledger extraction slice.
- Local warning:
  - Commands emitted `pyenv: cannot rehash: /Users/rickwen/.pyenv/shims isn't writable`, but the relevant commands exited successfully.

## 7. Bank Handoff Candidates

| Candidate                                                         | Type         | Why stable enough?                                                                  | Target |
| ----------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- | ------ |
| "Graduation is an API promise, not a readiness trophy."           | mental-model | This decision is now documented and anchored in package surface risk.               | bank   |
| "Conformance harness modules should split by evidence ownership." | checklist    | The first extracted brick demonstrates the pattern and the remaining work is named. | bank   |

## 8. Next Action

- [ ] Continue Phase 5 by extracting report/check assertion assembly or fixture/workdir helpers.
- [ ] Before claiming Phase 5 closeout, run or compare selected-profile conformance artifacts.
- [ ] After the user reviews the CodeTour, complete the understanding re-audit questions above.
- [ ] Proceed to BANK only after the user agrees these mental models are stable enough to deposit.
