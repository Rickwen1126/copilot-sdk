# SHIP: Codex Adapter Module Cleanup

Created: 2026-06-01 15:59
Last Updated: 2026-06-01 16:14
Status: Ready
Tags: [ship, design-patterns, codex-adapter, runtime-backend, copilot-sdk]

## 0. AI Context

- Codebase current state: Codex app server + Copilot SDK integration has reached behavior-conformance closeout for the scoped Chatpilot flow. The current code is usable but still visibly spike-graduated rather than PR-grade modular shape.
- Relevant docs/specs: `docs/spec.md`, `docs/todo.md`, `docs/todo-finished.md`, `docs/integrations/codex-sdk-runtime-profile/plan.md`, `docs/architecture/runtime-backend-code-map.md`.
- Relevant code surfaces: `nodejs/src/experimental/codexAdapter.ts`, `nodejs/src/experimental/codexAdapterServer.ts`, `nodejs/examples/copilot-codex-adapter-spike.ts`, `nodejs/examples/chatpilot-runtime-acceptance.ts`, `nodejs/test/codex-adapter.test.ts`.
- Scale signal: `codexAdapter.ts` is about 1.7k lines and mixes facade, protocol handling, mapping, session IO, and permission/tool conversion. `copilot-codex-adapter-spike.ts` is about 4.9k lines and mixes probe transport, scenario execution, transcript normalization, assertion, and report assembly.
- Existing invariants: Chatpilot route identity, memory partitioning, and app tools stay app-substrate concerns. Runtime backend adapters must not define product route semantics. Logs alone are not pass evidence; dataflow and side-effect assertions remain required.
- Constraints: keep experiments behind adapter boundaries; do not break current protocol-v2 Python SDK compatibility or protocol-v3 default behavior; do not expand scope into a generic open-source runtime framework before extracting proven seams.
- Blind spots: exact final file names can wait until implementation, but responsibility boundaries are clear enough to start mechanical extraction under characterization tests.
- Survey needed: no for starting this cleanup. External framework survey is not decision-shaping for this milestone because this work is about simplifying existing integration surfaces, not choosing a new runtime.

## 0.5 LOS Canonical Fit

| Learning point | Lens | Family | Readiness | Grounding mode | Use for | Seed/source clues | Missing / risk | Next action |
|---|---|---|---|---|---|---|---|---|
| Pattern choice should follow variation pressure, not pattern catalog aesthetics | implementation | design-patterns | ready | full-canon | Decide whether to use Facade, Adapter, Strategy, Policy, or pure mapper extraction | Family guidance: start from pressure/smell, source of variation, collaboration shape, safe refactoring path | Risk of over-abstracting into ceremony | los-canon-deepen before design review |
| Runtime backend cleanup must preserve app-substrate vs runtime responsibility | structural | software-architecture | ready | full-canon | Keep Chatpilot route/memory/tool semantics outside the Codex runtime backend | Existing spec/code map already defines adapter boundary and source-of-truth roles | Risk of making Codex adapter accidentally own app semantics | los-canon-deepen before design review |
| Conformance harness is a contract/evidence surface, not a miscellaneous example script | implementation | testing | first-pass-ready | first-pass-canon | Split test harness by scenario, ledger, assertion, report, and runtime backend while preserving data-level evidence | Current acceptance artifacts and log/dataflow assertions already prove behavior | Risk of refactor weakening silent-failure detection | evidence-path + los-canon-deepen before audit |
| Protocol and tool lanes need types that expose variants without hiding runtime validation | implementation | typescript-type-system | first-pass-ready | first-pass-canon | Encode protocol-v2/v3 and tool/permission mapping seams clearly | Current adapter has explicit v2/v3 dynamic tool handlers and mapping functions | Risk of type cleanup masking unsupported capabilities | local-source deepen if type API gets controversial |

## 0.6 LOS Canon Deepen Preflight

This SHIP now has a source-grounded learning packet: `docs/integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md`.

NotebookLM relation navigation was completed for `design-patterns`, `software-architecture`, and `testing`, followed by local source/index verification against the Learning OS family materials. The cleanup can still start because the immediate choice is narrow and evidence-backed: keep the adapter boundary, lock behavior with conformance tests, and extract along existing variation axes. The learning packet should be reviewed before design review, audit, or any attempt to generalize this into a multi-runtime framework.

