# Runtime Adapter Architecture Boundary

Created: 2026-06-03 11:41
Last Updated: 2026-06-03 11:41
Status: Reference

## Context

This note records the architecture mental model that should guide the Codex adapter refactor after the SHIP and LOS canon-deepen pass.

Related anchors:

- SHIP: [../../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md](../../.ship/SHIP-codex-adapter-module-cleanup@2026-06-01.md)
- Learning packet: [../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md](../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md)
- Runtime backend code map: [../architecture/runtime-backend-code-map.md](../architecture/runtime-backend-code-map.md)

## Core Analogy

The runtime adapter boundary is like customs.

- The app is the traveler.
- The runtime adapter workflow is the stable customs SOP.
- The runtime backend is the customs computer system and equipment.
- The gateway is the officer who operates the external system.
- The mapper is the translator between traveler/SOP language and system language.
- Fitness functions are physical gates and scanners that enforce hard rules.

The boundary has value only when people outside customs do not need to learn the internal customs computer system.

## Partial Boundary

A partial boundary is an MVP customs counter.

It is not the full international customs framework. It is a pragmatic boundary that gives us enough separation now without over-designing before multiple runtime backends exist.

Allowed leakage:

- The app can know it is using an agent runtime.
- The app can submit stable identity, prompt, tools, metadata, approval policy, and session context.
- The app can receive stable transcript, tool intent, completion, and error semantics.

Disallowed leakage:

- The app should not know provider-specific event unions.
- The app should not know provider-specific error enums.
- The app should not choose provider-specific endpoints or protocol branches.
- The app should not need to understand runtime-specific session transport details.

Design rule:

```text
App can know runtime capability semantics, but must not know runtime implementation mechanics.
```

## Dependency Rule

Dependencies should point toward the stable SOP, not the current customs computer system.

In this repo:

- Stable policy: app semantics and runtime-adapter workflow contract.
- Volatile detail: Codex app-server, Copilot CLI, Gemini CLI, opencode, or another runtime implementation.
- Adapter responsibility: connect volatile runtime details to stable workflow semantics.

Design rule:

```text
App / Chatpilot semantics
  -> Runtime Adapter Workflow Contract
  -> Runtime Implementation Detail
```

Violation:

```text
App / Chatpilot semantics
  -> Codex-specific event shape / provider-specific error enum
```

## Gateway And Mapper

Gateway and mapper should be separated because their change axes differ.

Gateway:

- Talks to the external runtime.
- Owns process, HTTP, session IO, stream receiving, timeout, and connection failure behavior.
- Touches the outside world.

Mapper:

- Translates stable workflow requests into runtime-specific requests.
- Translates runtime-specific events, tool calls, and errors back into stable workflow results.
- Should be pure translation where possible.

Design rule:

```text
Gateway touches the outside world.
Mapper should be pure translation.
```

Failure modes:

- Mapper calls runtime IO: translation now has side effects, so mapping cannot be tested cleanly and runtime errors mix with mapping errors.
- Gateway owns translation: every runtime path grows ad hoc protocol branches and repeated semantic conversion logic.
- Gateway and mapper stay mixed: the code becomes a pile of runtime/protocol `if` / `switch` branches as soon as multiple backends exist.

## Fitness Functions

Architecture docs are SOP. Fitness functions are gates and scanners.

Use docs for semantic guidance:

- Whether a facade is over-abstracted.
- Whether a boundary is conceptually clean.
- Whether partial boundary is enough or full framework is now justified.

Use fitness functions for mechanical rules:

- App-level code must not import runtime internals.
- Public adapter API must not export runtime-specific types.
- Conformance artifacts must include transcript/dataflow/side-effect evidence.
- Tests must not pass on exit code or HTTP success alone.

Design rule:

```text
Architecture docs explain judgment.
Fitness functions enforce clear violations.
```

## Refactor Guidance

- Start with characterization evidence before extraction.
- Extract pure mappers before reshaping runtime IO.
- Keep runtime-specific IO behind gateway modules.
- Keep app semantics dependent on stable adapter workflow, not provider details.
- Add explicit checks for type/export leakage before calling the boundary clean.
- Treat full multi-runtime framework extraction as future work that requires evidence from at least one more real backend.

## Review Questions

1. Does the facade hide runtime implementation mechanics, or only gather them behind one entry point?
2. Do exported TypeScript types leak runtime-specific event or error shapes?
3. Can mapper logic be tested without starting a runtime?
4. Can gateway logic be tested without asserting mapper internals?
5. Which architecture rules are clear enough to become fitness functions?
