# SHIP: Stable Runtime Backend And ShinyiPilot Test Integration

Created: 2026-06-12 11:31
Last Updated: 2026-06-12 11:31
Status: Needs Spike
Tags: [ship, codex-adapter, copilot-sdk, shinyipilot, chatpilot, deployment]

## 0. AI Context

- Codebase current state:
  - `copilot-sdk` Codex adapter P1 is closed for the selected profile. Canonical docs point to `nodejs/src/experimental/codexAdapter.ts`, `nodejs/src/experimental/codexAdapterServer.ts`, `nodejs/src/experimental/codexAdapterToolPolicy.ts`, `nodejs/conformance/`, the full CodeTour, and the focused adapter integration diagram.
  - The adapter remains intentionally experimental. It is exposed through `./experimental/codex-adapter` and the `copilot-codex-adapter` server bin, not as a stable root SDK API.
  - `chatpilot` already has an external Copilot-protocol seam: `CHATPILOT_COPILOT_CLI_URL` feeds `cli_url` into `CopilotClient`, and `CHATPILOT_RUNTIME_BACKEND=codex-adapter` requires that URL.
  - `shinyipilot` currently creates `CopilotClient()` directly in `src/chatpilot/sdk/session.py`; it has not yet copied the `chatpilot` runtime backend / `cli_url` selection seam.
- Relevant docs/specs:
  - `docs/spec.md`
  - `docs/architecture/runtime-backend-code-map.md`
  - `docs/architecture/dataflows/codex-adapter-integration.html`
  - `docs/integrations/codex-sdk-runtime-profile/adapter-graduation/spec.md`
  - `docs/integrations/codex-sdk-runtime-profile/production-runbook.md`
  - `/Users/rickwen/code/shinyipilot/docs/spec.md`
  - `/Users/rickwen/code/shinyipilot/docs/todo.md`
- Constraints:
  - Do not touch production/default backend first. The next lane must be pure test / staging-like integration.
  - Do not use reserved ports `4800`, `4801`, or `4811`. ShinyiPilot live local runtime owns `localhost:2999`; self-contained E2E defaults to `2998`.
  - Runtime secrets, DBs, route configs, adapter session stores, and Codex auth homes must not be committed.
  - E2E pass requires data-level proof, not only process health or HTTP 200.
- Blind spots:
  - Exact ShinyiPilot deployment topology is not yet documented: local launchd-only, internal server, Cloud Run, sidecar, or separate adapter service.
  - ShinyiPilot production auth / route ownership for `/web/chat` is still an active todo, so production rollout would mix two unresolved boundaries.
  - ShinyiPilot tool catalog and binary/media behavior may differ from the Chatpilot acceptance profile.
- Survey needed: yes, but bounded. First survey should be read-only in `~/code/shinyipilot`: SDK seam, config/env surface, E2E runner, tool catalog, route/test isolation, and runtime ops state.

## 0.5 LOS Canonical Fit

| Learning point | Lens | Family | Readiness | Grounding mode | Use for | Seed/source clues | Missing / risk | Next action |
|---|---|---|---|---|---|---|---|---|
| Runtime backend boundary | structural | software-architecture | ready | full-canon | decide app-vs-runtime ownership, deployment topology, failure mode | family guide: quality attributes, boundaries, integration risk | ShinyiPilot deployment topology unknown | small-spike |
| Adapter seam shape | implementation | design-patterns | ready | full-canon | decide whether to copy Chatpilot env seam or invent new abstraction | design guide: source of variation before pattern | ShinyiPilot currently lacks `cli_url` backend selection | small-spike |
| Proof strategy | implementation | testing | baseline-usable | first-pass-canon | decide E2E level and read-back evidence | testing guide: side effect, silent failure, spec cross-check | ShinyiPilot E2E does not yet run against Codex adapter | small-spike |
| Auth/session/trust boundary | structural | security-engineering | source-grounded-first-pass | first-pass-canon | keep Codex auth home, route ownership, secrets, and web endpoints safe | security guide: asset, actor, trust boundary, credential lifecycle | `/web/chat` production auth remains open | defer production; test-only |
| Deployment and rollback | structural | cloud-infrastructure-platform | source-grounded-first-pass | first-pass-canon | decide local/staging deployment shape and rollback evidence | cloud guide: desired state vs observed state, drift, rollout topology | no current platform target chosen | learning-extension |

## 1. Problem Statement

**Problem**: The Codex adapter is clean enough for the selected profile, but before it can graduate toward a stable SDK runtime backend we need a second downstream integration beyond the existing Chatpilot evidence. The candidate is Chatpilot or ShinyiPilot; ShinyiPilot is more product-real, but it lacks the backend selection seam that Chatpilot already has.

**Affected user/system**: `copilot-sdk` maintainers, ShinyiPilot/ChatPilot runtime users, and any future app that wants to switch from Copilot CLI to Codex app-server through the SDK transport boundary.

