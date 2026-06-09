# Alternate Runtime Backends (Experimental)

Created: 2026-04-28
Last Updated: 2026-06-09 11:45
Status: Experimental

Use this guide when you want a Copilot-shaped SDK experience in the app layer, but do **not** want the Copilot runtime contract to become your system's core substrate.

The intended pattern is:

- Your app owns the system substrate and event model.
- A runtime node delegates execution to a pluggable backend.
- GitHub Copilot can be the first backend because it is the most mature glue today.
- Codex, Gemini CLI, Opencode, or AgentAPI can be added later without rewriting the app's core nouns.

## Overview

There are two layers to keep separate:

| Layer | Owns | Should not own |
|---|---|---|
| **App substrate** | event routing, execution identity, memory partitioning, policy, side-effect flow | vendor-specific session semantics |
| **Runtime backend** | session lifecycle, turn execution, model selection, tool/event streaming | app-level routing, memory ownership, business policy |

This separation lets you use the Copilot SDK today without forcing every future runtime to look like Copilot at the app architecture level.

## Design Principles

1. Prefer a **thin backend contract** over a universal agent framework.
2. Treat Copilot as the **first backend**, not the system substrate.
3. Prefer **native adapters** over bridge adapters whenever the target runtime exposes a machine-facing protocol.
4. Use **capability flags** instead of collapsing to the lowest common denominator.
5. Keep the app's event model stable even when a backend is replaced.
6. Target **SDK runtime-profile parity**, not full Copilot CLI parity.

The adapter goal is to replace the behavior that an app actually consumes through the SDK. It is not to clone every feature exposed by the Copilot CLI server. This distinction keeps the backend swappable without letting the CLI's full internal surface become the app architecture.

## Recommended Backend Contract

Start with the smallest contract that preserves real app behavior:

```ts
type RuntimeBackend = {
  startOrResume(input: {
    executionId: string;
    workingDirectory?: string;
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ sessionId: string; capabilities: RuntimeCapabilities }>;

  send(input: {
    sessionId: string;
    prompt: string;
    attachments?: RuntimeAttachment[];
  }): Promise<{ messageId: string }>;

  getMessages?(input: { sessionId: string }): Promise<RuntimeEvent[]>;
  disconnect(input: { sessionId: string }): Promise<void>;
  cancel?(input: { sessionId: string }): Promise<void>;
};
```

The corresponding event stream should stay small:

- `session.start`
- `session.resume`
- `user.message`
- `assistant.message`
- `session.idle`
- `session.error`
- optional: `tool.*`, `usage.*`, `plan.*`

## Backend Families

### Native backends

Use a native backend when the runtime exposes a stable RPC/API surface.

Examples:

- GitHub Copilot CLI / Copilot SDK
- Codex app-server
- Gemini CLI when used through structured output or SDK surfaces
- Opencode if a stable machine-facing protocol is available

Characteristics:

- higher fidelity
- cleaner session resume semantics
- better streaming/tool parity
- less formatting heuristics

### Bridge backends

Use a bridge backend when the runtime is valuable but only exposes a CLI/TUI or unstable protocol.

Examples:

- AgentAPI
- ad-hoc terminal automation around a CLI

Characteristics:

- lower fidelity
- fast to add many vendors
- useful as a fallback lane
- should not define the app's canonical runtime semantics

## Suggested Backend Order

For a multi-runtime app, a pragmatic rollout order is:

1. `CopilotBackend`
2. `CodexBackend`
3. `GeminiBackend` or `OpencodeBackend`
4. `AgentApiBackend` as a compatibility fallback

This order optimizes for:

- minimal initial glue
- highest control over the app contract
- future open-runtime expansion without ceding architecture ownership

## Current Status

As of `2026-06-01 14:05`, the Codex adapter has graduated from a local spike to a reusable experimental adapter boundary for the selected profile.

What is proven for `SDK Core Profile + Coding Agent Profile`:

- session creation and resume
- stateful continuation after disconnect/resume
- `session.send` and `sendAndWait()` final assistant completion
- command approval approve/deny
- file approval approve/deny
- custom SDK tool calls
- SDK tool failure and denied-result paths
- Chatpilot `/cli/chat` new-session and run-session app behavior
- Chatpilot `save_memo` / `list_memos` side effects verified through SQLite data assertions

What this means:

- Codex is still not a full Copilot CLI clone.
- Codex can replace the selected SDK-visible runtime behavior for the current Chatpilot path.
- The adapter owns Copilot-protocol compatibility and protocol-version differences.
- Chatpilot keeps route identity, memory ownership, tool registration, and app policy outside the runtime backend.

Current evidence:

- Conformance artifact index: [codex-sdk-runtime-profile/conformance-artifacts.md](./codex-sdk-runtime-profile/conformance-artifacts.md)
- Unsupported/deferred capability notes: [codex-sdk-runtime-profile/unsupported-capabilities.md](./codex-sdk-runtime-profile/unsupported-capabilities.md)
- Codex adapter production runbook: [codex-sdk-runtime-profile/production-runbook.md](./codex-sdk-runtime-profile/production-runbook.md)
- Architecture diagram: [../architecture/skyeye.html](../architecture/skyeye.html)
- Code map: [../architecture/runtime-backend-code-map.md](../architecture/runtime-backend-code-map.md)

## SDK Runtime Profile Goal

For Codex to replace Copilot for a given app path, the target is not "same CLI implementation" or "all Copilot CLI capabilities". The target is **same required SDK behavior for the selected app profile**.

Implementation and conformance testing plan: [codex-sdk-runtime-profile/plan.md](./codex-sdk-runtime-profile/plan.md).

This makes the replacement target smaller and more testable:

- If Chatpilot only uses `CopilotClient.createSession()`, `resumeSession()`, `CopilotSession.send()`, `sendAndWait()`, session events, permission handlers, and tool handlers, the adapter only needs to match that SDK profile.
- If a later app path uses `session.rpc.agent.*`, `session.rpc.skills.*`, `session.rpc.mcp.*`, session workspaces, or other escape-hatch RPCs, those become explicit capability requirements for that path.
- Full Copilot CLI parity is a non-goal unless a product path directly depends on it.

### SDK Core Profile

This is the minimum profile for a realistic runtime node:

- `ping`
- `status.get`
- `auth.getStatus`
- `models.list`
- `session.create`
- `session.resume`
- `session.getMessages`
- `session.destroy` with disconnect semantics
- `session.send`
- final assistant response
- idle transition
- error propagation
- resume after disconnect
- preserved user/assistant history
- continued multi-turn execution on the same execution identity

### Coding Agent Profile

This is the next target for a Chatpilot coding-agent runtime:

- command approval mapped through SDK permission handling
- file change approval mapped through SDK permission handling
- shell / file / MCP / custom tool permission request shape
- custom tool invocation through SDK tool handlers
- tool result delivery back to the runtime
- command execution callbacks if the app registers SDK commands

### Interactive Profile

This is required only when the app path needs user interaction during an agent turn:

- `userInput.request` compatibility for ask-user style prompts
- `elicitation.requested` / `session.ui.handlePendingElicitation`
- `capabilities.changed` updates for UI availability

### Fidelity Profile

This is user-experience and observability parity, not the first replaceability gate:

- attachments
- streaming deltas
- reasoning deltas
- usage events
- sub-agent event fidelity
- stable multi-client fan-out semantics

### Extended CLI Profile

This is explicitly optional until Chatpilot uses it:

- `session.rpc.agent.*`
- `session.rpc.skills.*`
- `session.rpc.mcp.*`
- `session.rpc.plugins.*`
- `session.rpc.extensions.*`
- `session.rpc.workspaces.*`
- `session.rpc.plan.*`
- server-scoped config discovery and management RPCs

The first two profiles are the practical replacement target for the current Codex adapter discussion. The interactive and fidelity profiles should be added when the product path requires them. The extended CLI profile should stay capability-gated and should not define the default runtime backend contract.

## Current Repository Experiments

These example scripts are the current experimental artifacts:

- `nodejs/examples/codex-app-server-smoke.ts`
- `nodejs/examples/copilot-codex-adapter-spike.ts`
- `nodejs/examples/chatpilot-runtime-acceptance.ts`

Recommended use:

- `codex-app-server-smoke.ts`: probe Codex raw behavior and auth/model state
- `copilot-codex-adapter-spike.ts`: validate the selected SDK runtime profile against baseline and adapter
- `chatpilot-runtime-acceptance.ts`: validate downstream Chatpilot app-level new-session/run-session behavior against baseline and adapter

## When to Use AgentAPI

Use AgentAPI when:

- you need broad vendor reach quickly
- a target runtime lacks a stable native protocol
- bridge fidelity is acceptable for the path being tested

Do **not** use AgentAPI as the architecture center when:

- your app needs stable session semantics
- you care about precise event/tool fidelity
- you want your app substrate to outlive current CLI/TUI shapes

## Non-Goals

This strategy does **not** attempt to:

- standardize every agent runtime behind one large universal schema
- force native and bridge backends to expose identical advanced features
- turn the app substrate into a visual workflow/glue system

The goal is to keep the app architecture clean while making runtime replacement a practical, testable engineering path.
