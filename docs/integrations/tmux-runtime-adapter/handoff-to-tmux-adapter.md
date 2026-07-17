# Handoff: File-Based Event Ingestion for tmux-adapter

Created: 2026-06-16 04:51
Source: copilot-sdk spike session (2026-06-15)
Target repo: ~/code/tmux-adapter

---

## Context

在 copilot-sdk 那邊做了一輪 spike，目標是探索用 tmux-adapter 作為 Copilot SDK 的 generic runtime backend。結論是：要讓 SDK 能消費 tmux-adapter 的 events，tmux-adapter 自己要先能從 CLI agent 的 transcript file 取得結構化事件。這是 tmux-adapter 內部的 event source 層問題，不是 SDK 的問題。

目前 tmux-adapter 的 event 來源只有 hook-based（Codex provider 的 SessionStart/Stop hook → emit normalized events）。這次要加的是 file-based event ingestion — 主動 watch agent 的 transcript JSONL，從裡面提取 block-level events。

Claude Code 之前沒有認真整合進 tmux-adapter，因為 Claude 自己的 mobile remote 做得很好，沒有迫切需求。現在需求變了：要讓 Claude Code 能接進 Copilot SDK 的 runtime adapter 架構，而且必須走訂閱計費（interactive CLI），不能走 API 計費（`-p` / `--headless`）。

## 核心發現（copilot-sdk spike 已驗證）

### Claude Code transcript JSONL 是 block-level real-time

路徑: `~/.claude/projects/{project-path}/{session-id}.jsonl`

**每個 content block 是獨立的 event，逐一即時寫入（已實測確認）：**

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

- 每個 assistant event 只有 1 個 content block（`message.content` length = 1）
- 比 stop hook 細非常多 — stop hook 一整輪才一次，transcript 每個 block 就一次
- 中斷不丟資料 — 已寫入的 blocks 都已持久化，中斷事件帶 `interruptedMessageId`
- Sub-agent 的 transcript 在 `{session-id}/subagents/agent-{id}.jsonl`

### 這比 hook-based 路線好在哪

| | Hook-based (現在) | File-based (目標) |
|---|---|---|
| 顆粒度 | turn-level（Stop hook 才觸發） | block-level（每個 thinking/text/tool_use） |
| 即時性 | turn 結束後 | block 完成時 |
| 資料完整度 | 只有 `last_assistant_message` | 完整 message 含 tool args、thinking、model |
| 中斷恢復 | 無 | transcript 有完整記錄 |
| 跨 agent 一致性 | 每個 agent 要寫專用 provider hook | 讀 transcript 的邏輯可以通用化 |

### 計費差異（Claude Code 限定）

| 模式 | 計費 |
|------|------|
| Interactive (`claude`) | **訂閱額度** ← tmux adapter 走這條 |
| `claude -p` / `--headless` | API 用量計費 |

tmux `send-keys` 注入到 interactive session = 跟人手打一樣 = 訂閱計費不變。

## 這次要做的事

### Phase 1: Claude transcript file watcher spike

驗證 file-based event ingestion 的可行性，用 Claude Code 的 transcript 做 POC。

**Must-have spike 項目：**

1. **Session ID → transcript file 定位**
   - Claude SessionStart hook 帶 `transcript_path`，這是否是最可靠的 source？
   - 或者從 `~/.claude/projects/` 掃最新 `.jsonl`？
   - 從 tmux pane → process → cwd → project path 的推導鏈是否可行？

2. **Turn boundary 偵測**
   - 怎麼從 transcript 知道「Claude 在等輸入了」？
   - `system` event 的 `stop_hook_summary` subtype 是否是可靠的 turn-end marker？
   - 或者要結合 tmux process stat（`S+` = idle）？

3. **File watcher 機制**
   - macOS 上 `kqueue` / `fswatch` / polling 的實際延遲
   - 多 reader 同時 tail 同一個 JSONL 是否安全（Claude Code 寫入有無 file lock）
   - line-buffered append 還是 batch flush？（spike 結果暗示是 line-buffered）

4. **Codex transcript 格式對比**
   - Codex 是否也有類似的 transcript JSONL？路徑在哪？
   - 格式跟 Claude Code 的是否一致或可統一？
   - 如果 Codex transcript 也可用，file watcher 可以同時服務兩種 agent

### Phase 2: Claude provider adapter

基於 spike 結果，實作 Claude provider adapter（類似現有的 Codex provider）。

- SessionStart hook → 拿到 `transcript_path` → 啟動 file watcher
- File watcher 讀到 assistant event → 正規化為 `agent.output` event → emit 到 daemon
- File watcher 讀到 system `stop_hook_summary` → 正規化為 `agent.lifecycle.stop`
- Turn boundary → 結合 transcript + tmux stat 判斷
- 中斷事件 (`interruptedMessageId`) → 正規化為 `agent.lifecycle.stop` + 保留恢復資訊

### Phase 3: Generic file-based event source（可選）

如果 Codex transcript 也可用，把 file watcher 抽成 generic event source：
- 統一的 transcript parser interface
- Claude parser / Codex parser 各自實作
- daemon 根據 tool type 選擇對應的 parser

這讓 Codex 那邊也能在保留 CLI 介面的同時，透過 Telegram 等外部介面互動。

## Event schema 速查（Claude Code transcript）

```json
// Assistant event（1 block per event）
{
  "type": "assistant",
  "uuid": "...",
  "parentUuid": "...",
  "timestamp": "2026-06-15T03:26:42.650Z",
  "sessionId": "e40c9f95-...",
  "isSidechain": false,
  "message": {
    "role": "assistant",
    "id": "msg_01...",
    "model": "claude-opus-4-6",
    "content": [
      {"type": "tool_use", "id": "toolu_01...", "name": "Bash", "input": {"command": "ls"}}
    ]
  }
}

// User event - tool result
{
  "type": "user",
  "timestamp": "...",
  "message": {
    "role": "user",
    "content": [
      {"type": "tool_result", "tool_use_id": "toolu_01...", "content": [...]}
    ]
  }
}

// User event - interruption
{
  "type": "user",
  "timestamp": "...",
  "interruptedMessageId": "msg_01...",
  "message": {
    "content": [{"type": "text", "text": "[Request interrupted by user]"}]
  }
}

// System event - turn end marker
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "timestamp": "...",
  "hookCount": 1,
  "hookInfos": [{"command": "~/.claude/hooks/notify-done.sh", "durationMs": 1550}]
}
```

## 完整 spike findings

詳細資料在 copilot-sdk repo：
`~/code/copilot-sdk/docs/integrations/tmux-runtime-adapter/spike-findings.md`

## 做完後回 copilot-sdk 要接的東西

tmux-adapter 的 file-based event ingestion 做好後，copilot-sdk 這邊要做的是：
- `TmuxCopilotAdapterServer` — 消費 tmux-adapter daemon 的 normalized events
- 翻譯成 Copilot SDK protocol（session.create/send/getMessages/destroy）
- 跟現有 Codex adapter 對稱的架構（Gateway → Mapper → Session Store）
