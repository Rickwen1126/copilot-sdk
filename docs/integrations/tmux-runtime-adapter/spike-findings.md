# Tmux Runtime Adapter — Spike Findings

Created: 2026-06-15 06:27
Last Updated: 2026-06-15 06:27
Status: Spike / Exploration

## Goal

Explore whether tmux-adapter can serve as a generic Copilot SDK runtime backend, enabling subscription-based CLI agents (Claude Code, etc.) to be programmatically controlled without API billing.

## Architecture Overview

```
Copilot SDK Client
  ↓ session.send(prompt)
TmuxCopilotAdapterServer
  ├─ INPUT:  tmux send-keys → interactive CLI session (subscription billing)
  ├─ STATE:  tmux process stat polling (R+ / S+ / absent)
  └─ OUTPUT: transcript JSONL file watching (block-level real-time)
```

## Spike #1: Transcript JSONL as Structured Event Stream

### Finding: Block-Level Real-Time Writing (confirmed)

Transcript 路徑: `~/.claude/projects/{project-path}/{session-id}.jsonl`

每個 content block 是獨立的 event，逐一即時寫入：

```
03:35:36  assistant [thinking]    ← 思考完，立刻寫入
03:35:38  assistant [text]        ← 2 秒後文字寫入
03:35:44  assistant [tool_use]    ← 6 秒後 tool call A
03:35:51  assistant [tool_use]    ← 7 秒後 tool call B
03:35:57  assistant [tool_use]    ← 6 秒後 tool call C
03:36:45  user      [tool_result] ← 48 秒後 tool A 結果
03:36:57  user      [tool_result] ← tool B 結果
03:37:31  user      [tool_result] ← tool C 結果
```

**每個 assistant event 只包含 1 個 content block**（`message.content` array length = 1）。

### Event Types (實測)

| Type | 說明 | 頻率 |
|------|------|------|
| `assistant` | AI 回應，1 block per event：thinking / text / tool_use | 高 |
| `user` | 使用者輸入 or tool_result | 高 |
| `system` | hook 執行、local commands、turn duration | 中 |
| `queue-operation` | 訊息佇列 enqueue/dequeue | 中 |
| `bridge-session` | Anthropic API session link | 每輪一次 |
| `attachment` | tool/capability registration | 每輪一次 |
| `custom-title` | session 名稱 | 每輪一次 |
| `permission-mode` | 權限模式 metadata | 每輪一次 |
| `file-history-snapshot` | 檔案變更追蹤 | 低 |
| `last-prompt` | leaf node 追蹤 | 每輪一次 |

### Event Schema

```json
{
  "type": "assistant",
  "uuid": "344b543b-...",
  "parentUuid": "63d1806d-...",
  "timestamp": "2026-06-15T03:26:42.650Z",
  "sessionId": "e40c9f95-...",
  "isSidechain": false,
  "message": {
    "role": "assistant",
    "id": "msg_01CNeU5UgjJ16Lm94St7LzSt",
    "model": "claude-opus-4-6",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_0134RL...",
        "name": "Agent",
        "input": { "subagent_type": "Explore", "prompt": "..." }
      }
    ]
  }
}
```

### 中斷行為 (confirmed)

中斷時已寫入的 blocks 不會遺失：

```json
{
  "type": "user",
  "message": { "content": [{"type": "text", "text": "[Request interrupted by user]"}] },
  "interruptedMessageId": "msg_01NpHSCwqtFtq43PFrh1vZ8W"
}
```

- 已完成的 content blocks 在中斷前就已持久化
- `interruptedMessageId` 標記被中斷的 message
- 可從 transcript 恢復中斷前的完整上下文

### Sub-agent 架構

Sub-agent 的 transcript 儲存在獨立檔案：

```
{session-id}/subagents/
  ├─ agent-{id}.jsonl      ← 完整 event 記錄
  └─ agent-{id}.meta.json  ← metadata (agentType, description, toolUseId)
```

主 transcript 的 `tool_use` event (`name: "Agent"`) 透過 `toolUseId` 連結到 sub-agent transcript。

