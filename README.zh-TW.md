# AXIS — Telegram 個人助理

透過 Telegram bot 直接打字記錄待辦、購物清單、點子，或查詢清單/專案進度；資料存在 Notion，AI 只在意圖分類、Web Search 摘要、風格回饋這幾個節點被呼叫，其餘流程（新增、查詢、排程推播、到期提醒）都是固定邏輯，不靠 AI 臨場判斷。

[English version: README.md](README.md)

## 功能

- **自然語言記錄/查詢**：「想到一個點子：用 AI 整理筆記」「待辦：明天下午開會」「要買衛生紙」「今天有什麼待辦？」，本地 Ollama 做意圖分類
- **待辦 / 待買清單**：一次性到期提醒、週期性規則（`rrule`），Telegram WebApp 表單新增/編輯，清單頁可連續新增、點列表可直接標記完成
- **每日回顧推播**：固定模板（完成/未完成/已逾期/明天預計），不用 AI 生成，排版穩定可控
- **Web Search**：DuckDuckGo 搜尋 + AI 摘要 + 快取（7 天內同問題不重複查）
- **Persona 風格回饋**：使用者對回應風格的意見會被解析成規則寫入 `persona.md`，之後的回應據此調整
- **健康/飲食/運動紀錄**、**財務淨值查詢**（串接 finance-tracker）
- **n8n 作為流程控制層**：規律性的路由/排程用 n8n 節點明確定義，AI 只在需要語意理解的節點被呼叫，不是分類完就讓程式碼自動決定整條路徑

## 架構

```
Telegram 訊息 → tg-bridge (server.js) ──唯一持有 Telegram 連線──
                                    │
                                    ▼ webhook 轉發
                              n8n（路由/排程）
                                    │
                                    ▼ HTTP
                        tg-bridge Skill Interface (/skill, /classify, /actions/*)
                                    │
                        ┌───────────┼───────────┐
                        ▼           ▼           ▼
                    Ollama      Notion      AI Gateway
                  （意圖分類）  （資料存取）  （摘要/風格解析，Gemini/Groq 等免費額度輪替）
```

- **Notion**：唯一的資料存放處（Tasks / Shopping / Ideas / Projects / Search Cache / Health / Diet / Activity），本地有 cache-aside 層（`lib/notion-cache.js`，SQLite）減少 API 呼叫，write-through 確保自己寫入後立刻讀得到最新值
- **AI 分層**：Level 1 本地 Ollama（意圖分類）→ Level 2 免費雲端 API 輪替（摘要、風格解析）→ Level 3 Claude API（僅明確指定才觸發，不自動升級）
- **Telegram WebApp**：新增/編輯表單改用結構化欄位（日期選擇器、勾選框），不靠 AI 解析自由文字算相對日期，避免「週四」「明天」這類相對時間算錯的問題

## 安裝

需求：Node.js 22+（用到內建的 `node:sqlite`）、Ollama（本地跑意圖分類）、Notion 帳號、Telegram bot token。

```bash
cd tg-bridge
npm install
cp .env.example .env
```

依 `.env.example` 裡的說明填入：

| 變數 | 說明 |
|---|---|
| `TELEGRAM_ASSISTANT_BOT_TOKEN` | 從 [@BotFather](https://t.me/BotFather) 建立 bot 拿到的 token |
| `NOTION_API_KEY` | Notion internal integration token，建立後記得把要用的頁面分享給這個 integration |
| `OLLAMA_HOST` / `OLLAMA_INTENT_MODEL` | 本地 Ollama 位址跟意圖分類用的模型 |
| `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` | Level 2 AI（摘要/風格解析）用，可以是自架的 [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) 或相容的 OpenAI-style endpoint |

其餘變數（n8n webhook、finance-tracker 整合、port、時區）都是選填，留空會停用對應功能，不影響核心的記錄/查詢。

**已知的粗糙之處**：`server.js` 跟下面兩支欄位遷移腳本讀環境變數是透過 `ENV_PATH`（預設 `~/.secrets/.env.local`，不是 `tg-bridge/.env`），所以單純 `cp .env.example .env` 還不夠，執行時要帶上 `ENV_PATH=$(pwd)/.env`，如下面指令所示。`setup-notion*.js` 這兩支腳本則完全不理會 `ENV_PATH`（路徑寫死），要用這兩支時改成直接在 shell 裡匯出變數。

### 建立 Notion 資料庫

依序在你已經分享給 integration 的 Notion 頁面下執行一次（頁面 ID 從網址列取得）：

```bash
# 1. 核心資料庫：Ideas / Tasks / Shopping / Projects / Search Cache
NOTION_API_KEY=<你的 key> node scripts/setup-notion.js <parent_page_id>

# 2. 健康/飲食/運動資料庫（跟第 1 步分開，避免重跑第 1 步時把其它 DB 又建一次）
NOTION_API_KEY=<你的 key> node scripts/setup-notion-phase3.js <parent_page_id>

# 3. 幫既有的 Tasks/Shopping 加上提醒排程需要的欄位
ENV_PATH=$(pwd)/.env node scripts/add-reminder-fields.js

# 4. 幫既有的 Shopping 加上 /shopping 流程需要的欄位（Buyer/Location/Quantity...）
ENV_PATH=$(pwd)/.env node scripts/add-shopping-fields.js
```

第 1、2 步會把建好的資料庫 ID 寫進 `config/notion-dbs.json`（含真實 ID，已經 gitignore；正式環境建議放在專案目錄外，例如 `~/.secrets/`，用 `NOTION_DBS_CONFIG_PATH` 指過去——但要注意第 1、2 步的「寫入」動作永遠寫進預設的專案內路徑，不理會這個變數；只有「讀取」端跟第 3、4 步才會照這個變數走）。

### 執行

```bash
ENV_PATH=$(pwd)/.env node server.js
```

服務會同時起三個 Express app：Telegram bot 主流程（`BRIDGE_PORT`，預設 4141）、Skill Interface（`SKILL_PORT`，預設 3001，僅供 n8n/本機呼叫，不對外開放）、唯讀網頁+WebApp 表單（`TODAY_PORT`，預設 3005，today/projects/shopping 等頁面，Telegram WebApp 需要額外的 HTTPS listener）。

### 測試

```bash
npm test
```

全部測試用 mock 隔離 Notion API/AI Gateway，不會打到真實服務或消耗額度。

## 目錄結構

```
tg-bridge/
  server.js          # Telegram bot 主流程 + Skill Interface + 唯讀網頁
  lib/                # 意圖分類、Notion 存取、路由邏輯、各功能模組
  public/              # Telegram WebApp 表單/清單頁
  scripts/             # Notion 資料庫初始化/遷移腳本
  test/                # 單元測試（node:test）
```

## 授權

ISC
