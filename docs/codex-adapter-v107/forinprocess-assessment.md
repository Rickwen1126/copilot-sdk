# forInProcess 評估（Phase 4 / A4）

Date: 2026-07-17
評估對象: v1.0.7 `RuntimeConnection.forInProcess()`（FFI in-process transport）
Sources: `nodejs/src/ffiRuntimeHost.ts`、`nodejs/src/types.ts:131-149,223-234`、client.ts in-process 分支、upstream issue #1934

## 結論：**不做**（本 topic 範圍內），條件性再看

## 它是什麼

`forInProcess` 把 **copilot runtime** 以 native cdylib（`runtime.node`）載入宿主 Node process，
JSON-RPC 走 C ABI（koffi FFI）而非 stdio/TCP；CLI worker 由 native `host_start` 自行 spawn。
是 transport swap，不是新協定（LSP framing 不變）。

## 為什麼與 codex adapter 無交集

codex adapter 的形狀是「**假扮 copilot runtime** 的 standalone TCP server」——它站在
runtime 的位置，client 用 `forUri` 連它。`forInProcess` 解決的是相反方向的問題：
「把**真的** copilot runtime 嵌進宿主」。兩者服務的是不同 runtime：

- adapter 路線：SDK client → (forUri/TCP) → codex adapter → codex app-server
- forInProcess 路線：SDK client → (FFI) → **copilot** runtime → copilot CLI worker

codex adapter 沒有 cdylib 形態，也不需要：它本來就跑在宿主可控的 Node process 裡。
若想把 adapter「嵌入」hub（viewer backend），直接 `new CodexCopilotAdapterServer()`
in-process 即可——它是普通 TS class，比 FFI 模式更嵌入。

## hub 嵌入真 copilot runtime 的收益 vs 風險（若未來 hub 也要跑 copilot 本體）

收益：省一個 child process、省 TCP/stdio hop、單一 process 生命週期管理。
風險（全部來自 source 事實）：
- `@experimental`，行為明言可變（types.ts:137-145）
- **env 隔離喪失**：`env`/`telemetry`/`gitHubToken`/`baseDirectory` 全部不生效，
  worker 繼承宿主 ambient environment（issue #1934）——hub 是常駐多工 process，
  ambient env 污染面大，這條几乎是否決性的
- 每 process 只能載一份 cdylib（`loadLibrary`: 換 path 直接 throw）——hub 想同時
  跑多版 runtime 不可能
- keep-alive timer 掛住 event loop（ffiRuntimeHost.ts KEEP_ALIVE_INTERVAL_MS），
  生命週期與宿主纏繞

## 與 forUri 外接 adapter 模式的相容性

無衝突：`connection` 是 per-client 選項，同一宿主可以一個 client `forInProcess`
連 copilot、另一個 client `forUri` 連 codex adapter。互不干擾。

## 何時再看

1. hub 確定要常駐嵌入**copilot 本體**（不是 codex）且 process 數成為實際瓶頸時
2. upstream 把 in-process 的 env 隔離修好（#1934 關閉）並移除 @experimental 標記時
兩條件都不成立前，維持 forUri 外接模式。
