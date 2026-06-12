# ShinyiPilot Python App + Node Codex Adapter Spike

Created: 2026-06-12 15:00
Last Updated: 2026-06-12 15:00
Status: Spike evidence and deployment notes

This document records the current ShinyiPilot integration spike where a Python
application uses the local Python Copilot SDK source and connects to the
experimental Node.js Codex adapter as an external Copilot-protocol runtime.

## Commit Context

Downstream ShinyiPilot spike worktree:

```text
repo: /Users/rickwen/code/copilot-sdk/shinyipilot-spike
branch: codex-adapter-spike-20260612
commit: 148ba1097aaf371c5ff7aa23a9d98a0d5c7797df spike: connect shinyipilot to local codex adapter
```

That ShinyiPilot commit:

- points `github-copilot-sdk` at the local editable source `../python`;
- adds a `CHATPILOT_RUNTIME_BACKEND=codex-adapter` transport seam;
- connects Python `SdkClient` to `ExternalServerConfig(url=...)` when
  `CHATPILOT_COPILOT_CLI_URL` is set;
- updates `create_session`, `resume_session`, and `send_and_wait` calls to the
  local Python SDK source API;
- changes local CLI/E2E defaults away from live `2999` to `29999`;
- adds unit coverage for the external Copilot protocol URL and missing-adapter
  guard.

Copilot SDK source compatibility changes in this repo:

- `python/copilot/types.py` re-exports tool dataclasses from `copilot.tools` for
  downstream apps that import `copilot.types`.
- `python/copilot/__init__.py` re-exports `PermissionHandler` from
  `copilot.session`.

Those compatibility shims preserve package-era downstream import surfaces while
allowing ShinyiPilot to use the local SDK source tree directly.

## Runtime Shape

The integration boundary is the Copilot protocol over TCP, not a language-level
import.

```text
ShinyiPilot Python app
  -> Python github-copilot-sdk source
  -> TCP cli_url 127.0.0.1:4873
  -> Node Codex adapter server
  -> codex app-server
```

The Node adapter should be treated as a runtime sidecar or sibling service for
ShinyiPilot. ShinyiPilot should not import adapter internals.

## Local Spike Configuration

Adapter process:

```sh
CODEX_ADAPTER_PORT=4873
CODEX_ADAPTER_PROTOCOL_VERSION=2
CODEX_ADAPTER_CODEX_HOME="$HOME/.codex"
CODEX_ADAPTER_ISOLATE_CODEX_HOME=false
CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH=/tmp/shinyipilot-codex-adapter-runtime-sessions.json
CODEX_ADAPTER_SUMMARY_PATH=/tmp/shinyipilot-codex-adapter-summary.json
CODEX_ADAPTER_APPROVAL_POLICY=never
CODEX_ADAPTER_SANDBOX_MODE=readOnly
CODEX_ADAPTER_NETWORK_ACCESS=false
CODEX_ADAPTER_MODEL=gpt-5.4
```

ShinyiPilot process:

```sh
PORT=29999
CHATPILOT_RUNTIME_BACKEND=codex-adapter
CHATPILOT_COPILOT_CLI_URL=127.0.0.1:4873
CHATPILOT_DB=/tmp/shinyipilot-spike-chatpilot.db
CHATPILOT_TASK_DB=/tmp/shinyipilot-spike-tasks.db
CHATPILOT_FILES_DB=/tmp/shinyipilot-spike-files.db
CHATPILOT_FILE_ASSETS_DIR=/tmp/shinyipilot-spike-assets
```

The local ignored ShinyiPilot config used for the proof sets copied chatbot
models to `gpt-5.4`. The LINE lane is intentionally not configured in this
spike; startup logs should show missing LINE env vars being skipped.

## Live Proof

Service sessions during the spike:

```text
tmux shinyipilot-codex-adapter-4873 -> 127.0.0.1:4873
tmux shinyipilot-spike-29999       -> 127.0.0.1:29999
```

Health proof:

```sh
curl -s http://127.0.0.1:29999/health
```

Expected result includes:

```json
{"status":"ok","version":"0.2.0"}
```

CLI proof:

```sh
uv run chatpilot-cli --url http://127.0.0.1:29999 \
  chat '請只回覆：codex adapter ok' \
  --user codex-spike-cli-detached
```

Observed result:

```text
codex adapter ok
```

Relevant ShinyiPilot log evidence:

```text
Copilot SDK client started backend=codex-adapter options={'cli_url': '127.0.0.1:4873'}
Session setup ... model=gpt-5.4 ...
assistant: codex adapter ok
POST /cli/chat HTTP/1.1" 200 OK
```

## Deployment Notes

The language split is acceptable because the adapter is an external protocol
server. The deployment contract is the important boundary.

- Start order: the Node adapter must be listening before the ShinyiPilot Python
  app starts its SDK client.
- Readiness: ShinyiPilot startup proves adapter reachability when
  `SdkClient.start()` succeeds, but the adapter still needs an explicit
  production health/readiness story.
- Process ownership: run the adapter as a sidecar or sibling service with its
  own logs, restart policy, and stable environment.
- Auth: `CODEX_ADAPTER_CODEX_HOME` must point at a Codex home that has already
  completed `codex login`.
- Resume: production resume needs a durable
  `CODEX_ADAPTER_RUNTIME_SESSION_STORE_PATH`, a stable Codex home, and stable
  per-session workspaces.
- Security lane: keep the ShinyiPilot chatbot profile locked to
  `approval=never`, `sandbox=readOnly`, and `network=false` unless a separate
  product path explicitly proves a broader coding-agent profile.
- Ports: local spike uses app `29999` and adapter `4873`. Do not touch live
  `2999` during isolated testing, and do not use reserved `4800`, `4801`, or
  `4811`.
- Secrets: do not copy live `.env`, DB files, LINE data, file assets, logs, or
  `.progress` into the spike. Keep local config example-derived unless a test
  explicitly requires a real credential.
- Logs: production debugging requires both ShinyiPilot app logs and adapter
  logs. A `200` from `/cli/chat` is not enough; check the ShinyiPilot SDK log
  for `backend=codex-adapter` and the adapter transcript/summary for the
  corresponding session.
- Version contract: Python SDK source, Node adapter protocol version, and
  ShinyiPilot wrapper API shape must be tested together. The spike found and
  fixed package-vs-source differences in `copilot.types`, `PermissionHandler`,
  `create_session`, `resume_session`, and `send_and_wait`.

## Follow-Up

- Add a repeatable ShinyiPilot CLI smoke script for the adapter-backed lane.
- Decide whether the Python SDK compatibility shims are stable public
  compatibility or spike-only backfills.
- Decide whether a future Python-native adapter port is worth building after
  the sidecar deployment contract is stable.
