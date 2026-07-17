# Codex Adapter 維運 Spec（fork 專屬）

Created: 2026-07-18
Scope: 本 fork（Rickwen1126/copilot-sdk）的 codex adapter 架構、branch 佈局、部署鏈、升級 SOP、shinyipilot 注意事項
Topic docs: `docs/codex-adapter-v107/`（v1.0.7 升級案的 spec/plan/評估）

## 1. 架構一頁

**Adapter 模式**：「假扮 copilot CLI」的 standalone server——對 SDK client 開口（served: ping/status.get/auth.getStatus/models.list/session.\*），背後經 gateway 驅動 `codex app-server`。SDK 對 adapter 零特殊知識，`RuntimeConnection.forUri(host:port)` 接上即用。

**雙側 adapter，職責不同**：

| 側 | 位置 | 角色 |
|---|---|---|
| **Python** | `python/copilot/codex_adapter/`（cli/gateway/mappers） | **生產側**——shinyipilot 後端（Python）實際消費的就是它 |
| **Node.js** | `nodejs/src/experimental/codexAdapter*` | 開發/驗證側＋未來 tekric hub（TS）的基座；conformance parity snapshot 與 python 側對拍 |

兩側必須保持 parity（`nodejs/conformance/codexAdapterParitySnapshot.ts`）。**升級任一側時，另一側是待辦不是可選**。

## 2. Branch 佈局（2026-07-18 起）

| branch | 定位 | 規則 |
|---|---|---|
| `shinyipilot-codex-production-line` | **定版線**＝部署 pin 的來源、docs 主線 | 不 rebase 不改寫；新工作不直接堆在上面 |
| `codex-adapter-v107` | nodejs 側 v1.0.7 升級線（official v1.0.7 tag + 12 commits） | 獨立 ref；python 側補齊＋驗收過後裁決升格 |
| `main` | 鏡像官方 main | 定期 `git push origin upstream/main:main`（**只允許 ff**） |
| 其餘 ~85 條 | fork 自帶的官方作者分支 | 不理不動 |

## 3. 部署鏈真相（shinyipilot）

部署**不追 branch tip**，走 pin 檔：

```
shinyipilot/config/deploy/copilot-sdk-pin.json
  { repo: fork url, rev: <exact commit>, python_subdir: "python",
    required_paths: [python/copilot, python/copilot/codex_adapter, python/pyproject.toml] }
→ docker（codex-line / e2e）COPY copilot-sdk → 驗 required_paths → 裝 python 套件
```

- 現行 pin：`f5c8771c`（定版線 pre-docs head）
- **推論兩則**：① 定版線上繼續 commit（docs 等）**不影響部署**——pin 不動就什麼都不動；② 升級部署＝改 pin rev 一次到位，回滾＝改回舊 rev。pin 檔是部署的單一扳機
- ⚠️ **pin 指向的 rev 必須含 required_paths**——`codex-adapter-v107` 目前**沒有 python 側**，pin 過去會直接 fail（這是保護不是缺陷）

## 4. v1.0.7 升級怎麼做的（nodejs 側，已完成——SOP 的實例）

worktree `codex-adapter-v107` 自官方 v1.0.7 tag 起 branch，五個 Phase（詳見 `docs/codex-adapter-v107/plan.md` 勾稽表）：

1. **Phase 0 基線**：`git checkout <定版線> -- nodejs/src/experimental`（squash 匯入帶 provenance）→ 修編譯（`{cliUrl,autoStart}` → `RuntimeConnection.forUri`；`getMessages→getEvents`）→ build 綠
2. **Phase 1 相容**：wire 檢查表逐項對拍 client.ts（發現 permission 流已斷）
3. **Phase 1.5 修復**：permission 改 `permission.requested` event＋serve `handlePendingPermissionRequest`；protocol 2 啟動即拒（fail loud）
4. **Phase 2 可觀測**：unmapped counter（per method×itemType）＋deliberate 清單制——先量再擴
5. **Phase 3-4 擴充採用**：9 個新 mapper（delta/reasoning/工具族/usage）、覆蓋 100%（已觀測類）、metadata bag 往返、`-32601`、extraction-miss 防護。96/96 tests

## 5. 定期升級 SOP（下次照抄）

1. `git fetch upstream --tags`；挑目標 tag → `git worktree add ../copilot-sdk-vNNN -b codex-adapter-vNNN <tag>`（**定版線永不動**）
2. 匯入自有領土：`git checkout <定版線> -- nodejs/src/experimental nodejs/conformance nodejs/test/codex-* nodejs/examples python/copilot/codex_adapter`＋package.json 加法手動 port
3. **編譯斷點檢查表**（本次實證的高風險面）：client options 形狀、`RuntimeConnection` 工廠、session 方法改名、`sdk-protocol-version.json` 是否 bump
4. **Wire 對拍檢查表**：served 方法表 vs client 呼叫、`session.event`/`session.lifecycle` envelope、permission/tool 投遞機制（本次就是這裡斷的）、新增 client 呼叫是否條件式
5. 跑 unmapped counter 基線（真 codex 兩種 turn：純對話＋工具觸發）→ 有新 unmapped kind 就擴映射，目標覆蓋 ≥9 成
6. 測試全綠 → push 獨立 branch → shinyipilot 實連 7 場景驗收 → 改 pin rev 切換部署 → 穩定後裁決升格定版線
7. 順手：`git push origin upstream/main:main`（ff）讓 main 跟上

## 6. shinyipilot 側注意事項

- **升級部署前提**：python 側 adapter 同步升級並匯入目標 branch（required_paths 檢查會擋沒帶 python 的 rev）；nodejs↔python parity snapshot 過
- **7 項實連驗收場景**（詳見 codex-adapter-v107 topic Phase 4 回報）：approval 允許／拒絕、streaming 打字機流、reasoning 帶內容（觀察 `extraction-miss`）、工具事件、metadata 往返、收尾查 `unmappedEvents`＋`deliberatelyUnmapped`
- **Streaming 接回**：producer 已完整（typed `assistant.message_delta` 帶 messageId）；chat UI 需 **reduce-by-itemId** 摺疊器（delta 折進同氣泡、completed 封頂）＋reasoning/message 按 event type 分流——當年「散亂訊息」事故是 consumer 聚合缺陷，不要再用餓死管線來治
- **不需要串流就不訂閱**：事件是 opt-in，consumer 忽略 delta 型 event 即回到現行為
- **codex CLI 版本假設**：`experimentalApi:true`、`codex app-server` 啟動方式、CodexHome 佈局——codex 升版時 adapter 的 fail-loud 會擋，遇到啟動失敗先查這裡

## 7. 已知 gap（下一包）

- **python 側 v1.0.7 升級未做**：`python/copilot/codex_adapter` 仍在定版線基面；需照 nodejs 側同款流程升級＋parity 對拍後，`codex-adapter-v107` 才具備部署資格
- per-session 覆蓋分子分母、tmux-adapter spike（topic plan §6）——後續 topic
