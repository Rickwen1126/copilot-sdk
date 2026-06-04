# Codex Runtime Adapter Refactor Plan

Created: 2026-06-03 17:02
Last Updated: 2026-06-03 22:19
Status: Active

## Goal

Implement [spec.md](./spec.md) in small, evidence-preserving phases.

Maximum implementation principle:

```text
Refactor module boundaries while preserving the spike's functional completeness and correctness.
```

The order matters: protect behavior first with top-down functional characterization tests, then improve module boundaries, then make boundary fitness functions pass as the relevant refactor phases land.

Global execution loop:

```text
Incremental copy-transfer refactor.
```

Use the live adapter path as the oracle and temporary scaffold. In this repo, "live adapter path" means the current exported behavior in [nodejs/src/experimental/codexAdapter.ts](../../../../nodejs/src/experimental/codexAdapter.ts), plus [nodejs/src/experimental/codexAdapterServer.ts](../../../../nodejs/src/experimental/codexAdapterServer.ts) for long-running backend mode, verified through selected-profile conformance and Chatpilot acceptance artifacts.

Do not treat stale inline harness implementations inside [nodejs/examples/copilot-codex-adapter-spike.ts](../../../../nodejs/examples/copilot-codex-adapter-spike.ts) as the copy-transfer oracle. They may be historical residue or temporary harness material only.

Build new clean modules from the smallest useful behavior bricks. After each brick is implemented, add a dedicated module test, insert the brick into the live adapter flow through a minimal temporary bridge, and run the Phase 1 functional no-regression suite. Temporary integration code can be dirty, but new module interfaces and return shapes must stay clean.

This method applies to every implementation phase after Phase 1, not only to mapper extraction.

The phases below define which layer is being made clean. The execution loop defines how each layer is built safely.

Per-brick loop:

1. Choose the smallest useful behavior brick for the current phase.
2. Copy or translate that behavior into a clean new module/interface.
3. Write the brick's dedicated module test.
4. Insert the brick into the live adapter flow through a temporary bridge.
5. Run the Phase 1 functional no-regression suite.
6. Expand composed conformance/E2E evidence when the brick affects runtime behavior, side effects, or continuity.
7. Mark the duplicated old adapter logic with its replacement/deletion condition.

Do not batch many bricks before testing. The safety comes from repeating this loop until the live adapter path has been fully replaced by clean modules.

## Phase 0: Canonical Refactor Contract

Purpose: make the refactor source-of-truth explicit before touching code.

Actions:

- Create this refactor spec/plan pair.
- Point `docs/todo.md` P1 to this spec/plan.
- Treat [../module-cleanup-plan.md](../module-cleanup-plan.md) as absorbed design input, not the active implementation plan.

Exit criteria:

- Active todo links to the refactor spec and plan.
- Reference docs remain linked from the spec.
- No adapter code has been changed before the refactor contract is written.

Evidence level:

- Documentation evidence only.

## Phase 1: Top-Down Functional Characterization

Purpose: protect the spike's current functional correctness before changing module shape.

This phase is not meant to certify the current Codex adapter shape as architecturally clean. The current shape is known to have boundary violations, such as gateway details living in the same public experimental module as the facade. Phase 1 should preserve behavior while avoiding tests that freeze the wrong boundary.

Testing direction:

- Start from the largest practical in/out functional seam.
- Ignore the current internal module boundaries when asserting behavior.
- Move from large to small only where the smaller seam is stable enough to survive refactor.
- Keep tests simple enough that they are easy to update when module extraction changes file/class layout.
- Do not write exhaustive tests against the current mixed `CodexCopilotAdapterServer` / `CodexAppServerClient` shape just because that shape exists today.

Actions:

- Run current adapter unit/build checks as a smoke and compile baseline.
- Run or preserve current selected-profile conformance baseline as the broadest behavior oracle.
- Add lightweight functional characterization tests at the adapter-facing in/out level for the behavior pockets most likely to break during extraction.
- Prefer tests that assert request/result semantics, transcript/tool/permission behavior, and error/unsupported visibility without asserting private helper order.
- Define this characterization suite as the no-regression gate for every later copy-transfer insertion.
- Classify the new and existing checks by evidence level: L2 contract shape, L3 durable side effect, L4 continuity/cross-backend parity.
- Define target boundary fitness checks as a later pass/fail goal, marking current violations as refactor targets rather than current-state failures.
- Record target boundary fitness status in [boundary-fitness.md](./boundary-fitness.md).

Recommended top-down functional test ladder:

- L4 / broadest existing oracle: selected-profile conformance and Chatpilot acceptance artifacts.
- L3 / durable behavior pockets: command approval side effect, file approval side effect, custom tool result delivery, session reuse/resume evidence.
- L2 / stable adapter contract pockets: capability claims, protocol-v2/v3 tool-call shape, permission request/decision mapping, unsupported/deferred capability reporting.
- Future mapper unit tests: added only when mapper boundaries are being extracted and the in/out contract is stable.

Target boundary fitness checks:

- Root SDK public API does not export Codex adapter internals.
- `./experimental/codex-adapter` exposes only documented facade/options/capability API.
- Raw gateway implementation details, raw JSON-RPC types, and provider-specific event/error unions are not public package API.

Exit criteria:

- Current behavior is characterized with passing broad-to-small functional checks that do not depend on the current messy module layout.
- The functional characterization suite is explicit enough to run after each new brick is inserted into the live adapter flow.
- [boundary-fitness.md](./boundary-fitness.md) records each target boundary rule as `passing-now`, `expected-violation`, or `not-yet-implemented`.
- Target boundary fitness functions are defined with explicit status: `passing-now`, `expected-violation`, or `not-yet-implemented`.
- Each `expected-violation` points to the refactor phase that should make it pass.
- The baseline evidence path is recorded before extraction.

Evidence level:

- L2 for stable adapter contract pockets.
- L3 for side-effect behavior pockets.
- L4 for session continuity, resume, and cross-backend parity.

## Phase 2: Pure Mapper Layer

Purpose: move translation knowledge out of adapter orchestration without touching runtime IO.

Extraction candidates:

- command approval request/result mapping;
- file-change approval request/result mapping;
- SDK tool descriptor to Codex dynamic tool shape;
- SDK tool result to Codex dynamic tool response;
- model and sandbox request shape conversion;
- protocol-v2/v3 dynamic tool request normalization when separable without creating fake Strategy objects.

Rules:

- Build one mapper brick at a time.
- Keep the live adapter code path available as the comparison oracle until the mapper brick has dedicated tests and passes the Phase 1 no-regression suite after insertion.
- Follow the global per-brick loop for each copied mapper behavior.
- Mapper modules must not import the runtime gateway.
- Mapper modules must not read or mutate session state.
- Mapper modules must not log or perform IO.
- Mapper tests should assert missing/unsupported/parse-failed evidence explicitly where relevant.

Exit criteria:

- Each copied mapper brick has a dedicated test before it is treated as complete.
- Each mapper brick can be inserted into the live adapter flow without breaking Phase 1 functional no-regression checks.
- Mapper tests fail on mapping drift.
- `CodexCopilotAdapterServer` has less translation logic embedded in orchestration methods.
- Existing adapter conformance still passes.

Evidence level:

- L2 for mapper contracts.
- L3/L4 only for mappings that affect tool, file, approval, or session-continuity side effects.

## Phase 3: Runtime IO Gateway Boundary

Purpose: make Codex app-server IO an internal gateway seam.

Actions:

- Move `CodexAppServerClient` or its successor behind an internal gateway module.
- Introduce a small internal gateway capability shape for facade injection and tests.
- Remove raw gateway class exposure from the experimental package public surface if currently exposed.
- Keep runtime process, JSON-RPC request/response, timeout, and transcript capture in the gateway.

Rules:

- Build gateway capability bricks incrementally, not as one large rewrite.
- Keep the current `CodexAppServerClient` path as oracle/scaffold until each gateway brick has a dedicated test and has been inserted through the live adapter flow.
- Follow the global per-brick loop for process lifecycle, JSON-RPC request/response, notification/request handling, timeout, and transcript capture bricks.
- Gateway can touch Codex app-server.
- Gateway cannot own SDK-facing semantic translation.
- Gateway errors must remain observable and not be normalized into silent success.

Exit criteria:

- Each copied gateway brick has a dedicated test before it replaces live adapter behavior.
- Each gateway brick can be inserted into the live adapter flow without breaking Phase 1 functional no-regression checks.
- Public export leakage guard passes.
- Adapter facade can depend on gateway capability rather than concrete external-runtime class knowledge.
- Existing conformance still passes.

Evidence level:

- L2 for public/internal API shape.
- L3 for runtime transcript/error observability.

## Phase 4: Adapter Facade Slimming

Purpose: make `CodexCopilotAdapterServer` a true facade/orchestrator, not a knowledge warehouse.

Actions:

- Delegate mapper work to pure modules.
- Delegate Codex IO to gateway.
- Keep session attachment/lifecycle orchestration local only if it is truly adapter workflow state.
- Keep unsupported/deferred capabilities explicit.
- Keep protocol-v2/v3 behavior explicit but localized.

Rules:

- Slim the facade one workflow brick at a time.
- Keep temporary delegations explicit and removable while mapper/gateway/session bricks are being inserted.
- Follow the global per-brick loop for session create, resume, send, get messages, destroy, permission, and tool-call workflow bricks.
- Facade methods should hide decisions, not just forward one-to-one.
- Callers should not choose raw protocol branches manually.
- Chatpilot app semantics must remain outside the adapter.

Exit criteria:

- Each facade workflow brick has a dedicated or composed test before old inline logic is removed.
- Each facade workflow brick can be inserted without breaking Phase 1 functional no-regression checks.
- A reader can identify facade, mapper, gateway, and session workflow responsibilities separately.
- Existing conformance still passes.

Evidence level:

- L2 for SDK-visible contract shape.
- L4 for session create/reuse/resume continuity when touched.

## Phase 5: Conformance Harness Decomposition

Purpose: turn the large spike harness into proof infrastructure.

Split by responsibility:

- `scenarios`: scenario intent and expected outcomes;
- `backend runners`: Copilot CLI baseline and Codex adapter execution;
- `transcript/ledger`: normalization and event sequence capture;
- `assertions`: contract, dataflow, side-effect, and intent checks;
- `reports`: artifact assembly and matrix output;
- `fixtures`: temporary workspace, file state, config, and process lifecycle helpers.

Rules:

- Decompose one harness responsibility brick at a time.
- Keep the old harness output as the oracle until each new harness brick preserves or improves the same evidence.
- Follow the global per-brick loop for scenario, runner, ledger, assertion, report, and fixture bricks.
- Scenarios should not know process lifecycle details.
- Assertions should not launch backends.
- Report assembly should not decide pass/fail semantics.
- Normalization should preserve missing, unsupported, parse-failed, and errored evidence.

Exit criteria:

- Each harness brick has a dedicated test or golden evidence comparison before replacing old harness logic.
- Each harness brick can be inserted without weakening Phase 1 no-regression or selected-profile conformance evidence.
- A new scenario can be added without editing runner/report internals.
- A new backend can be compared without rewriting scenario intent.
- Failure output identifies whether scenario, runner, ledger, assertion, or report failed.
- Existing selected-profile conformance artifacts remain semantically equivalent or intentionally improved with documented evidence.

Evidence level:

- L2 for contract assertions.
- L3 for command/file/tool side effects.
- L4 for resume, session reuse, multi-turn, and cross-backend parity.

## Phase 6: Conditional Strategy / Policy Extraction

Purpose: introduce variation handlers only where the code proves a real variation axis.

Allowed candidates:

- protocol-v2 vs protocol-v3 dynamic tool handling;
- approval policy modes with multiple actual behaviors;
- tool deny/failure result behavior when SDK-visible outcomes differ.