| Deepening target | Family notebook / source set | Why deepen | Verification path | Blocking for start? |
|---|---|---|---|---|
| Pattern-guided cleanup without pattern theater | `design-patterns` NotebookLM `ec921bab-c012-496a-b5b9-5ecc5bff6ee7`; sources: `Refactoring`, `A Philosophy of Software Design`, `Design Patterns`, `API Design Patterns` | Ground the Facade/Adapter/Strategy/Policy/Mapper split in complexity-control and safe-refactoring tradition, not naming aesthetics | completed in learning packet; local verification still required during implementation | no; review packet before design review |
| Runtime backend boundary and integration topology | `software-architecture` NotebookLM `d1b88f67-effa-4c07-93c8-2e271bbda089`; sources: `Clean Architecture`, `Enterprise Integration Patterns`, `Fundamentals of Software Architecture`, `Software Architecture in Practice` | Clarify whether this is a partial boundary, gateway, mapper, or facade around a runtime capability | completed in learning packet; compare implementation against `docs/spec.md` and `runtime-backend-code-map.md` | no; review packet before broad framework extraction |
| Conformance harness as contract evidence | `testing` NotebookLM `fede5587-cf2c-4aeb-ac4f-93ffc2d2ded1`; sources: `xUnit Test Patterns`, local `E2E testing philosophy` anchor | Avoid making tests pass while weakening proof quality; classify characterization tests, contract tests, fixtures, and silent-failure checks | completed in learning packet; compare before/after artifacts during audit | no; required before audit |
| Type API boundary for protocol/tool variants | `typescript-type-system` has no ready NotebookLM; local official snapshots only | If extraction turns into type/API design debate, verify discriminated unions, `unknown`, narrowing, structural compatibility, and declaration boundary behavior | Degraded local-only deepen using family snapshots and repo examples; do not label as completed NotebookLM deepen | no; conditional |

## 1. Problem Statement

**Problem**: The current Codex adapter integration has behavior evidence, but its module shape still carries spike gravity: large files, mixed responsibilities, and test harness code that is hard to review or evolve.

**Affected user/system**: Chatpilot runtime backend integration, Copilot SDK adapter consumers, and future developers trying to add or compare runtime backends without turning the project into a patchwork framework.

**Success condition**: The same scoped Copilot SDK + CLI behavior remains green, while adapter responsibilities are split into stable module seams that make future protocol/tool/runtime changes local and reviewable.

**Decision needed now**: Clean the module codebase using design-pattern reasoning, but constrain the cleanup to proven variation axes instead of building a broad runtime framework.

## 2. Solution Space

| Approach | Advantages | Risks / Costs | When it wins |
|---|---|---|---|
| A. Keep spike-graduated code, add docs only | Lowest immediate code churn; preserves known behavior | Complexity keeps accumulating in huge files; future runtime work pays interest | Short-lived experiment only |
| B. Pattern-guided extraction around real seams | Reduces mixed responsibilities while preserving adapter boundary; gives reviewable modules and contract tests | Requires careful characterization before moving code | Best current fit: behavior is proven and the next bottleneck is code shape |
| C. Build generic multi-vendor runtime framework now | Opens a broad open-source runtime route immediately | Too early; risks recreating OpenClaw/n8n-style glue complexity and weakening the focused Chatpilot substrate | Only after multiple backends prove shared abstractions |

**Choice**: B. Pattern-guided extraction around real seams.

**Reason**: The user goal is not loyalty to Copilot SDK or Codex, but a clean runtime adapter boundary. Current evidence says the scoped Codex backend can behave like the Copilot SDK + CLI lane; the next value is to remove spike coupling without inventing abstractions ahead of demonstrated variation.

## 3. Technical Decisions

| Decision point | Choice | Reason | Alternatives |
|---|---|---|---|
| Public boundary | Keep a small Codex adapter facade, likely centered around `CodexCopilotAdapterServer` and client option creation | Callers need one clear entrypoint; internals can change | Expose many low-level modules directly |
| Responsibility split | Extract pure mapper modules for permission, file change, dynamic tool descriptor, tool result, and session/event conversion | Mapping logic is low-risk to characterize and naturally testable | Keep mapping methods embedded in server class |
| Protocol variation | Treat protocol-v2/v3 tool-call handling as strategy/policy lanes after characterization tests | Protocol variant is a real source of variation and should not spread across the server | One branch-heavy handler that knows every variant |
| Runtime IO | Keep Codex app server client IO separate from Copilot SDK protocol handling | Network/app-server failure modes differ from SDK-facing message semantics | One adapter class that owns both transport and protocol conversion |
| Conformance harness | Promote spike harness internals into support modules: scenarios, transcript ledger, assertions, reports, backend runners | The harness is now evidence infrastructure, not disposable demo code | Leave 4.9k-line script as the main testing surface |
| Test strategy | Lock behavior with existing conformance/acceptance commands before and after extraction | Refactor must preserve dataflow, side effects, and unsupported capability notes | Rely on TypeScript compile and unit tests only |
| Framework scope | Do not create a universal `RuntimeBackend` implementation framework in this milestone | Avoid premature generalization; let Codex cleanup reveal reusable seams | Generalize now across Codex, Gemini CLI, opencode, OpenClaw-style cores |

## 4. Knowledge Risk B/R/N

### [B]lock

- None.

### [R]isky

- Pattern selection by variation axis: the risk is treating design patterns as names to apply rather than responsibilities to separate.
  - Decision-shaping: yes
  - Completion standard: trade-off
  - Exit Questions:
    1. Why is a small Facade + Adapter + Strategy/Policy split better here than a generic runtime framework? [A/C]
    2. What smell would tell us this cleanup has become over-abstracted ceremony? [A/C]
  - User answer / evidence: User has repeatedly framed the goal as avoiding patchwork architecture and avoiding n8n/OpenClaw-style over-broad glue, while keeping a runtime adapter boundary that can swap Copilot SDK/Codex later.
  - Status: clarified
  - Audit probe: After implementation, changed modules should show fewer mixed responsibilities without adding a large generic abstraction layer.

