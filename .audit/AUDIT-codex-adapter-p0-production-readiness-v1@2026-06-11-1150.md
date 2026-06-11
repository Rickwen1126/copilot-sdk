# AUDIT: Codex Adapter P0 Production Readiness

Created: 2026-06-11 11:50
Status: Pass
Scope: P0 production readiness closure for the selected Chatpilot Codex adapter profile
Reviewed head: `58981b3f3304269377db9e2f23acee69b8931ca8`
Review tour: [.tours/skyeye-codex-adapter-p0-production-readiness-20260611-1150.tour](../.tours/skyeye-codex-adapter-p0-production-readiness-20260611-1150.tour)

## Verdict

P0 is closed for the selected Chatpilot Codex adapter profile.

The closure is appropriately scoped: it does not claim full Copilot CLI parity, direct Codex dynamic-tool multimodal output, or live metrics / health endpoint integration. B7 and D3 are explicitly deferred P2 follow-ups, with policy evidence explaining why they are not blockers for the current profile.

## Blocking Findings

None.

## Non-Blocking Findings

### P2 Follow-Up: B7 direct multimodal tool-result output remains unclaimed

Evidence:

- [production-readiness@2026-06-04-1953.md](../docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md) marks B7 as a non-blocking P2 deferral for the selected profile.
- [production-runbook.md](../docs/integrations/codex-sdk-runtime-profile/production-runbook.md) states that `batch_image_analyze` and `download_media` return text-to-LLM summaries, while `show_image` sends media to the user-facing channel.
- [refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json](../docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json) records explicit multimodal policy decisions.

Impact:

Acceptable for P0. A future product path that needs image/audio/file bytes returned directly to Codex as dynamic-tool output must open a new capability gate.

### P2 Follow-Up: D3 live metrics / health endpoints remain unclaimed

Evidence:

- The runbook keeps `CODEX_ADAPTER_SUMMARY_PATH` and retained process stdout/stderr as the P0 observability contract.
- The Phase 6 artifact records live metrics / health endpoint integration as P2 until staged deployment requires it.

Impact:

Acceptable for P0. A staged or production deployment should add live health/metrics before relying on long-running operations beyond bounded transcript summaries and process logs.

### Hygiene Note: Raw auth smoke must remain outside git

Evidence:

- [conformance-artifacts.md](../docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md) records `/tmp/codex-phase6-auth-smoke-20260611-1143.json` only by hash and boolean evidence.
- The repo summary records `account/read refreshToken=false`, `account/read refreshToken=true`, and `model/list`, without copying account identity details.

Impact:

Correct current handling. Future closeouts should keep raw auth artifacts out of the repo unless they are scrubbed first.

## Evidence Matrix

| Gate                                          | Result               | Evidence                                                                                                                                                                              |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 lifecycle hardening                   | Pass                 | Archived in [docs/todo-finished.md](../docs/todo-finished.md) and indexed through [conformance-artifacts.md](../docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md) |
| Phase 5 A6 multi-session acceptance           | Pass                 | Live artifact `/tmp/chatpilot-codex-phase5-live-20260611-1037.json`, sha256 `ccff597a01cb24ef4c6becd250376f5bdcf12e55f40581641c0097af5c4fdbf8`                                        |
| Phase 5 B5 26-tool schema round-trip          | Pass                 | Live artifact reports 26 expected and 26 observed Codex dynamic tools                                                                                                                 |
| Phase 5 safe C2 live slice                    | Pass                 | Cross-backend artifact `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json`, sha256 `751317ac53ceff2c8e1ded28cf754ab838207b3145b7ff3b5a97d3dddbb3e941`                       |
| Phase 6 C2 residual safe 26-tool surrogate    | Pass                 | Phase 6 summary reports 26 prompt cases covering 26 tools, all side-effecting prompts marked `dry-run-only`                                                                           |
| Phase 6 B6 namespace audit                    | Pass                 | No collisions with `apply_patch`, `local_shell`, `read_file`, `shell`, `update_plan`, or `write_file`                                                                                 |
| Phase 6 C3/C4 behavior and description checks | Pass                 | Phase 5 observed no native Codex tool calls; Phase 6 reports zero description issues                                                                                                  |
| Phase 6 D2 auth inheritance smoke             | Pass                 | Isolated app-server smoke validates account read with and without refresh plus model listing                                                                                          |
| B7 / D3                                       | Explicit P2 deferral | Recorded in production readiness, runbook, unsupported-capabilities, and Phase 6 summary                                                                                              |

## Verification Run

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 24 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/codex-adapter-phase6-policy-audit.ts examples/codex-app-server-smoke.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/codex-adapter-phase6-policy-audit.ts examples/codex-app-server-smoke.ts` -> pass
- `npm run build` -> pass
- `./nodejs/node_modules/.bin/prettier --check ...` -> pass
- `git diff --check` -> pass

Note: local commands emitted `pyenv: cannot rehash: /Users/rickwen/.pyenv/shims isn't writable`, but exited successfully.

## Understanding Re-Audit

Question:
type: mechanism
expected_anchor: [docs/spec.md](../docs/spec.md), [conformance-artifacts.md](../docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
user_answer: pending user review through the P0 Sky Eye tour
status: pending
follow_up: User should be able to explain that P0 is a selected-profile readiness claim, not full Copilot CLI parity.

Question:
type: failure
expected_anchor: [production-runbook.md](../docs/integrations/codex-sdk-runtime-profile/production-runbook.md), [refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json](../docs/integrations/codex-sdk-runtime-profile/artifacts/refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json)
user_answer: pending user review through the P0 Sky Eye tour
status: pending
follow_up: User should be able to identify why side-effecting tools are dry-run-only in policy benchmarks.

Question:
type: trade-off
expected_anchor: [unsupported-capabilities.md](../docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
user_answer: pending user review through the P0 Sky Eye tour
status: pending
follow_up: User should be able to explain why B7 and D3 are explicit P2 deferrals rather than hidden P0 failures.

## Bank Handoff

Potential learning deposit:

- A production gate can close when every blocker is either evidenced as passing or explicitly downgraded with a profile-specific reason. The key is not "everything is implemented"; the key is "the claim boundary is true and reviewable."
