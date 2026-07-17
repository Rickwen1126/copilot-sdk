# Codex Adapter v1.0.7 升級 — Topic Spec

Created: 2026-07-17
Status: Planned（調查完成，待開工）
Todo: `docs/todo.json#codex-adapter-v107`
調查紀錄: `~/code/tekric-os/docs/cockpit/spec.md` §8.7 M8（2026-07-17 嫁接面實測）

## 1. Purpose

把 fork 的 codex app-server adapter（`nodejs/src/experimental/codexAdapter*`，6 檔 2397 行）升級到官方 **v1.0.7** 基面：不壞既有功能、把事件覆蓋從窄白名單擴到可量測的覆蓋成數、採用官方新載體（metadata bag / agentId），並為 tmux-adapter 接入同一 SDK 架構鋪模板。

## 2. 現況事實（2026-07-17 調查定案）

- **分歧**：fork merge-base `a3e273c`（2026-04-21）；官方 +450 commits（v1.0.2→v1.0.7，07-16 發布）；fork +87 commits **全在 experimental/ 自有領土**，未動 index/types/session 核心檔
- **嫁接形狀**：adapter 是「**假扮 copilot CLI**」的獨立 JSON-RPC-over-TCP server——served：`ping / status.get / auth.getStatus / models.list / session.create|resume|getMessages|send|destroy|delete / session.tools.handlePendingToolCall`；emit：`session.lifecycle`＋`session.event`；發起：`permission.request`＋`tool.call`。對 SDK 的 import 僅 1 個 type（`CopilotClientOptions.cliUrl/autoStart`）
- **v1.0.7 對質**：wire 協定 version 3 未 bump；`session.event`/`session.lifecycle` 接收端健在；新增 client 呼叫（`llmInference.setProvider`、`session.eventLog.registerInterest`）皆條件式。唯一編譯斷點＝options 換形：`{cliUrl, autoStart}` → `{connection: RuntimeConnection.forTcp("host:port")}`
- **事件覆蓋現況**：codex→SDK 映射白名單僅 `item/completed(agentMessage)`→`assistant.message`、`turn/completed`→`session.idle|error`＋3 個 request（兩種 approval→`permission.request`、`item/tool/call`→`tool.call`）。codex 的 reasoning / commandExecution 輸出 / fileChange 完成 / todo / webSearch 等 item types 被 implicit-else **靜默吞掉**，無 log 無計數

## 3. 驗收條件

- **A1 相容零回歸**：upgrade branch 上既有 conformance/tests 全綠＋shinyipilot 實連走完真實對話（send → assistant.message → idle、approval 流、dynamic tool 流）
- **A2 靜默歸零**：所有 implicit-drop 改為顯式 **unmapped counter＋log**（per method / per item type）；任何未映射事件必可見——此 counter 即覆蓋成數量測器
- **A3 覆蓋成數 ≥ 90%**：判準＝codex CLI 介面上使用者可見的資訊，在 SDK event 流中可還原 ≥ 9 成（雙介面管理原則：CLI 原生介面常在旁兜底，100% 為佳非門檻）
- **A4 新載體採用**：metadata bag 掛 `tekric:*` keys 原樣往返驗證；`agentId/parentAgentId` 傳播驗證；`forInProcess` 出評估結論（做/不做＋理由）

## 4. 邊界（不做）

- fork 定版 branch `shinyipilot-codex-production-line` **不 rebase 不改寫**（歷史保護，codex adapter 消費端建立在此版之上）；升級在新 branch 進行
- 不動 upstream `docs/` 官方內容
- tmux-adapter 正式接入不在本 topic（本 topic 只交付可複用的 server/gateway 模板拆分；spike 見 plan §6）

## 5. 風險登記

- adapter 對 codex 側的假設：`experimentalApi: true`、protocol literal `2|3`（default 3）、`codex app-server` 啟動方式、CodexHome 檔案佈局、default model `"gpt-5.4"`——codex CLI 升版時任何一項變動都要 **fail loud**，不得靜默
- served RPC 方法表與 `session.event` envelope 是手寫對拍（無共用型別保證）——升級後以 conformance 實連驗證，不以編譯通過為準
