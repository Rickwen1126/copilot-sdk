# Runtime Adapter Design Patterns

Created: 2026-06-03 17:02
Last Updated: 2026-06-03 17:02
Status: Reference

## Context

This note records the design-pattern rules for the Codex runtime adapter refactor.

Related anchors:

- Architecture boundary reference: [runtime-adapter-architecture-boundary.md](./runtime-adapter-architecture-boundary.md)
- Testing evidence reference: [runtime-adapter-testing-evidence.md](./runtime-adapter-testing-evidence.md)
- Learning packet: [../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md](../integrations/codex-sdk-runtime-profile/learning-design-patterns-architecture-testing.md)
- Refactor spec: [../integrations/codex-sdk-runtime-profile/refactor/spec.md](../integrations/codex-sdk-runtime-profile/refactor/spec.md)
- Refactor plan: [../integrations/codex-sdk-runtime-profile/refactor/plan.md](../integrations/codex-sdk-runtime-profile/refactor/plan.md)

## Core Principle

Use patterns to hide knowledge, not to decorate code.

```text
Split by hidden knowledge and variation axis, not by file size or pattern names.
```

A pattern is justified only when it reduces what future maintainers must understand to change one behavior.

Good extraction reasons:

- protocol shape changes;
- SDK/runtime mapping changes;
- runtime app-server IO changes;
- permission/tool policy changes;
- transcript normalization or evidence reporting changes.

Bad extraction reasons:

- the file is large but the knowledge is still one idea;
- the pattern name sounds relevant;
- the new module only forwards to another module;
- future runtime variants are imagined but not proven by code or conformance needs.

## Mapper

Mapper means translation only.

Allowed:

- convert Codex event/tool/approval shape to SDK-facing shape;
- convert SDK tool result to Codex dynamic tool response;
- convert permission result to runtime decision shape;
- expose protocol-v2/v3 mapping differences where they affect SDK-visible behavior.

Not allowed:

- runtime IO;
- session state mutation;
- permission policy decision;
- logging side effects;
- tool registry lifecycle ownership.

Review question:

```text
Can this mapper be tested without starting Codex app-server or constructing adapter session state?
```

## Facade

Facade must make callers know less.

Useful facade:

- hides protocol-version handling;
- hides runtime request/response mechanics;
- hides permission/tool conversion details;
- exposes a smaller semantic entrypoint than the implementation it coordinates.

Shallow facade:

- forwards one-to-one without hiding a decision;
- adds another object the reader must understand;
- hides unsupported capabilities or runtime failures that audit needs to see.

Review question:

```text
Does this facade hide a decision, or only add an extra hop?
```

## Strategy / Policy

Strategy or Policy is allowed only when there is real variation.

Use pure functions first. Promote only when there are multiple meaningful variants, such as:

- protocol-v2 vs protocol-v3 tool handling;
- always-approve vs interactive vs deny-by-policy approval behavior;
- distinct SDK-visible tool failure/deny behaviors.

Do not introduce Strategy/Policy for:

- a single stable rule;
- speculative future runtime hooks;
- generic runtime framework seams not exercised by another backend or near-term conformance need.

Review question:

```text
What are the actual variants, and would a simpler pure function express this better today?
```

## Harness Decomposition

The conformance harness should be split by knowledge ownership, not by execution order.

Recommended ownership:

- `scenarios`: intent and expected outcomes;
- `backend runners`: runtime launch and process lifecycle;
- `transcript/ledger`: observed evidence normalization;
- `assertions`: proof rules and pass/fail semantics;
- `reports`: artifact shape;
- `fixtures`: temporary workspaces, files, config, and process helpers.

Failure mode:

- If scenario, runner, ledger, assertion, and report logic stay fused, failures become obscure and the harness stops acting like proof infrastructure.

Review question:

```text
When a scenario fails, can we tell whether intent, runtime execution, evidence normalization, assertion, or report assembly failed?
```

## Pattern Theater Smells

- The number of modules grows, but changing one behavior still requires reading all of them.
- New interfaces are almost as complex as the implementation they wrap.
- Runtime-specific assumptions appear in many places under generic names.
- Tests assert private helper call order instead of behavior contracts.
- Strategy objects exist with only one rule and no near-term second variant.
- Facade hides failure or unsupported capability evidence.

## Refactor Order

Preferred order:

1. Lock characterization and boundary fitness functions.
2. Extract pure mappers.
3. Separate runtime IO gateway.
4. Slim adapter facade.
5. Decompose conformance harness.
6. Add Strategy/Policy only where real variation remains.

This order keeps the first moves low-risk and prevents a full runtime framework from appearing before the code has earned it.