**Success condition**: A pure test/staging-like integration proves that the downstream app can switch runtime backend through a controlled seam, preserve route/session/tool/data ownership, and pass data-level E2E read-back against both Copilot CLI baseline and Codex adapter lane.

**Decision needed now**: Whether to validate the adapter next through existing `chatpilot`, through `shinyipilot`, or through direct production deployment; and what architecture/deployment boundary must be true before implementation starts.

## 2. Solution Space

| Approach | Advantages | Risks / Costs | When it wins |
|---|---|---|---|
| A. Re-run / extend Chatpilot acceptance first | Fastest because `CHATPILOT_COPILOT_CLI_URL` and `CHATPILOT_RUNTIME_BACKEND` already exist; proven harness already compares Copilot CLI and Codex adapter | Less product-real for Shinyi; may not expose Shinyi-specific web chat, observer, route ownership, or procurement risks | Wins if the goal is regression confidence for adapter internals only |
| B. Add ShinyiPilot pure-test backend seam, then run isolated E2E | Validates the real product fork without touching production defaults; exercises Shinyi route/session/log/data conventions | Requires a small seam spike before adapter E2E; must avoid live `2999`, local DB, route config, and production web auth pitfalls | Wins if the goal is stable runtime backend graduation evidence |
| C. Direct production or live `2999` rollout | Gives realistic traffic fastest | Too risky: ShinyiPilot `/web/chat` auth/route ownership and runtime ops state docs are still open; rollback/auth/session-store behavior not proven | Does not win now; only after staged evidence and explicit rollout plan |

**Choice**: B, with A as the baseline reference and C explicitly deferred.

**Reason**: ShinyiPilot is the better graduation target because it is a productized fork with route-first runtime, web chat, observer contracts, source evidence, and real operational state. But the first slice must be a spike because ShinyiPilot currently lacks the copied transport seam and production deployment boundaries are not yet safe.

## 3. Technical Decisions

| Decision point | Choice | Reason | Alternatives |
|---|---|---|---|
| Runtime topology | Run Codex adapter as an external Copilot-protocol server, and point app SDK client at `cli_url` | Preserves app substrate while replacing runtime backend behind the SDK seam | Import adapter internals into app; replace SDK session manager |
| App boundary | ShinyiPilot keeps route_id, chatbot config, tool catalog, memory/file/source evidence, and delivery policy | Adapter must not own app semantics | Let adapter define route/session/tool semantics |
| Backend selection | Copy/adapt Chatpilot's env-based backend seam into ShinyiPilot test path | Lowest-risk delta and aligns with existing acceptance evidence | Invent new config abstraction before a second backend exists |
| Test boundary | Use isolated route settings/bindings, temp DBs, temp adapter summary/session-store paths, and non-reserved ports | Prevents production config/data mutation and makes read-back deterministic | Run against live `2999` or live route configs |
| Adapter lane defaults | Keep locked Chatpilot-style lane unless a new Shinyi runtime profile says otherwise: `approvalPolicy=never`, `sandboxMode=readOnly`, `networkAccess=false` | Prevents native Codex side effects from chatbot prompts | Use workspace-write/native tools in product chat |
| Proof level | Require Copilot CLI baseline vs Codex adapter comparison plus DB/log/tool/transcript read-back | Detects silent failures and backend drift | Only check `/health`, response text, or process exit |
| Deployment | No production rollout yet. First define local/staging-like adapter process ownership, Codex home, session store, summary logs, and rollback switch | Deployment is a state-management problem; desired state and observed state must be explicit | Direct launchd/cloud/default backend change |

## 4. Knowledge Risk B/R/N

### [B]lock

No `[B]lock` item is recorded yet. The mechanism is understandable enough to choose a small spike, but not enough to mark full implementation `可開工`.

### [R]isky

- Runtime backend boundary: the downstream app must keep app truth while only the SDK runtime changes.
  - Decision-shaping: yes
  - Completion standard: evidence-path
  - Exit Questions:
    1. If the adapter starts deciding `route_id`, tool availability, or memory partitioning, what boundary has been violated? [A]
    2. Which evidence proves the app substrate stayed stable while the runtime changed? [A]
  - User answer / evidence: pending; initial evidence path is ShinyiPilot seam inventory + baseline-vs-adapter E2E.
  - Status: needs-spike
  - Audit probe: verify route_id, sdk_session_id, tool names, DB rows, and app logs are equivalent between baseline and adapter lanes.

- ShinyiPilot transport seam: ShinyiPilot currently lacks `cli_url` runtime backend selection.
  - Decision-shaping: yes
  - Completion standard: spike-result
  - Exit Questions:
    1. Why is copying the existing Chatpilot `cli_url` seam safer than importing Codex adapter classes into ShinyiPilot? [A]
    2. What should fail at startup if `CHATPILOT_RUNTIME_BACKEND=codex-adapter` is set without an adapter URL? [A]
  - User answer / evidence: pending; spike must inspect and patch only `SdkClient` transport selection plus tests.
  - Status: needs-spike
  - Audit probe: test shows default Copilot CLI behavior unchanged and codex-adapter mode requires explicit `cli_url`.

