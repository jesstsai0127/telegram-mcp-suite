# AXIS — Telegram Personal Assistant

A Telegram bot for logging todos, shopping lists, and ideas — or querying your lists/project status — just by typing naturally. Data lives in Notion. AI is only called at specific decision points (intent classification, web-search summarization, style-feedback parsing); everything else (create, query, scheduled push, due-date reminders) is deterministic logic, not something an AI decides on the fly.

[繁體中文版說明請見 README.zh-TW.md](README.zh-TW.md)

## Features

- **Natural-language logging/querying**: "idea: use AI to organize notes", "todo: meeting tomorrow afternoon", "need to buy tissues", "what's on my todo list today?" — intent classification runs on a local Ollama model
- **Todo / shopping lists**: one-time due-date reminders, recurring rules (`rrule`), Telegram WebApp forms for add/edit, list pages support continuous add and one-tap complete
- **Daily review push**: fixed template (completed / pending / overdue / tomorrow), not AI-generated — layout stays stable and predictable
- **Web search**: DuckDuckGo search + AI summary + cache (same query within 7 days is served from cache)
- **Persona style feedback**: user feedback on response style gets parsed into a rule and written into `persona.md`, shaping future responses
- **Health / diet / activity logging**, **net-worth lookup** (integrates with finance-tracker)
- **n8n as the flow-control layer**: deterministic routing/scheduling is defined explicitly as n8n nodes; AI is only invoked at nodes that genuinely need language understanding, not as the thing deciding the whole path after classification

## Architecture

```
Telegram message → tg-bridge (server.js) ── sole owner of the Telegram connection ──
                                       │
                                       ▼ webhook forward
                                    n8n (routing / scheduling)
                                       │
                                       ▼ HTTP
                         tg-bridge Skill Interface (/skill, /classify, /actions/*)
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                      Ollama        Notion        AI Gateway
                  (intent classify) (data store)  (summarize / style parsing,
                                                    rotates free-tier Gemini/Groq/etc.)
```

- **Notion** is the single source of truth (Tasks / Shopping / Ideas / Projects / Search Cache / Health / Diet / Activity). A local cache-aside layer (`lib/notion-cache.js`, SQLite) cuts down on API calls; write-through ensures your own writes are immediately visible on the next read.
- **AI tiering**: Level 1 local Ollama (intent classification) → Level 2 free-tier cloud rotation (summarization, style parsing) → Level 3 Claude API (only when explicitly requested, never auto-escalated).
- **Telegram WebApp forms** use structured fields (date pickers, checkboxes) instead of asking AI to parse free text for relative dates — avoids the class of bug where "Thursday" or "tomorrow" gets computed wrong.

## Setup

Requirements: Node.js 22+ (uses the built-in `node:sqlite`), Ollama running locally, a Notion account, a Telegram bot token.

```bash
cd tg-bridge
npm install
cp .env.example .env
```

Fill in `.env` per the comments in `.env.example`:

| Variable | Description |
|---|---|
| `TELEGRAM_ASSISTANT_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `NOTION_API_KEY` | Notion internal integration token — remember to share the target page with this integration |
| `OLLAMA_HOST` / `OLLAMA_INTENT_MODEL` | Local Ollama address and the model used for intent classification |
| `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` | Level 2 AI (summarization / style parsing) — can be a self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) or any OpenAI-compatible endpoint |

Everything else (n8n webhook, finance-tracker integration, ports, timezone) is optional — leaving it blank just disables that feature without affecting core logging/querying.

**Known rough edge**: `server.js` and the two field-migration scripts below read env vars via `ENV_PATH` (default: `~/.secrets/.env.local`, not `tg-bridge/.env`), so a plain `cp .env.example .env` alone is **not** enough — run with `ENV_PATH=$(pwd)/.env` set, as shown below. The two `setup-notion*.js` scripts don't honor `ENV_PATH` at all (hardcoded path); for those, export the vars directly in your shell instead.

### Create the Notion databases

Run these once, in order, against a Notion page you've shared with your integration (grab its page ID from the URL):

```bash
# 1. Core databases: Ideas / Tasks / Shopping / Projects / Search Cache
NOTION_API_KEY=<your_key> node scripts/setup-notion.js <parent_page_id>

# 2. Health / Diet / Activity databases (kept separate so re-running step 1 never duplicates the others)
NOTION_API_KEY=<your_key> node scripts/setup-notion-phase3.js <parent_page_id>

# 3. Add reminder-scheduling fields to the existing Tasks/Shopping databases
ENV_PATH=$(pwd)/.env node scripts/add-reminder-fields.js

# 4. Add the extra fields the /shopping flow needs (Buyer/Location/Quantity/...)
ENV_PATH=$(pwd)/.env node scripts/add-shopping-fields.js
```

Steps 1-2 write the resulting database IDs into `config/notion-dbs.json` (contains real IDs — already gitignored; in production, keep it outside the repo, e.g. under `~/.secrets/`, and point `NOTION_DBS_CONFIG_PATH` at it — note steps 1-2 themselves always write to the default in-repo path regardless of that variable; only reads, and steps 3-4, honor the override).

### Run

```bash
ENV_PATH=$(pwd)/.env node server.js
```

This starts three Express apps: the Telegram bot's main flow (`BRIDGE_PORT`, default 4141), the Skill Interface (`SKILL_PORT`, default 3001 — for n8n/local calls only, not exposed externally), and the read-only pages + WebApp forms (`TODAY_PORT`, default 3005 — today/projects/shopping pages; Telegram WebApp additionally requires an HTTPS listener).

### Test

```bash
npm test
```

All tests mock the Notion API and AI Gateway calls — nothing hits a real service or spends real quota.

## Directory structure

```
tg-bridge/
  server.js    # Telegram bot main flow + Skill Interface + read-only pages
  lib/         # Intent classification, Notion access, routing logic, feature modules
  public/      # Telegram WebApp forms/list pages
  scripts/     # Notion database setup/migration scripts
  test/        # Unit tests (node:test)
```

## License

ISC
