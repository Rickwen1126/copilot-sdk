# Completed Todo Archive

Created: 2026-05-16
Last Updated: 2026-06-11 10:40
Status: Archived

This archive was bootstrapped from session continuity and live adapter work. Missing historical links mean the older notes did not record them, not that the retention rule is optional.

## Completed: Codex Adapter Production Proof Expansion Phase 5 @2026-06-11-1038

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md), issues A6, B5, C2
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 5
- Evidence artifacts: [refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-proof-language-scaffold@2026-06-10-1603.summary.json), [refactor-phase5-production-proof@2026-06-11-1038.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase5-production-proof@2026-06-11-1038.summary.json)
- Conformance index: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Prior scaffold audit and tour: [.audit/AUDIT-codex-adapter-phase5-proof-scaffold-v1@2026-06-10-1813.md](../.audit/AUDIT-codex-adapter-phase5-proof-scaffold-v1@2026-06-10-1813.md), [.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour](../.tours/audit-codex-adapter-phase5-proof-scaffold-20260610-1813.tour)
- Production proof audit and tour: [.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md](../.audit/AUDIT-codex-adapter-phase5-production-proof-v1@2026-06-11-1040.md), [.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour](../.tours/audit-codex-adapter-phase5-production-proof-20260611-1040.tour)
- Code/Surface: [nodejs/conformance/codexConformanceProof.ts](../nodejs/conformance/codexConformanceProof.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts), [nodejs/test/codex-conformance-proof.test.ts](../nodejs/test/codex-conformance-proof.test.ts)
- Raw live artifacts: `/tmp/chatpilot-codex-phase5-live-20260611-1037.json`, `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json`
- Source: active todo `P0: Codex Adapter Production Readiness Queue` Phase 5

- [x] Added real Chatpilot 26-tool schema round-trip proof.
  Completion evidence: `CHATPILOT_ACCEPTANCE_TOOLSET=all-chatbot` drives a live Chatpilot session with 26 chatbot-visible tools; the adapter report compares SDK `session.create.tools` against Codex `thread/start.dynamicTools`; both live artifacts report `expectedToolCount=26`, `observedToolCount=26`, and no failed tools.
- [x] Produced live A6 multi-session concurrent acceptance.
  Completion evidence: `/tmp/chatpilot-codex-phase5-live-20260611-1037.json` passes with `CHATPILOT_ACCEPTANCE_CONCURRENT_SESSIONS=2`; each concurrent route has a distinct SDK session id, persists a distinct marker in SQLite `memory_memos`, and reuses the app-level runtime session for the second turn.
- [x] Produced C2 safe tool-call compliance benchmark and backend comparison evidence.
  Completion evidence: `/tmp/chatpilot-codex-phase5-all-backends-20260611-1038.json` passes with both `copilot-cli` and `codex-adapter`; both backends select `save_memo` and `list_memos` under 26-tool availability, persist/read data through Chatpilot, and report no native Codex tool calls under marker-scoped plus full-trace scanning.
- [x] Preserved the C2 safety boundary for external-side-effect tools.
  Completion evidence: the Phase 5 summary records that this benchmark does not intentionally execute WorkProof push, browser, web search, or other external-side-effect tools. Full prompt-quality tuning across every tool description remains assigned to Phase 6 model-behavior cleanup.

