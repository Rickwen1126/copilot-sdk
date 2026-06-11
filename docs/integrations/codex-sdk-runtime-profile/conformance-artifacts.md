# Conformance Artifacts

Created: 2026-06-01 14:05
Last Updated: 2026-06-11 23:32
Status: Active

This index records the current evidence for Codex adapter parity in the selected profile.

Raw full ledgers are intentionally not copied wholesale into docs when they are multi-megabyte runtime transcripts. The durable record here is:

- exact command
- source artifact path and digest from the run
- machine-readable summary kept in this repo
- pass criteria and result

## Selected Profile Conformance

Summary artifact: [artifacts/selected-profile-conformance@2026-06-01.summary.json](./artifacts/selected-profile-conformance@2026-06-01.summary.json)

Primary full run:

```bash
SPIKE_PHASE=all \
SPIKE_TIMEOUT_MS=90000 \
SPIKE_ADAPTER_APPROVAL_POLICY=untrusted \
SPIKE_ADAPTER_APPROVALS_REVIEWER=user \
SPIKE_ADAPTER_SANDBOX_MODE=workspaceWrite \
SPIKE_APPROVAL_PROBE_PATH=/tmp/copilot-codex-approval-20260601-1415 \
SPIKE_FILE_PROBE=1 \
SPIKE_TOOL_PROBE=1 \
SPIKE_TOOL_FAILURE_PROBE=1 \
SPIKE_WORKDIR=/tmp/copilot-codex-work-20260601-1415 \
SPIKE_OUT=/tmp/copilot-codex-all-tool-failure-20260601-v1.json \
npx tsx examples/copilot-codex-adapter-spike.ts
```

Result:

- raw artifact: `/tmp/copilot-codex-all-tool-failure-20260601-v1.json`
- sha256: `cb4d48b44578408d90f02b95c55f6d1b7c867daf344d41233b5b88a3bc1a21d1`
- `conformanceReport.verdict = "pass"`
- `ledgerCounts.copilotCli = 417`
- `ledgerCounts.codexAdapter = 1621`

Passing capabilities:

- core new session
- resume continuation
- command approval approve
- command approval deny
- file approval approve/deny
- custom tool call
- tool deny or failure

## Adapter Module Graduation

Secondary full run:

- raw artifact: `/tmp/copilot-codex-all-module-20260601-v1.json`
- sha256: `3a390e7f426a65d90bcda12628d8d874549b07144372d29eb693ddefaaeaf698`
- `conformanceReport.verdict = "pass"`
- `ledgerCounts.copilotCli = 412`
- `ledgerCounts.codexAdapter = 1801`
- proves the conformance harness uses `CodexCopilotAdapterServer`, not only an inline example-local class

## Chatpilot App-Level Acceptance

Summary artifact: [artifacts/chatpilot-runtime-acceptance@2026-06-01-1357.summary.json](./artifacts/chatpilot-runtime-acceptance@2026-06-01-1357.summary.json)

Command:

```bash
CHATPILOT_ACCEPTANCE_BACKENDS=all \
CHATPILOT_ACCEPTANCE_OUT=/tmp/chatpilot-codex-phase6-all-20260601-v1.json \
npx tsx examples/chatpilot-runtime-acceptance.ts
```

Result:

- raw artifact: `/tmp/chatpilot-codex-phase6-all-20260601-v1.json`
- sha256: `4996a19d9618f0429dba7f5f3ad1b091287b837c4e5ffa79c678366d474e20a9`
- `status = "pass"`
- `copilot-cli.status = "pass"`
- `codex-adapter.status = "pass"`

Passing app-level assertions:

- both backends pass the same Chatpilot `/cli/chat` acceptance flow
- both backends persist one or more SQLite `memory_memos` rows for their route
- both backends invoke the same SDK-visible `save_memo` and `list_memos` tool intents
- both backends reuse the same Chatpilot SDK session on the second turn
- adapter summary contains both Codex `item/tool/call` and protocol-v2 SDK `tool.call`

## Phase 5 Proof Infrastructure Scaffold

Summary artifact: [artifacts/refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json](./artifacts/refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json)

Result:

- `nodejs/conformance/codexConformanceProof.ts` now owns pure schema round-trip and tool-call compliance assertion helpers.
- `nodejs/examples/chatpilot-runtime-acceptance.ts` now emits per-backend and aggregate `toolCallCompliance` report sections for the existing `save_memo` / `list_memos` app-level flow.
- `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS` now lets the Chatpilot acceptance harness produce per-session evidence for multi-session runs.
- This is a Phase 5 scaffold, not a production-readiness completion claim: A6 still needs a live multi-session artifact, B5 full Chatpilot tool manifest coverage remains active, and C2 representative compliance benchmark remains active.

Verification:

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 22 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx tsc --noEmit` -> pass
- `npx prettier --check conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts` -> pass

## Phase 5 Production Proof Expansion

Summary artifact: [artifacts/refactor-phase5-production-proof@2026-06-11-1038.summary.json](./artifacts/refactor-phase5-production-proof@2026-06-11-1038.summary.json)

Raw live artifacts:

- `/tmp/chatpilot-codex-phase5-live-20260611-1037.json`
  - sha256: `ccff597a01cb24ef4c6becd250376f5bdcf12e55f40581641c0097af5c4fdbf8`
  - status: `pass`
  - scope: codex-adapter, `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot`, `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=2`
- `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json`
  - sha256: `751317ac53ceff2c8e1ded28cf754ab838207b3145b7ff3b5a97d3dddbb3e941`
  - status: `pass`
  - scope: copilot-cli and codex-adapter, `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot`, `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=1`

Result:

- A6 multi-session concurrent acceptance passes on the Codex adapter lane with two concurrent Chatpilot routes, distinct SDK session ids, and distinct persisted SQLite memory markers.
- B5 full Chatpilot chatbot-visible tool schema round-trip passes: 26 expected SDK tools and 26 observed Codex `dynamicTools`, with no missing, mutated, or unexpected tools.
- C2 safe tool-call compliance benchmark passes under 26-tool availability: save/list prompts choose `save_memo` and `list_memos` on both Copilot CLI and Codex adapter, native Codex tool calls are absent under conservative marker-scoped plus full-trace scanning, and both backends persist/read the marker through Chatpilot data paths.
- C2 scope boundary: this benchmark intentionally avoids executing external-side-effect tools such as WorkProof push, browser, or web search. Full prompt-quality tuning across every tool description remains Phase 6 model-behavior cleanup work.

Verification:

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 22 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx prettier --check conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npm run build` -> pass

## Phase 6 Policy / Model-Behavior Cleanup

Summary artifact: [artifacts/refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json](./artifacts/refactor-phase6-policy-cleanup@2026-06-11-1143.summary.json)

Raw local artifacts:

- `/tmp/codex-phase6-policy-cleanup-20260611-1143.json`
  - sha256: `efc7d09a36be0ba528a81fe456e8ecc317c6f28d187f62214118eb2039b38d47`
  - status: `pass`
- `/tmp/codex-phase6-auth-smoke-20260611-1143.json`
  - sha256: `d36baf09b2181bb6503c8c3c7de2d2f47871d59b7490dbc7e0f762c0f34ab727`
  - note: raw smoke is not copied into repo because it contains account identity details; the repo summary records only boolean auth evidence and hash.

Result:

- C2 residual passes through a safe 26-tool selection benchmark surrogate: every Chatpilot tool has a prompt case, and every side-effecting tool is marked `dry-run-only` to avoid WorkProof/browser/web/search/schedule/media side effects.
- B6 passes: no Chatpilot SDK tool name collides with known Codex native tools (`apply_patch`, `local_shell`, `read_file`, `shell`, `update_plan`, `write_file`).
- C3/C4 pass: the Phase 5 live benchmark observed no native Codex tool calls under the locked Chatpilot lane, and all 26 tool descriptions pass the selection-quality audit.
- D2 passes: isolated Codex app-server smoke validates `account/read` with `refreshToken=false`, `account/read` with `refreshToken=true`, and `model/list`.
- B7 and D3 are explicitly deferred as non-blocking P2 policy decisions: current Chatpilot media tools return text-to-LLM or user-visible media rather than requiring Codex dynamic-tool multimodal output; bounded transcript summaries remain the P0 observability contract, while live metrics/health endpoint work is deferred until staged deployment needs it.