- Conformance harness as architecture guard: the risk is making the code prettier while reducing proof quality.
  - Decision-shaping: yes
  - Completion standard: evidence-path
  - Exit Questions:
    1. Which parts must remain contract evidence rather than helper convenience? [A/B]
    2. How would we detect a silent pass where logs exist but the runtime did not actually perform the intended dataflow? [A/B]
  - User answer / evidence: Prior conclusion requires log dataflow, behavior intention, and durable side-effect correctness, not just startup or output existence.
  - Status: clarified
  - Audit probe: Same conformance/acceptance artifacts must still prove SDK send/response, tool call transcript, memory save/list side effects, and cross-backend parity.

- Protocol-v2/v3 and tool-call split: the risk is extracting too early and hiding differences that matter for Python SDK compatibility.
  - Decision-shaping: yes
  - Completion standard: evidence-path
  - Exit Questions:
    1. Which behavior is stable intent, and which behavior is protocol-version-specific transport shape? [A/B]
    2. What failure would appear if v2/v3 tool-call paths shared the wrong abstraction? [A/B]
  - User answer / evidence: Current docs already record v3 default and Chatpilot Python SDK using protocol v2; both must remain explicit after cleanup.
  - Status: clarified
  - Audit probe: Tests and artifacts must still cover protocol-v2 tool-call transcript and protocol-v3 default path assumptions.

### [N]ice

- Perfect public naming for every extracted module.
- Generalized multi-runtime SDK API spanning Codex, Gemini CLI, opencode, and OpenClaw-like cores.
- Deep external framework comparison during this cleanup milestone.

## 5. Learning Contract

| Learning point | Decision relevance | LOS lens/family | Angle | Coverage | B/R/N | Gap | Completion standard | Gate status | Audit probe | Bank candidate | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Pattern choice by variation axis | High | implementation / design-patterns | Patterns are selected from pressure, variation, and collaboration shape | full-canon | R | A/C | trade-off | clear | Refactor reduces mixed responsibility without over-generalization | yes | los-canon-deepen before design review |
| Runtime adapter boundary | High | structural / software-architecture | App substrate semantics stay outside runtime backend | full-canon | R | A/C | trade-off | clear | No Chatpilot route/memory ownership leaks into Codex adapter internals | yes | los-canon-deepen before design review |
| Contract tests as architecture guard | High | implementation / testing | Conformance harness protects dataflow and side effects during refactor | first-pass-canon | R | B | evidence-path | clear | Same artifacts prove behavior before/after extraction | yes | los-canon-deepen before audit |
| Protocol/type boundaries | Medium | implementation / typescript-type-system | Types expose protocol variants and mapper contracts | first-pass-canon | R | B | evidence-path | clear | v2/v3 tool behavior remains explicit and tested | maybe | local-source deepen if API boundary gets controversial |
| Multi-runtime public framework | Low for this milestone | structural / software-architecture | Future generalization after multiple backends prove seams | full-canon | N | C | none | deferred-non-decision-shaping | Revisit only after another backend is implemented | maybe | los-canon-deepen in next runtime-framework SHIP |

## 6. Learning Extension Queue

| Learning point | Why extend | Mode | Expected return | Write back |
|---|---|---|---|---|
| Pattern-guided cleanup without pattern theater | This is the core design-pattern learning point: we want cleaner seams, not a decorative pattern catalog. NotebookLM should relate refactoring, complexity control, pattern selection, and API surface sources. | side | source-grounded design guidance + original reading path | this SHIP file |
| Runtime backend boundary and integration topology | This is where `software-architecture` can prevent accidental framework creep: adapter, port, facade, anti-corruption, gateway, and integration pattern vocabulary need source-backed distinction. | side | relation findings + verification order + boundary vocabulary | this SHIP file |
| Conformance harness as contract evidence | Testing family should ground how characterization/contract tests protect behavior during refactor and how to detect silent pass. | side | testing proof model + audit probes | this SHIP file |
| Protocol/type API boundary | TypeScript family has no NotebookLM yet, so this is a conditional local-source deepen if extraction design starts depending on discriminated unions, `unknown`, narrowing, or public declaration boundaries. | inline | local source clues + type-boundary cautions | this SHIP file |
| Cross-runtime abstraction across Codex, Gemini CLI, opencode, and OpenClaw-like cores | Useful later, but not needed before this cleanup; premature survey may distort the local refactor | side | source-clue or future SHIP input | this SHIP file or next runtime-backend SHIP |

## 7. Ship Gate

- [x] All `[B]` knowledge risks cleared by user answer, source check, or spike result
- [x] All decision-shaping `[R]` items passed their completion standard or have a pre-decision spike/evidence path
- [x] No important learning point is deferred unless it is explicitly non-decision-shaping
- [x] Block count <= 3
- [x] Problem statement is clear
- [x] Solution space was compared
- [x] Technical decisions have reasons
- [x] LOS canonical fit recorded
- [x] Audit probes exist for important learning points

**Status**: 可開工