## Completed: Codex Adapter Refactor / Production Hardening Phase 4 @2026-06-09-1155

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 4
- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Phase 3.5 capability spike: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Evidence artifacts: [refactor-phase4-session-lifecycle@2026-06-08-1130.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-session-lifecycle@2026-06-08-1130.summary.json), [refactor-phase4-runtime-session-store@2026-06-09-1102.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-runtime-session-store@2026-06-09-1102.summary.json), [refactor-phase4-final-hardening@2026-06-09-1145.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase4-final-hardening@2026-06-09-1145.summary.json)
- Production runbook: [docs/integrations/codex-sdk-runtime-profile/production-runbook.md](./integrations/codex-sdk-runtime-profile/production-runbook.md)
- Audit: [.audit/AUDIT-codex-adapter-phase4-final-v1@2026-06-09-1150.md](../.audit/AUDIT-codex-adapter-phase4-final-v1@2026-06-09-1150.md)
- Review tours: [.tours/audit-codex-adapter-phase4-session-lifecycle-20260608-1138.tour](../.tours/audit-codex-adapter-phase4-session-lifecycle-20260608-1138.tour), [.tours/audit-codex-adapter-phase4-runtime-session-store-20260609-1108.tour](../.tours/audit-codex-adapter-phase4-runtime-session-store-20260609-1108.tour), [.tours/audit-codex-adapter-phase4-final-20260609-1150.tour](../.tours/audit-codex-adapter-phase4-final-20260609-1150.tour)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterSessionStore.ts](../nodejs/src/experimental/codexAdapterSessionStore.ts), [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts), [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts)
- Source: active todo `P0: Codex Adapter Production Readiness Queue` Phase 4 and `P1: Runtime Adapter Refactor Architecture Guard` Phase 4

- [x] Implemented session lifecycle semantics from Phase 3.5 spike evidence.
  Completion evidence: `session.create` starts non-ephemeral Codex threads, SDK disconnect maps to idempotent `thread/unsubscribe`, SDK resume maps to `thread/resume`, and SDK delete maps to `thread/archive`.
- [x] Implemented adapter-owned runtime session mapping store.
  Completion evidence: adapter restart can recover `sdkSessionId -> Codex runtime session/thread id` from persisted store and call `thread/resume` instead of failing with `Unknown session`.
- [x] Implemented incompatible resume tool-set policy.
  Completion evidence: in-memory resume with changed tools, adapter-restart resume with missing required tools, and adapter-restart resume with changed tools are rejected before Codex `thread/resume`.
- [x] Implemented long-running server hygiene.
  Completion evidence: adapter and gateway transcripts are bounded by `transcriptLimit`; protocol-v3 pending dynamic tool calls time out and return a failed Codex dynamic tool response; gateway request path can restart a previously-started app-server after child exit.
- [x] Implemented safe tool-result text fallback.
  Completion evidence: object tool results without `textResultForLlm` no longer leak arbitrary object structure into Codex `inputText`; mapper test covers this contract.
- [x] Documented the production locked lane and runbook.
  Completion evidence: `production-runbook.md` documents required `codex login`, stable `CODEX_ADAPTER_CODEX_HOME`, stable `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH`, Chatpilot locked defaults (`approvalPolicy=never`, `sandboxMode=readOnly`, `networkAccess=false`), resume tool-set policy, and common operational knobs.
