# Codex Runtime Adapter Boundary Fitness Status

Created: 2026-06-03 22:19
Last Updated: 2026-06-11 16:37
Status: Active

## Purpose

This artifact records the target boundary fitness functions for the Codex runtime adapter refactor.

It is not a claim that the current spike-graduated code already satisfies the target architecture. It separates:

- `passing-now`: the current code already satisfies the target rule;
- `expected-violation`: the current code intentionally violates the target rule and a later refactor phase must fix it;
- `not-yet-implemented`: the rule is defined but still needs an executable check.

## Fitness Status Matrix

| Rule                                                                                                                       | Current status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Required phase / action                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Root SDK public API does not export Codex adapter internals                                                                | passing-now    | Executable guard: `keeps root SDK exports free of experimental adapter internals` in [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts). [nodejs/src/index.ts](../../../../nodejs/src/index.ts) exports core SDK types/classes only; experimental adapter is exposed through package subpath, not root SDK API                                                                                                                                                                       | Keep as regression guard                                                                                                                       |
| Package `exports` do not expose internal runtime implementation subpaths                                                   | passing-now    | Executable guard: `does not publish internal runtime implementation subpaths` in [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts). [nodejs/package.json](../../../../nodejs/package.json) exposes `.` / `./extension` / `./experimental/codex-adapter`; no `./experimental/*/internal` subpath exists                                                                                                                                                                              | Keep as regression guard                                                                                                                       |
| Experimental Codex adapter subpath does not expose raw gateway class                                                       | passing-now    | Executable guard: `keeps experimental adapter subpath free of raw gateway classes` in [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts). [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts) no longer exports `CodexAppServerClient` or `CodexAppServerGateway`; build-time declaration check confirmed `codexAdapter.d.ts` no longer imports gateway or JSON-RPC types                                                                 | Keep as regression guard                                                                                                                       |
| Experimental Codex adapter subpath does not expose raw JSON-RPC/provider event/error unions                                | passing-now    | Raw `JsonRpc*` shapes are currently internal to [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts); exported transcript message is `unknown`                                                                                                                                                                                                                                                                                                                             | Keep as regression guard                                                                                                                       |
| App/downstream-facing code does not import Codex runtime implementation mechanics outside allowed adapter modules/examples | passing-now    | Executable guard: `keeps core SDK source files from importing experimental Codex adapter internals` in [nodejs/test/codex-adapter.test.ts](../../../../nodejs/test/codex-adapter.test.ts). The scan covers core `src` files and excludes adapter-local experimental implementation code                                                                                                                                                                                                                              | Keep as regression guard                                                                                                                       |
| Conformance artifacts include transcript/dataflow/side-effect evidence, not only process exit or log presence              | passing-now    | Phase 1 evidence: [refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json](../artifacts/refactor-phase1-selected-profile-conformance@2026-06-03-2239.summary.json) and [refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json](../artifacts/refactor-phase1-chatpilot-runtime-acceptance@2026-06-03-2231.summary.json). Prior milestone index: [conformance-artifacts.md](../conformance-artifacts.md)                                                                        | Preserve in Phase 1 no-regression gate                                                                                                         |
| Copy-transfer oracle uses live adapter behavior, not stale inline harness implementations                                  | passing-now    | [nodejs/examples/copilot-codex-adapter-spike.ts](../../../../nodejs/examples/copilot-codex-adapter-spike.ts) no longer contains the older inline `RawCodexAppServerClient` / `_MinimalCopilotAdapterServer` implementation residue. Active adapter validation uses `CodexCopilotAdapterServer`. Scoped verification passed: `npx tsc --noEmit ... examples/copilot-codex-adapter-spike.ts`, `npx eslint examples/copilot-codex-adapter-spike.ts`, and `npx prettier --check examples/copilot-codex-adapter-spike.ts` | Keep as regression guard; continue Phase 5 harness decomposition by splitting scenario/runner/ledger/assertion/report/fixture responsibilities |

## Live Oracle Definition

The authoritative copy-transfer oracle is:

```text
current exported Codex adapter behavior in nodejs/src/experimental/codexAdapter.ts
  + nodejs/src/experimental/codexAdapterServer.ts when testing long-running backend mode
  + selected-profile conformance and Chatpilot acceptance artifacts
```

The old inline minimal implementation that previously existed inside `nodejs/examples/copilot-codex-adapter-spike.ts` has been removed. Future copy-transfer work should continue using the live adapter path plus selected-profile conformance and Chatpilot acceptance artifacts as the oracle.

## Phase 1 Output

Phase 1 updated this matrix with:

- executable test coverage for root export, package export, and core source import guards;
- explicit owner phase for each remaining `expected-violation`;
- durable summary artifacts for selected-profile conformance and Chatpilot runtime acceptance.

Verification commands run:

```bash
cd nodejs
npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck test/codex-adapter.test.ts src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts
npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts test/codex-adapter.test.ts
npx vitest run test/codex-adapter.test.ts
npm run build
```

Broad behavior evidence:

```bash
cd nodejs
SPIKE_PHASE=all SPIKE_TIMEOUT_MS=90000 SPIKE_ADAPTER_APPROVAL_POLICY=untrusted SPIKE_ADAPTER_APPROVALS_REVIEWER=user SPIKE_ADAPTER_SANDBOX_MODE=workspaceWrite SPIKE_APPROVAL_PROBE_PATH=/tmp/copilot-codex-approval-refactor-phase1-20260603-2239 SPIKE_FILE_PROBE=1 SPIKE_TOOL_PROBE=1 SPIKE_TOOL_FAILURE_PROBE=1 SPIKE_WORKDIR=/tmp/copilot-codex-work-refactor-phase1-20260603-2239 SPIKE_OUT=/tmp/copilot-codex-refactor-phase1-all-20260603-2239.json npx tsx examples/copilot-codex-adapter-spike.ts
CHATPILOT_ACCEPTANCE_BACKENDS=all CHATPILOT_ACCEPTANCE_OUT=/tmp/chatpilot-codex-refactor-phase1-all.json npx tsx examples/chatpilot-runtime-acceptance.ts
```
