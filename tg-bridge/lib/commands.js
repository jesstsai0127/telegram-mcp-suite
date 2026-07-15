// 依 project-assistant-spec.md §6.4 實作 Telegram 指令（/start、/server_status 因為是連線層邏輯，留在 server.js）。

const fs = require('fs');
const path = require('path');
const health = require('./health');
const financeTracker = require('./finance-tracker');
const todoFlow = require('./todo-flow');
const shoppingFlow = require('./shopping-flow');

const SKILL_REGISTRY_PATH = process.env.SKILL_REGISTRY_PATH ||
    path.join(__dirname, '..', '..', '..', 'global', 'skill-registry.json');

const HELP_TEXT = `AXIS 使用說明

直接打字即可記錄或查詢，例如：
「想到一個點子：用 AI 整理筆記」
「待辦：明天下午開會」
「要買衛生紙」
「今天有什麼待辦？」「購物清單有什麼？」
「查一下台灣今年 GDP」

指令：
/start    — 初始化並綁定
/server_status — 主機系統狀態（uptime/記憶體）
/status   — 系統狀態
/today    — 未來 24 小時內待辦（網頁）
/projects — 個人專案進度（網頁）
/skills   — 已啟用 Skill 清單
/net_worth — 目前資產淨值（存款+持股-負債）
/todo     — 待辦事項（新增/取消/修改/清單）
/shopping — 待買清單（新增/清單，標記已購買在清單頁點圓圓）
/help     — 使用說明`;

async function checkStatus(activeChatId) {
    const checks = await health.checkOpsHealth();
    checks.push(activeChatId ? '✅ Telegram 已綁定' : '❌ Telegram 未綁定');
    return `系統狀態\n\n${checks.join('\n')}`;
}

function listSkills() {
    const registry = JSON.parse(fs.readFileSync(SKILL_REGISTRY_PATH, 'utf8'));
    const lines = registry.skills.map(s =>
        `${s.status === 'active' ? '✅' : '⏸'} ${s.name}（${s.id}）v${s.version}`
    );
    return `已啟用 Skill 清單\n\n${lines.join('\n')}`;
}

// 帳戶/持股清單、新增/修改/刪除都在網頁 UI 做（見 finance-tracker CLAUDE.md）；
// Telegram 只留「淨值」這個唯一會想隨手問一句的查詢。2026-07-10 起網頁改成
// Telegram WebApp（inline keyboard 的 web_app 按鈕，需要 HTTPS），數字本身還是
// 直接顯示在訊息文字裡，按鈕只負責帶去完整清單/管理頁。
async function getNetWorth() {
    const networth = await financeTracker.getNetworth();
    return {
        text: financeTracker.formatNetworth(networth),
        options: {
            reply_markup: {
                inline_keyboard: [[
                    { text: '查看完整清單／新增/修改/刪除', web_app: { url: financeTracker.UI_HTTPS_URL } }
                ]]
            }
        }
    };
}

// today/projects 的完整清單改用網頁呈現（深色/Apple 風格，見 assistant/web-ui-style-guide.md），
// Telegram 這邊只回連結，不再吐一大段文字
const AXIS_PAGES_PORT = process.env.TODAY_PORT || 3005;
const TODAY_UI_URL = process.env.TODAY_UI_URL || `http://100.104.146.38:${AXIS_PAGES_PORT}/today`;
const PROJECTS_UI_URL = process.env.PROJECTS_UI_URL || `http://100.104.146.38:${AXIS_PAGES_PORT}/projects`;
const SETTINGS_UI_URL = process.env.SETTINGS_UI_URL || `http://100.104.146.38:${AXIS_PAGES_PORT}/settings`;

const COMMANDS = {
    '/status': (ctx) => checkStatus(ctx.activeChatId),
    '/today': async () => `🔜 Today\n${TODAY_UI_URL}`,
    '/projects': async () => `🗂 Projects\n${PROJECTS_UI_URL}`,
    '/skills': async () => listSkills(),
    '/net_worth': async () => getNetWorth(),
    '/todo': async () => todoFlow.menuMessage(),
    '/shopping': async () => shoppingFlow.menuMessage(),
    '/settings': async () => `⚙️ 一般設定\n${SETTINGS_UI_URL}`,
    '/help': async () => HELP_TEXT
};

// 給 bot.setMyCommands() 用：Telegram 的「/」指令選單是獨立於「輸入指令能不能執行」的
// 另一個 API（BotCommand list），沒呼叫過就永遠不會出現在選單裡，即使指令本身能正常回應。
// /start 因為是連線層邏輯留在 server.js，這裡跟著補上說明。
const COMMAND_DESCRIPTIONS = [
    { command: 'start', description: '初始化並綁定' },
    { command: 'status', description: '系統狀態' },
    { command: 'today', description: '未來 24 小時內待辦（網頁）' },
    { command: 'projects', description: '個人專案進度（網頁）' },
    { command: 'skills', description: '已啟用 Skill 清單' },
    { command: 'net_worth', description: '目前資產淨值（存款+持股-負債）' },
    { command: 'todo', description: '待辦事項（新增/清單，含已完成歷史）' },
    { command: 'shopping', description: '待買清單（新增/清單，含已購買歷史，標記已購買在清單頁點圓圓）' },
    { command: 'settings', description: '一般設定（例如預設提醒時間）' },
    { command: 'help', description: '使用說明' }
];

async function handleCommand(text, ctx = {}) {
    const spaceIdx = text.indexOf(' ');
    const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
    const handler = COMMANDS[command];
    if (!handler) return null;
    return handler(ctx, args);
}

module.exports = { handleCommand, COMMAND_DESCRIPTIONS };