- [x] Passed final Phase 4 verification gates.
  Completion evidence: local gates passed (`npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 34 tests, scoped `npx tsc --noEmit ...`, scoped `npx eslint ...`, and `npm run build`); selected-profile conformance `/tmp/copilot-codex-refactor-phase4-final.json` run `d83f7062-a944-40cb-a0d9-3f56a436c85c` verdict `pass`; Chatpilot acceptance `/tmp/chatpilot-codex-refactor-phase4-final.json` run `15aade97-d245-43e7-ab78-58c8a9ae631e` status `pass`.
- [x] Audited Phase 4 as ready for consolidated user review.
  Completion evidence: final audit verdict is pass with explicit post-Phase-4 residual risks. Residuals are assigned to Phase 5/6: representative native-tool compliance benchmark, auth token refresh / 401 recovery validation, and optional SDK event-history replay decision if product evidence requires it.

## Completed: Codex Adapter Production Capability Spike Gate @2026-06-04-2028

Section source:

- Production readiness inventory: [docs/integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md](./integrations/codex-sdk-runtime-profile/production-readiness@2026-06-04-1953.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md), Phase 3.5
- Evidence artifact: [codex-app-server-capability-spike@2026-06-04-2028.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/codex-app-server-capability-spike@2026-06-04-2028.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-production-capability-spike-v1@2026-06-04-2028.md](../.audit/AUDIT-codex-adapter-production-capability-spike-v1@2026-06-04-2028.md)
- Probe script: [nodejs/examples/codex-app-server-capability-spike.ts](../nodejs/examples/codex-app-server-capability-spike.ts)
- Raw live transcript artifact: `/tmp/codex-app-server-capability-spike-20260604-live.json`
- Source: user request to put spike-only production unknowns before Phase 4 and re-plan implementation from evidence

- [x] Classified Codex app-server lifecycle capability before Phase 4.
  Completion evidence: no `thread/end` / `thread/close` request exists; `thread/unsubscribe` succeeds for listener detach; `thread/archive` succeeds for persisted-thread cleanup after a live turn writes a rollout.
- [x] Proved restart continuity with durable transcript evidence.
  Completion evidence: live turn `019e929a-804c-7012-9316-4ae39940631a` persisted rollout for thread `019e929a-7f57-7980-b000-7be3e99e4afc`; same-process `thread/resume`, restart `thread/resume`, and restart `thread/read` all returned the completed user/agent turn.
- [x] Classified dynamic tool refresh on resume as unsupported.
  Completion evidence: upstream `ThreadStartParams` has `dynamic_tools`, `ThreadResumeParams` does not; a live resume request carrying `dynamicTools` succeeds but must be treated as unknown-field tolerance / ignored-field behavior, not tool refresh support.
- [x] Classified native-tool suppression and sandbox control as Phase 4 partial support.
  Completion evidence: Codex exposes sandbox, permission profiles, config, and `dynamicTools`, but not SDK-shaped `available_tools` / `excluded_tools`; Phase 4 must implement locked Chatpilot lane controls and benchmark native-tool suppression.
- [x] Confirmed basic isolated `CODEX_HOME` auth inheritance.
  Completion evidence: copied isolated home starts app-server and `account/read` succeeds; token refresh / 401 recovery remains a later production-like validation.
- [x] Clarified the runtime identity model for Phase 4 implementation.
  Completion evidence: production docs now distinguish `codex app-server` process from Codex thread and Copilot SDK session. One app-server process can host many Codex threads; a Codex thread is the task-session unit closest to a Codex CLI session; app-server health is only a precondition, while `thread/resume` / `thread/read` is the continuity proof.

## Completed: Runtime Adapter Refactor Phase 3 @2026-06-04-1710

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary fitness: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md)
- Code/Surface: [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- Evidence artifact: [refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase3-gateway-boundary@2026-06-04-1710.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-phase3-gateway-boundary-v1@2026-06-04-1710.md](../.audit/AUDIT-codex-adapter-phase3-gateway-boundary-v1@2026-06-04-1710.md)
- Review tour: [.tours/audit-codex-adapter-phase3-gateway-boundary-20260604-1710.tour](../.tours/audit-codex-adapter-phase3-gateway-boundary-20260604-1710.tour)
- Source: refactor plan Phase 3; `boundary-fitness.md` expected violation for raw gateway class exposure

- [x] Moved Codex app-server process and JSON-RPC client behavior behind an adapter-internal gateway module.
  Completion evidence: [nodejs/src/experimental/codexAppServerGateway.ts](../nodejs/src/experimental/codexAppServerGateway.ts) now owns process spawn, Codex home preparation, JSON-RPC request/notify/respond, app-server notification/request routing, timeout handling, and gateway transcript capture.
- [x] Made the adapter facade depend on gateway capability instead of a public concrete app-server class.
  Completion evidence: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts) no longer defines or exports `CodexAppServerClient`; `CodexCopilotAdapterServer` creates the internal gateway by default and keeps app-facing constructor options free of gateway injection types.
- [x] Removed raw gateway class exposure from the experimental adapter public subpath.
  Completion evidence: `keeps experimental adapter subpath free of raw gateway classes` in [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), plus build-time declaration check showing `codexAdapter.d.ts` does not expose or import gateway/JSON-RPC types.
- [x] Preserved runtime transcript/error observability and existing behavior after gateway extraction.
  Completion evidence: local gates passed (`npx tsc --noEmit ...`, `npx eslint ...`, `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 2 files / 26 tests passing, and `npm run build`), selected-profile conformance `runId=4d82c62d-19b2-4749-9248-50d31b39c99c`, verdict `pass`, 7/7 checks pass, `copilotCli=396` and `codexAdapter=1473` ledger entries, and Chatpilot acceptance `runId=546a6ab7-5476-46d3-b315-d2caf6dae322`, status `pass`.