Do not extract:

- single-rule behavior with no variants;
- speculative runtime hooks;
- a generic runtime framework interface not exercised by at least one more backend.

Rules:

- Apply the global per-brick loop only after a real variation axis is proven.
- Keep pure functions until the second meaningful variant or near-term conformance need exists.
- Insert Strategy/Policy bricks through the live adapter flow first; do not switch the facade wholesale.

Exit criteria:

- Each Strategy/Policy brick has a dedicated variant test before replacing old conditional logic.
- Each Strategy/Policy brick can be inserted without breaking Phase 1 functional no-regression checks.
- Every Strategy/Policy has at least two meaningful variants or a documented near-term conformance need.
- No pattern exists only to make the code look architectural.

Evidence level:

- L2 for policy contract.
- L3/L4 when the policy changes side effects or continuity behavior.

## Phase 7: Audit And Canonical Closeout

Purpose: prove the refactor preserved behavior and improved module boundaries.

Actions:

- Compare before/after conformance artifacts.
- Inspect public exports for runtime-specific type leakage.
- Inspect module imports for boundary violations.
- Confirm no test was weakened from proof to smoke.
- Confirm the global per-brick loop was followed for mapper, gateway, facade, harness, and any Strategy/Policy extraction.
- Confirm new modules have dedicated tests and are covered by composed conformance/E2E evidence.
- Confirm old duplicated spike paths have been deleted or explicitly archived as non-active reference code.
- Update code map and canonical docs if code surfaces moved.
- Archive completed todo with evidence in `docs/todo-finished.md`.

Exit criteria:

- Refactor evidence satisfies [spec.md](./spec.md).
- `docs/todo.md` has no stale active items for completed phases.
- `docs/spec.md` and code map point to the current module surfaces.

Evidence level:

- L2/L3/L4 according to feature intent.

## Minimum Verification Commands

Run the relevant subset after each phase; run the full set before closeout.

```bash
cd nodejs
npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts test/codex-adapter.test.ts
npx eslint src/experimental/codexAdapter.ts src/experimental/codexAdapterServer.ts test/codex-adapter.test.ts
npm run build
npx vitest run test/codex-adapter.test.ts
```

Phase 1 functional no-regression gate:

```bash
cd nodejs
SPIKE_PHASE=all \
SPIKE_TIMEOUT_MS=90000 \
SPIKE_ADAPTER_APPROVAL_POLICY=untrusted \
SPIKE_ADAPTER_APPROVALS_REVIEWER=user \
SPIKE_ADAPTER_SANDBOX_MODE=workspaceWrite \
SPIKE_APPROVAL_PROBE_PATH=/tmp/copilot-codex-approval-refactor-phase1 \
SPIKE_FILE_PROBE=1 \
SPIKE_TOOL_PROBE=1 \
SPIKE_TOOL_FAILURE_PROBE=1 \
SPIKE_WORKDIR=/tmp/copilot-codex-work-refactor-phase1 \
SPIKE_OUT=/tmp/copilot-codex-refactor-phase1-all.json \
npx tsx examples/copilot-codex-adapter-spike.ts
```

```bash
cd nodejs
CHATPILOT_ACCEPTANCE_BACKENDS=all \
CHATPILOT_ACCEPTANCE_OUT=/tmp/chatpilot-codex-refactor-phase1-all.json \
npx tsx examples/chatpilot-runtime-acceptance.ts
```

Conformance and acceptance rules:

- Run the selected-profile conformance harness when adapter behavior, mapper behavior, gateway behavior, or harness assertions move.
- Run the Chatpilot runtime acceptance harness when SDK-visible behavior, protocol-v2 compatibility, tool handling, or session continuity changes.
- Preserve machine-readable artifacts for audit.

## Stop / Review Boundaries

Stop and request review when:

- public package exports change;
- gateway/facade boundaries change;
- protocol-v2/v3 behavior is reshaped;
- conformance evidence shape changes;
- a phase crosses from adapter module cleanup into generic runtime framework design.
