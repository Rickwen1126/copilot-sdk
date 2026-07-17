# Codex Adapter v1.0.7 升級 — Plan

Created: 2026-07-17
Spec: `docs/codex-adapter-v107/spec.md`

## 勾稽狀態（2026-07-17，branch codex-adapter-v107）

| Phase | 狀態 | 備註 |
|---|---|---|
| Phase 0 基線 | ✅ 完成 | 快照匯入（非 87 cherry-pick，provenance @3058231）；options 修正為 **forUri**（forTcp 是 spawn 語意，plan 原文有誤）；另修 getMessages→getEvents drift；build/typecheck/codex 測試綠 |
| Phase 1 相容（A1） | ✅ 除 shinyipilot 實連 | wire 檢查表完成；**permission.request/tool.call 直接 request 流在 v1.0.7 已移除**→Phase 1.5 修復（permission.requested event + handlePendingPermissionRequest；v2 legacy 拒起 fail-loud）；真 codex smoke 綠。**shinyipilot 實連待 Rick 在場驗收** |
| Phase 2 可觀測（A2） | ✅ 完成 | unmapped counter（method×itemType）＋deliberate 分帳＋status.get/summary/destroy-stop summary 出口；unserved request 回 -32601 |
| Phase 3 映射（A3） | ✅ 完成 | delta/message_start/reasoning/turn_start/commandExecution/fileChange(+workspace_file_changed)/usage 全部映射；兩種真 codex turn 實測 unmapped=0（覆蓋 100%，deliberate 清單制排除）。未演練 item 類（webSearch/todoList/MCP）由 counter 兜底 |
| Phase 4 新載體（A4） | ✅ 完成 | tool metadata bag 往返（store 持久化＋summary().sessions 出口＋restart-resume 測試）；agentId/parentAgentId 調查結論=adapter 無接觸點（見下）；forInProcess 評估=不做（`forinprocess-assessment.md`）；reasoning extraction-miss fail-loud 防護 |
| Phase 5 tmux spike | ⬜ 未開始 | 不在本輪範圍（§6） |

Follow-ups：shinyipilot 實連全流程（Rick 驗收站）；per-session 覆蓋分子分母；未演練 codex item 類的映射迭代；`turn/diff/updated` deliberate 分類可由統籌推翻改映射。

agentId/parentAgentId 結論：v1.0.7 中兩欄位活在 (a) `llmInference.httpRequestStart` frames（僅當 consumer 配置 requestHandler、由**真 runtime** 發起模型呼叫時才存在——codex 的模型呼叫在 codex 內部，不經 SDK，adapter 永不發此 frame）與 (b) session event envelope 的 optional `agentId`（sub-agent 標注；codex app-server payload 實測無 agent 識別欄位，無來源資料可填；absent=root-agent 正是 schema 語意，現狀已正確）。故無最小實作可做，不硬做。

## 1. Phase 0 — 基線（半天）

- 自官方 v1.0.7 起 branch `codex-adapter-v107`，cherry-pick / rebase fork 的 experimental/ 87 commits（衝突面已證為零；只需處理編譯級 drift）
- options 工廠單點修：`createCodexCopilotClientOptions()` 改回傳 `{connection: RuntimeConnection.forTcp(host:port)}`
- `npm build` 過＋既有單元測試過

## 2. Phase 1 — 相容驗證（A1）

- wire 檢查表逐項實連：session.create/resume/send/destroy、session.event/lifecycle 收發、permission.request 雙 approval 流、tool.call 動態工具流
- 兩個條件式新方法：consumer 不配 requestHandler/onMcpAuthRequest 時確認不觸發；配了時 stub 回應或驗證 method-not-found 容忍度
- shinyipilot 實連全流程綠 → 相容步收案

## 3. Phase 2 — 可觀測化（A2，先於任何映射擴充）

- `handleCodexNotification`/`handleCodexRequest` 的 implicit-else 全部改為：unmapped counter（per method × per item type）＋結構化 log
- counter 輸出成 summary（session 收尾印一次＋可查詢）——**這就是覆蓋成數的分母/分子量測器**，先量基線再動手

## 4. Phase 3 — 映射擴充（A3）

優先序（按 CLI 畫面資訊量）：
1. `commandExecution` 輸出（指令＋stdout/stderr → 對映 v1.0.7 session-events 的 tool/command 事件族）
2. `reasoning`（思考塊 → reasoning 事件族）
3. `fileChange` 完成事件（diff/路徑 → file-change 事件族）
4. `todo` / `webSearch` / 其餘 item types
- 每擴一類：加 conformance case＋覆蓋成數重量測；成數曲線記進 evidence

## 5. Phase 4 — 新載體採用（A4）

- metadata bag：session create/resume 掛 `tekric:topic`、`tekric:window` 往返驗證
- `agentId/parentAgentId`：統籌歸因鏈實測（parent 指向 orchestra 的場景）
- `forInProcess` 評估：hub（viewer backend）嵌入 runtime 的收益 vs 實驗性風險，出結論即可，不強制採用

## 6. tmux-adapter Spike 建議（整合做法）

**核心概念移植**：codex adapter 證明了一個通用模板——「假扮 copilot CLI 的 standalone server」。tmux adapter 走同一個模板，只換 gateway 層：

```
CopilotClient ← RuntimeConnection.forTcp ← TmuxCopilotAdapterServer（複用 codexAdapter server 骨架）
                                              └─ TmuxGateway（取代 codexAppServerGateway）
                                                   INPUT : tmux send-keys（控制面）
                                                   STATE : tmux poll ＋ harness hooks
                                                   OUTPUT: session file parser（claude jsonl / codex session file）
```

**語言/落點決策（建議 a）**：
- (a) **在 nodejs experimental/ 起 `tmuxAdapter*.ts`**，抽出 codexAdapter 的 server骨架＋sessionStore 共用、gateway 介面化——與 SDK 同語言、同 repo、同測試設施，codex/tmux 兩個 adapter 共演化
- (b) 擴 Python `~/code/tmux-adapter`（tmux-adapterd）再橋 IPC——多一層跨語言邊界，event 對拍面加倍，不建議為 SDK 接入走這條
- Python tmux-adapter 的資產以**概念移植**方式吸收：provider-neutral registry、codex hook provider 的 hook 語意、delivery ledger 的投遞保證——不直接串 process

**Spike 最小驗證（一輪對話閉環）**：
1. claude CLI 跑在 tmux window（訂閱計費 interactive，非 headless）
2. parser tail 該 session 的 jsonl → 經 TmuxGateway 轉 SDK `session.event`（至少 assistant.message＋session.idle）
3. SDK client `session.send()` → send-keys 注入同一 window
4. 驗收：完整一問一答經 SDK client 可見、可注入，CLI 側原生介面同時無感照常
- 前置小 spike（tekric-os M8 已排）：sdk 外部生命週期騷操作、pid→lsof 身分證、parser fail-loud

## 7. 風險與回退

- 全程 fork 定版不動：升級失敗即棄 branch，零損失
- codex CLI 版本假設變動（experimentalApi/protocol literal）→ fail loud 原則，Phase 1 檢查表納入
- 覆蓋成數卡在 <90%：先收 A1/A2（相容＋可觀測），A3 拆後續迭代，不 all-or-nothing