- Deployment state ownership: production-like adapter needs durable Codex home, adapter session store, logs, and rollback switch.
  - Decision-shaping: yes
  - Completion standard: evidence-path
  - Exit Questions:
    1. Why is "app-server process is alive" not enough proof of session continuity? [A]
    2. Which files/env vars are durable runtime state, and which are test-only scratch state? [B]
  - User answer / evidence: pending; deployment topology is not chosen.
  - Status: needs-spike
  - Audit probe: staged run records `CODEX_ADAPTER_CODEX_HOME`, session store path, summary path, app log path, and rollback-to-Copilot-CLI procedure.

- Production web/chat auth boundary: ShinyiPilot already marks `/web/chat` production auth and route ownership as open.
  - Decision-shaping: yes for production, no for pure isolated test route.
  - Completion standard: failure-mode
  - Exit Questions:
    1. What abuse becomes possible if a Codex-backed `/web/chat` route can be called without route ownership checks? [A]
    2. Why can this be deferred for isolated E2E but not for production rollout? [A]
  - User answer / evidence: pending.
  - Status: deferred-non-production-only
  - Audit probe: production rollout checklist must reject enabling Codex adapter on unauthenticated `/web/chat`.

### [N]ice

- Exact env var names for the first ShinyiPilot patch.
- Exact non-reserved test port numbers, as long as they avoid `4800`, `4801`, `4811`, and live `2999`.
- Future stable package export name for the adapter.

## 5. Learning Contract

| Learning point | Decision relevance | LOS lens/family | Angle | Coverage | B/R/N | Gap | Completion standard | Gate status | Audit probe | Bank candidate | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Runtime backend boundary | Prevents adapter from taking app ownership | structural/software-architecture | app substrate vs runtime backend | full-canon | R | A | evidence-path | needs-clarify | route/session/tool/data ownership unchanged across lanes | yes | small-spike |
| Backend seam design | Decides smallest safe ShinyiPilot code delta | implementation/design-patterns | variation seam before abstraction | full-canon | R | A | spike-result | needs-clarify | default client path unchanged; adapter path explicit | yes | small-spike |
| E2E proof shape | Prevents false pass from health/text-only checks | implementation/testing | side-effect and silent-failure proof | first-pass-canon | R | A | evidence-path | needs-clarify | DB/log/tool/transcript read-back passes | yes | small-spike |
| Auth and trust boundary | Blocks production rollout until route ownership is explicit | structural/security-engineering | actor/route/session/credential boundary | first-pass-canon | R | A | failure-mode | clear for test-only; blocks production | production checklist rejects unauthenticated web route | no | defer production |
| Deployment state model | Decides local/staging process ownership and rollback | structural/cloud-infrastructure-platform | desired vs observed runtime state | first-pass-canon | R | B | evidence-path | needs-clarify | runbook records adapter home/store/log/rollback | yes | learning-extension |

## 6. Learning Extension Queue

| Learning point | Why extend | Mode | Expected return | Write back |
|---|---|---|---|---|
| ShinyiPilot deployment topology | Current repo docs show local `2999`, temp E2E `2998`, launchd/runtime-state todos, but no final platform target | inline | source-clue + deployment options | this SHIP file |
| ShinyiPilot tool/media profile vs Chatpilot selected profile | ShinyiPilot has web/client tools, observer/procurement tools, WorkProof integration, and binary/media caveats that may differ from the Chatpilot acceptance profile | inline | brn-update + tool profile delta | this SHIP file |

## 7. Ship Gate

- [x] All `[B]` knowledge risks cleared by user answer, source check, or spike result
- [ ] All decision-shaping `[R]` items passed their completion standard or have a pre-decision spike/evidence path
- [x] No important learning point is deferred unless it is explicitly non-decision-shaping
- [x] Block count <= 3
- [x] Problem statement is clear
- [x] Solution space was compared
- [x] Technical decisions have reasons
- [x] LOS canonical fit recorded
- [x] Audit probes exist for important learning points

**Status**: 先做 spike

First spike boundary:

1. In `~/code/shinyipilot`, read-only confirm current SDK seam, E2E runner, config/test route isolation, tool catalog, and runtime ops state.
2. Patch only the ShinyiPilot SDK transport seam and tests if the read-only inventory confirms the Chatpilot seam can transfer cleanly.
3. Run isolated E2E with Copilot CLI baseline first.
4. Start `copilot-codex-adapter` on a non-reserved test port with temp summary/store paths, then rerun the same isolated E2E against `CHATPILOT_RUNTIME_BACKEND=codex-adapter`.
5. Record pass/fail with data-level read-back: route_id, sdk_session_id, tool call/result logs, DB rows, adapter summary, and rollback to baseline.