Verification:

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 24 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/codex-adapter-phase6-policy-audit.ts examples/codex-app-server-smoke.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/codex-adapter-phase6-policy-audit.ts examples/codex-app-server-smoke.ts` -> pass

## Phase 5 Decomposition Selected-Profile Comparison

Summary artifact: [artifacts/refactor-phase5-decomposition-selected-profile@2026-06-11-2320.summary.json](./artifacts/refactor-phase5-decomposition-selected-profile@2026-06-11-2320.summary.json)

Command:

```bash
SPIKE_PHASE=all \
SPIKE_TIMEOUT_MS=90000 \
SPIKE_ADAPTER_APPROVAL_POLICY=untrusted \
SPIKE_ADAPTER_APPROVALS_REVIEWER=user \
SPIKE_ADAPTER_SANDBOX_MODE=workspaceWrite \
SPIKE_APPROVAL_PROBE_PATH=/tmp/copilot-codex-approval-20260611-2320 \
SPIKE_FILE_PROBE=1 \
SPIKE_TOOL_PROBE=1 \
SPIKE_TOOL_FAILURE_PROBE=1 \
SPIKE_WORKDIR=/tmp/copilot-codex-work-20260611-2320 \
SPIKE_OUT=/tmp/copilot-codex-selected-profile-20260611-2320.json \
npx tsx examples/copilot-codex-adapter-spike.ts
```

Result:

- raw artifact: `/tmp/copilot-codex-selected-profile-20260611-2320.json`
- sha256: `51dd4058e9215eac3003877bdbb2e13948bfaa6cc762d03c004fd3661909323e`
- run id: `e627ec9c-5ae6-4a36-b843-df215cd728bd`
- `conformanceReport.verdict = "pass"`
- `ledgerCounts.copilotCli = 405`
- `ledgerCounts.codexAdapter = 1145`

Passing capabilities:

- core new session
- resume continuation
- command approval approve
- command approval deny
- file approval approve/deny
- custom tool call
- tool deny or failure

Comparison:

- The June 1 selected-profile baseline also passed the same seven capabilities.
- The post-decomposition run keeps every check at `traceParity = "pass"`, `dataAssertion = "pass"`, `intentAssertion = "pass"`, and `missing = []`.
- Ledger counts differ from the June 1 artifact because recorder/report internals and live runtime behavior changed; no selected-profile capability regressed.
- First non-escalated attempt `/tmp/copilot-codex-selected-profile-20260611-2317.json` failed only because the Copilot CLI baseline could not create `/Users/rickwen/.copilot/session-state/...` under sandbox EPERM. The escalated run above is the valid comparison artifact.

## Refactor Phase 6 Conditional Policy Extraction

Summary artifact: [artifacts/refactor-phase6-conditional-policy@2026-06-11-2330.summary.json](./artifacts/refactor-phase6-conditional-policy@2026-06-11-2330.summary.json)

Result:

- `nodejs/src/experimental/codexAdapterToolPolicy.ts` now owns the real protocol-version dynamic-tool routing policy.
- Protocol v2 routes Codex dynamic tool calls through SDK `tool.call` requests.
- Protocol v3 routes Codex dynamic tool calls through `external_tool.requested` session events plus `session.tools.handlePendingToolCall` completion.
- Approval request/decision mapping and tool deny/failure result mapping remain mapper contracts, not Strategy/Policy objects, because they do not yet have a second live runtime strategy.
- No generic runtime framework policy was introduced.

Verification:

- `npx vitest run test/codex-adapter-tool-policy.test.ts test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` -> pass, 36 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck src/experimental/codexAdapterToolPolicy.ts src/experimental/codexAdapter.ts test/codex-adapter-tool-policy.test.ts` -> pass
- `npx prettier --check src/experimental/codexAdapterToolPolicy.ts src/experimental/codexAdapter.ts test/codex-adapter-tool-policy.test.ts` -> pass
- `npm run build` -> pass

Selected-profile comparison:

- raw artifact: `/tmp/copilot-codex-phase6-policy-20260611-2330.json`
- sha256: `3095a406a55a2211b0fc312f6a1f7ec606579412b8d639b4d79f0faf947935c1`
- run id: `1024a103-364b-4b94-ac54-6de5e808ddf1`
- `conformanceReport.verdict = "pass"`
- `ledgerCounts.copilotCli = 396`
- `ledgerCounts.codexAdapter = 1146`
- all seven selected-profile checks passed for both backends with `traceParity`, `dataAssertion`, and `intentAssertion` all passing and `missing = []`