## Completed: Runtime Adapter Refactor Phase 2 @2026-06-04-0942

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary references: [runtime adapter architecture boundary](./reference/runtime-adapter-architecture-boundary.md), [runtime adapter testing evidence](./reference/runtime-adapter-testing-evidence.md), [runtime adapter design patterns](./reference/runtime-adapter-design-patterns.md)
- Code/Surface: [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts), [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts)
- Evidence artifacts: [refactor-phase2-command-mapper@2026-06-03-2248.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-command-mapper@2026-06-03-2248.summary.json), [refactor-phase2-file-approval-mapper@2026-06-04-0822.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-file-approval-mapper@2026-06-04-0822.summary.json), [refactor-phase2-mapper-layer@2026-06-04-0942.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json)
- Audit: [.audit/AUDIT-codex-adapter-phase2-mapper-layer-v1@2026-06-04-0942.md](../.audit/AUDIT-codex-adapter-phase2-mapper-layer-v1@2026-06-04-0942.md)
- Review tour: [.tours/audit-codex-adapter-phase2-mapper-layer-20260604-0942.tour](../.tours/audit-codex-adapter-phase2-mapper-layer-20260604-0942.tour)
- Source: refactor plan Phase 2; user request to preserve spike behavior while extracting minimal clean mapper bricks

- [x] Extracted command approval request/result mapping into a pure adapter-local mapper module.
  Completion evidence: dedicated tests in [nodejs/test/codex-adapter-mappers.test.ts](../nodejs/test/codex-adapter-mappers.test.ts), inserted into the live adapter flow, and no-regression gates recorded in [refactor-phase2-command-mapper@2026-06-03-2248.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-command-mapper@2026-06-03-2248.summary.json).
- [x] Extracted file-change approval request/result mapping into the same pure mapper module.
  Completion evidence: dedicated file approval tests, live adapter insertion, selected-profile conformance `runId=4f54f8b5-46bf-484e-a281-55631edf8458`, and Chatpilot acceptance `runId=40cf07a3-9bff-4d6e-aa05-8d4f0027dd6f`.
- [x] Extracted SDK tool descriptor mapping, SDK tool result mapping, model list conversion, and sandbox request shape conversion.
  Completion evidence: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts) now imports these translations from [nodejs/src/experimental/codexAdapterMappers.ts](../nodejs/src/experimental/codexAdapterMappers.ts), and mapper tests fail on contract drift for missing evidence, default shapes, failed tool results, model capabilities, and sandbox aliases.
- [x] Preserved Phase 1 functional behavior after inserting the completed mapper layer.
  Completion evidence: local gates passed (`npx tsc --noEmit ...`, `npx eslint ...`, `npx vitest run test/codex-adapter.test.ts test/codex-adapter-mappers.test.ts` with 2 files / 24 tests passing, and `npm run build`), selected-profile conformance `runId=dd467a11-24b7-4241-8ee4-93d19e8eb270`, verdict `pass`, 7/7 checks pass, `copilotCli=421` and `codexAdapter=1674` ledger entries, and Chatpilot acceptance `runId=15ec983d-293e-4142-9a67-fd203e64ffec`, status `pass`.
- [x] Kept protocol-v2/v3 dynamic tool request normalization out of Phase 2 because it is not currently a pure mapper brick.
  Completion evidence: the decision is recorded in [refactor-phase2-mapper-layer@2026-06-04-0942.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase2-mapper-layer@2026-06-04-0942.summary.json). Current protocol branching touches session state, pending tool-call lifecycle, SDK connection IO, and transcript emission; extracting it now would create pattern theater. Revisit during Phase 4/6 only if a real variant seam appears.

## Completed: Runtime Adapter Refactor Phase 1 @2026-06-03-2242

Section source:

- Spec: [docs/integrations/codex-sdk-runtime-profile/refactor/spec.md](./integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Plan: [docs/integrations/codex-sdk-runtime-profile/refactor/plan.md](./integrations/codex-sdk-runtime-profile/refactor/plan.md)
- Boundary fitness: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md)
- Code/Surface: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts), [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Evidence artifacts: [refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json), [refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json)
- Source: refactor plan Phase 1; subagent review finding that characterization and executable boundary fitness must precede extraction

- [x] Added top-down adapter-facing characterization tests without freezing the current mixed module layout.
  Completion evidence: [nodejs/test/codex-adapter.test.ts](../nodejs/test/codex-adapter.test.ts) now covers root export guard, package export guard, core source import guard, capability flags, deferred profiles, named server boundary, and SDK-facing create/send behavior through a fake Codex gateway seam.
- [x] Updated boundary fitness status with executable evidence and remaining expected violations.
  Completion evidence: [docs/integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md](./integrations/codex-sdk-runtime-profile/refactor/boundary-fitness.md) records all current `passing-now` rules with test/artifact evidence; the remaining `CodexAppServerClient` public gateway export and stale inline harness oracle are explicitly assigned to Phase 3 and Phase 5.
- [x] Passed local Phase 1 verification gates.
  Completion evidence: `npx tsc --noEmit ...`, `npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts test/codex-adapter.test.ts`, `npx vitest run test/codex-adapter.test.ts` with 7 tests passing, and `npm run build`.
- [x] Passed broad selected-profile conformance and Chatpilot runtime acceptance after rerunning sandbox-blocked commands outside the sandbox.
  Completion evidence: selected-profile conformance `runId=34902c4f-117f-4e89-8cf9-590ce9ba3640`, verdict `pass`, 7/7 checks pass, `copilotCli=396` and `codexAdapter=1570` ledger entries; Chatpilot acceptance `runId=3ebf6f98-d69a-489b-8758-d2c42f7b7aef`, status `pass`, both `copilot-cli` and `codex-adapter` pass with cross-backend memo/tool-intent assertions.

## Completed: Codex SDK Runtime Profile Parity @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md), [docs/integrations/codex-sdk-runtime-profile/plan.md](./integrations/codex-sdk-runtime-profile/plan.md), [.progress/progress.md](../.progress/progress.md)
- Architecture: [docs/architecture/skyeye.html](./architecture/skyeye.html)
- Code Map: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md)
- Conformance: [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported capability notes: [docs/integrations/codex-sdk-runtime-profile/unsupported-capabilities.md](./integrations/codex-sdk-runtime-profile/unsupported-capabilities.md)
- Code/Surface: [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), [nodejs/src/experimental/codexAdapterServer.ts](../nodejs/src/experimental/codexAdapterServer.ts), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Downstream surface: `/Users/rickwen/code/chatpilot/src/chatpilot/sdk/session.py`, `/Users/rickwen/code/chatpilot/tests/unit/test_sdk_session.py`
- Source: runtime backend replacement milestone

- [x] Phase 1: Locked the target as `SDK Core Profile + Coding Agent Profile`, while explicitly deferring `Interactive Profile`, `Fidelity Profile`, and `Extended CLI Profile`.
- [x] Phase 2: Built baseline-vs-adapter conformance reporting around normalized ledgers and machine-readable verdicts.
- [x] Phase 3: Passed selected-profile conformance for core new session, resume continuation, command approval approve/deny, file approval approve/deny, custom tool call, and tool deny/failure.
  Completion evidence: `/tmp/copilot-codex-all-tool-failure-20260601-v1.json`, summarized in [selected-profile-conformance@2026-06-01.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/selected-profile-conformance@2026-06-01.summary.json).
- [x] Phase 4: Graduated the spike into reusable adapter module boundary.
  Completion evidence: `CodexCopilotAdapterServer`, `CodexAppServerClient`, `createCodexCopilotClientOptions`, package subpath `./experimental/codex-adapter`, and `/tmp/copilot-codex-all-module-20260601-v1.json`.
- [x] Phase 5: Integrated the adapter into the downstream Chatpilot runtime seam without changing app-level routing, execution identity, memory ownership, or tool registration.
  Completion evidence: `copilot-codex-adapter` server runner, `CHATPILOT_COPILOT_CLI_URL`, `CHATPILOT_RUNTIME_BACKEND=codex-adapter`, protocol-v2 tool handling, direct `SdkClient` smoke, and custom Python SDK tool smoke.
- [x] Phase 6: Passed real Chatpilot `/cli/chat` new-session and run-session acceptance against both `Copilot SDK + Copilot CLI` and `Copilot SDK + Codex adapter + Codex app-server`.
  Completion evidence: `/tmp/chatpilot-codex-phase6-all-20260601-v1.json`, summarized in [chatpilot-runtime-acceptance@2026-06-01-1357.summary.json](./integrations/codex-sdk-runtime-profile/artifacts/chatpilot-runtime-acceptance@2026-06-01-1357.summary.json). Both backends persisted SQLite `memory_memos`, invoked `save_memo` / `list_memos`, reused the same Chatpilot SDK session on the second turn, and passed cross-backend assertions.
- [x] Phase 7: Closed the milestone with canonical spec updates, architecture diagram, code map, conformance artifact index, unsupported capability notes, and todo archive.
  Completion evidence: [docs/spec.md](./spec.md), [docs/architecture/skyeye.html](./architecture/skyeye.html), [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md), [docs/integrations/codex-sdk-runtime-profile/conformance-artifacts.md](./integrations/codex-sdk-runtime-profile/conformance-artifacts.md), and this archive entry.

## Completed: Canonical Spec Pack Gaps @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [docs/integrations/runtime-backends.md](./integrations/runtime-backends.md), [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/chatpilot-runtime-acceptance.ts](../nodejs/examples/chatpilot-runtime-acceptance.ts)
- Source: migrated from session continuity and live adapter findings

- [x] Created a runtime-backend architecture diagram and linked it from `docs/spec.md`.
  Completion evidence: [docs/architecture/skyeye.html](./architecture/skyeye.html), visually checked via Chrome headless screenshot `/tmp/copilot-runtime-skyeye-v3.png`.
- [x] Created a code map for the Codex bridge path and linked it from `docs/spec.md`.
  Completion evidence: [docs/architecture/runtime-backend-code-map.md](./architecture/runtime-backend-code-map.md).
- [x] Decided whether the adapter spike stays exploratory or becomes a reusable module.
  Completion evidence: the Codex bridge is now a reusable experimental Node module at [nodejs/src/experimental/codexAdapter.ts](../nodejs/src/experimental/codexAdapter.ts), exposed through package subpath `./experimental/codex-adapter`, with capability flags in `CODEX_ADAPTER_CAPABILITIES`.

## Completed: Codex Baseline Replaceability @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/codex-app-server-smoke.ts](../nodejs/examples/codex-app-server-smoke.ts)
- Source: live spike proving the baseline session path

- [x] Proved `create -> send -> disconnect -> resume -> getMessages -> second send` works end to end.
- [x] Proved state survives reconnect and resume with a fresh SDK client.
- [x] Proved the narrow Codex facade can return `READY` and `READYREADY` on the baseline path.
- [x] Captured the live baseline as a reusable `RuntimeBackend` reference point.

## Completed: Codex Command Approval Callback @2026-05-16-2334

Section source:

- Spec: [docs/spec.md](./spec.md)
- Plan: [.progress/progress.md](../.progress/progress.md)
- Code/Surface: [nodejs/examples/copilot-codex-adapter-spike.ts](../nodejs/examples/copilot-codex-adapter-spike.ts), [nodejs/examples/codex-app-server-smoke.ts](../nodejs/examples/codex-app-server-smoke.ts)
- Source: live command approval probe and adapter bridge validation

- [x] Proved `item/commandExecution/requestApproval` can be mapped through the adapter to SDK `permission.request`.
- [x] Proved the SDK permission result can be mapped back to Codex `result.decision`.
- [x] Proved a workspace-outside file write can complete with live approval handling.
- [x] Proved the output file exists and contains the exact expected contents `hello`.
