# Conformance Artifacts

Created: 2026-06-01 14:05
Last Updated: 2026-06-11 10:34
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

Summary artifact: [artifacts/refactor-phase5-production-proof@2026-06-11-1034.summary.json](./artifacts/refactor-phase5-production-proof@2026-06-11-1034.summary.json)

Raw live artifacts:

- `/tmp/chatpilot-codex-phase5-live-20260611-1027.json`
  - sha256: `54105fce4a065406d23915b92dda185cd8a13ff39523efb8d974cc10c8e52c76`
  - status: `pass`
  - scope: codex-adapter, `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot`, `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=2`
- `/tmp/chatpilot-codex-phase5-all-backends-20260611-1034.json`
  - sha256: `e36c14a6a8f1517b76b862ab6a09288e61856f216068cd735aa1d83ecfd615ca`
  - status: `pass`
  - scope: copilot-cli and codex-adapter, `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot`, `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=1`

Result:

- A6 multi-session concurrent acceptance passes on the Codex adapter lane with two concurrent Chatpilot routes, distinct SDK session ids, and distinct persisted SQLite memory markers.
- B5 full Chatpilot chatbot-visible tool schema round-trip passes: 26 expected SDK tools and 26 observed Codex `dynamicTools`, with no missing, mutated, or unexpected tools.
- C2 safe tool-call compliance benchmark passes under 26-tool availability: save/list prompts choose `save_memo` and `list_memos` on both Copilot CLI and Codex adapter, native Codex tool calls are absent, and both backends persist/read the marker through Chatpilot data paths.
- C2 scope boundary: this benchmark intentionally avoids executing external-side-effect tools such as WorkProof push, browser, or web search. Full prompt-quality tuning across every tool description remains Phase 6 model-behavior cleanup work.

Verification:

- `npx vitest run test/codex-conformance-proof.test.ts test/codex-adapter-mappers.test.ts` -> pass, 22 tests
- `npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx prettier --check conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npx eslint conformance/codexConformanceProof.ts test/codex-conformance-proof.test.ts examples/chatpilot-runtime-acceptance.ts` -> pass
- `npm run build` -> pass