## Spike #2: tmux 狀態偵測

### 可用的廉價信號

| Signal | Cost | 用途 |
|--------|------|------|
| `ps -t <tty>` → stat `R+/S+` | 1 syscall | 正在跑 vs 等待輸入 |
| `ps -p <pid>` → start_key | 1 syscall | process 是否重啟 |
| transcript file mtime | stat() | 有無新 event 寫入 |

tmux-adapter daemon 已有 15 秒 refresh cycle，可直接沿用。

### tmux-adapter 現有能力

- `send`: safe injection（load-buffer → paste-buffer → enter）
- `discover/bind`: process identity → pane binding
- `spawn`: policy-backed process creation
- 明確**不做** pane content scraping（design decision）

## Spike #3: Claude Code CLI 能力

### 計費模式

| 模式 | 計費 | 用途 |
|------|------|------|
| Interactive (`claude`) | **訂閱額度** | tmux adapter 走這條 ✓ |
| `claude -p --output-format stream-json` | API 用量 | 不適用 |
| `claude --headless --port N` | API 用量 | 不適用 |

### CLI 控制能力（可透過 tmux send-keys 使用）

- Session resume: `claude --resume <sessionId>` / `claude -c`
- Permission mode: `--permission-mode bypassPermissions`
- Model selection: `--model <model>`
- System prompt: `--system-prompt <text>`
- Slash commands: `/compact`, `/model`, `/clear` 等

## Fidelity 對照表

| 能力 | Codex Adapter (native) | Tmux Adapter (transcript) |
|------|:---:|:---:|
| Session create / send / destroy | 完整 | 可做 |
| Assistant message 完整內容 | 即時 streaming | block-level real-time |
| Thinking content | 即時 | block 完成時 |
| Tool call 偵測（name + args） | 即時 | block 完成時 |
| Tool result | 即時 | event 寫入時 |
| Sub-agent 追蹤 | N/A | 獨立 JSONL |
| Permission request 攔截 | 完整 | 不可能（用 bypassPermissions） |
| Token-level streaming | 有 | 無 |
| Session idle 偵測 | protocol event | tmux stat + file mtime |
| 中斷後恢復 | protocol 支援 | transcript + interruptedMessageId |
| Model selection | runtime param | CLI flag via send-keys |
| 計費 | API / Codex | **訂閱額度** |

## 待釐清項目

### Must-have（影響架構可行性）

- [ ] **Transcript file locking**: 多個 reader 同時 tail 同一個 JSONL 是否安全？Claude Code 寫入時是否有 file lock？
- [ ] **Session ID 定位**: 如何從 tmux pane 對應到正確的 transcript file？hook 帶的 `transcript_path` 是否可靠？或者要從 `~/.claude/projects/` 取最新檔案？
- [ ] **File watcher 延遲**: `fswatch` / `kqueue` / polling 在 macOS 上的實際延遲有多少？block 寫入到 watcher 收到通知的 gap？

### Should-have（影響功能完整度）

- [ ] **tool_result 與 tool_use 配對**: user event 裡的 `tool_result` 是否總是帶 `tool_use_id` 可以回溯到對應的 assistant event？
- [ ] **Sub-agent 完成偵測**: 主 transcript 是否有 event 標記 sub-agent 結束？或者要 watch sub-agent 的 JSONL？
- [ ] **Turn boundary 偵測**: 如何從 transcript 判斷「這一輪結束了，Claude 在等輸入」？`system` event 的 `stop_hook_summary` 是否可靠？
- [ ] **多 session 隔離**: 同一個 project 同時跑兩個 claude session 時 transcript 怎麼處理？

### Nice-to-have（影響使用體驗）

- [ ] **Transcript rotation**: 長時間 session 的 JSONL 檔案大小？是否有 rotation 機制？
- [ ] **Error event 格式**: Claude Code API error、rate limit 等在 transcript 怎麼表示？
- [ ] **Compact event**: `/compact` 後 transcript 有什麼特殊 event？
