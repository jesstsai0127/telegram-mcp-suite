# lessons-learned.md — 踩坑教訓累積

> 只 append，不修改。開發或測試中發現「這裡下次可以做更好」就立刻記一條，不用等真的踩雷。
> 累積到一定量或一個開發階段結束時，由 Claude Code 主動評估是否精簡進本專案（或全域）的 CLAUDE.md。
> 測試環境（worktree）跟正式分支共用同一份檔案，不另外開一份。

---

## 格式

```
## YYYY-MM-DD — {問題簡述}
**類型**：技術 / 架構 / 協作 / 溝通
**情境**：
**錯誤做法**：
**正確做法**：
**預防方式**：
```

---

## 2026-07-16 — 主機沒有 IPv6，Node 的 Happy Eyeballs 讓 IPv4 連線也跟著卡死逾時

**類型**：技術
**情境**：tg-bridge 反覆出現 `[heartbeat] 連不到 Telegram（EFATAL: fetch failed）`，每隔幾十分鐘到幾小時就連續失敗兩次、自我判定壞掉、觸發 `process.exit(1)` 讓 systemd 重啟一次，長期被當成「暫時性網路問題」擱置（最早在更早的 session 就診斷過 `ETIMEDOUT`/`ENETUNREACH` 症狀，但沒找到根因就先擱置了）。實測發現：直接 `net.connect({host: '149.154.166.110', port: 443, family: 4})` 236ms 就連上，但 `fetch('https://api.telegram.org/')` 對同一個 IP 卻逾時失敗。
**錯誤做法**：把反覆出現的 `fetch failed` 當成「Telegram 那邊網路不穩，重啟就好」，沒有深入比較「為什麼直連同一個 IP 沒事，但 fetch 會逾時」這個矛盾現象——兩者行為不一致本身就是關鍵線索，只看錯誤訊息字面（ETIMEDOUT/ENETUNREACH）容易誤判成單純的目標網站不穩定。
**正確做法**：這台主機完全沒有 IPv6 路由（`curl -6` 直接失敗），但 Node 18+ 預設開啟 `autoSelectFamily`（Happy Eyeballs，RFC 8305），DNS 查到 A+AAAA 兩筆記錄後會同時嘗試連線；IPv6 那條路因為完全不可達（`ENETUNREACH`），這個機制的行為會連帶拖累原本很快就能連上的 IPv4 那條路一起逾時失敗。加上 `Environment=NODE_OPTIONS=--no-network-family-autoselection`（systemd unit 層級，不用改應用程式碼）關掉這個機制、強制走傳統循序連線，問題消失。
**預防方式**：遇到「同一個目的地，工具A（curl）正常、工具B（Node fetch）異常」這種行為不一致的網路錯誤，優先懷疑是客戶端連線策略（dual-stack racing、DNS 解析順序、TLS 協商差異）的差異，而不是目的地本身不穩定；用最底層的 API（例如直接 `net.connect` 指定 IP + `family`）隔離變因，比只看錯誤訊息字面更快找到根因。IPv6 完全不可達（不是慢，是路由不存在）的主機，跑 Node 18+ 的網路服務時，應該預設就加上這個 flag，不用等問題發生才補。
