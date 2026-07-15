require('dotenv').config({ path: process.env.ENV_PATH || (__dirname + '/../../../.secrets/.env.local') });
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { Agent } = require('undici');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const fs = require('fs');
const { exec } = require('child_process');
const EventEmitter = require('events');
const { classifyIntent } = require('./lib/intent');
const { handleIntent, resolveRecordSelection } = require('./lib/router');
const { resolveTodoFlow } = require('./lib/todo-flow');
const { resolveShoppingFlow, confirmShoppingRecurring } = require('./lib/shopping-flow');
const commands = require('./lib/commands');
const { syncSkillRegistry } = require('./lib/skill-registry');
const settings = require('./lib/settings');

// 開機同步一次本地 skill-registry.json → Notion，不用檔案監聽或排程——
// 新增 Skill 本來就是人工改程式碼再重啟的動作，開機同步一次就跟得上
syncSkillRegistry().catch(err => console.error('[skill-registry] sync failed:', err.message));

const TOKEN = process.env.TELEGRAM_ASSISTANT_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
// 可覆寫路徑，讓測試環境指向獨立檔案，不會跟正式環境共用同一份 chat 綁定狀態
const CHAT_ID_FILE = process.env.CHAT_ID_FILE_PATH || (__dirname + '/chat_id.txt');
const SKILL_PORT = process.env.SKILL_PORT || 3001;
const N8N_MESSAGE_WEBHOOK = process.env.N8N_MESSAGE_WEBHOOK || 'http://localhost:5678/webhook/axis-message';

// 2026-07-07 根治連線可靠度問題：node-telegram-bot-api 用原生 fetch 長輪詢，連線幾乎
// 不間斷重複使用；中間節點（NAT/防火牆）默默關閉這條連線後，客戶端的連線池不知道，
// 下次重用就整個卡住等到 OS 底層 TCP timeout（可能好幾分鐘）才報錯——這段時間函式庫
// 自帶的重試迴圈完全卡住無法排下一輪。修法（原始碼本身內建的擴充點，不影響任何行為）：
// keepAliveTimeout 比中間節點的閒置關閉時間短，讓客戶端主動先回收；timeoutMs 讓真的
// 卡住的請求快速失敗，把控制權交還給函式庫既有的重試迴圈，而不是無限期卡住。
const telegramDispatcher = new Agent({ keepAliveTimeout: 15000, keepAliveMaxTimeout: 15000 });
const bot = new TelegramBot(TOKEN, {
    polling: true,
    request: { fetchOptions: { dispatcher: telegramDispatcher }, timeoutMs: 20000 }
});
const app = express();
app.use(bodyParser.json());

// setMyCommands 是獨立於「指令能不能執行」的另一個 API，沒呼叫過的話指令即使能正常
// 回應，也不會出現在 Telegram 的「/」選單裡——這裡補上，讓 COMMAND_DESCRIPTIONS 跟
// 選單保持同步（新增指令只需要改 commands.js 一個地方）
bot.setMyCommands(commands.COMMAND_DESCRIPTIONS).catch(err =>
    console.error('[setMyCommands] 註冊指令選單失敗：', err.message)
);

// 2026-07-06 真實事故：連 Telegram API 伺服器逾時（ETIMEDOUT/ENETUNREACH，網路暫時性問題，
// 不是我們的程式邏輯錯）觸發 node-telegram-bot-api 內部的 FatalError，這個 rejection 沒被
// 任何地方接住，直接讓整個 process 崩潰（連帶 skill 介面、notify proxy 一起斷線幾秒），
// systemd 5 秒後才重啟拉起新 process——這幾秒的空窗期就是使用者感受到的「回應變慢」。
// bot.on('polling_error', ...) 接住 library 有明確 emit 的那類錯誤；process.on('unhandledRejection', ...)
// 則是最後一道防線，確保任何沒被接住的 rejection 都只是記錄下來，不會讓整個 process 陪葬。
bot.on('polling_error', (err) => {
    console.error(`[polling_error] ${err.code || ''} ${err.message}（暫時性網路問題，process 繼續運行，不重啟）`);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] 未接住的 promise rejection，記錄但不讓 process 崩潰：', reason);
});

const replyEvents = new EventEmitter();
let activeChatId = fs.existsSync(CHAT_ID_FILE) ? fs.readFileSync(CHAT_ID_FILE, 'utf8').trim() : null;
let isWaitingForReply = false;

// 已知問題（lessons-learned.md 2026-07-04/05）：長時間運行後 outbound 連線（含
// polling 收訊）會靜默失效，/health 還是正常，但實際上收不到訊息、送不出推播，
// 而且沒有明確的根因可以直接修。與其等外部監控被動發現、要你手動重啟，
// 讓 tg-bridge 自己定期測試「還能不能真的跟 Telegram 對話」，
// 連續失敗代表這個 process 已經壞了，自己 exit 讓 systemd（Restart=always）
// 拉起全新的 process——這是服務自我管理生命週期，不是外部單方面關閉正在跑的服務。
//
// 2026-07-07 修正：原本測 bot.getMe()（讀取全域 bot 資訊），但實際發生過的失效模式
// 是「polling 收訊正常、getMe() 也正常，唯獨送不出推播」——getMe() 沒有真的走到
// 送訊息會用的那條 outbound 路徑，測不出這個問題。改測 sendChatAction('typing')：
// 這是對「特定 chat」送出的真實 POST（跟 sendMessage 同一條路徑），但只會讓對話框
// 短暫顯示「輸入中」、不會留下訊息紀錄，不會像每 5 分鐘发一則測試訊息那樣造成騷擾。
const HEARTBEAT_INTERVAL_MS = 5 * 60000; // 5 分鐘——你明確要求這個服務要確保運作無誤，縮短偵測間隔換取更快自我修復
const HEARTBEAT_TIMEOUT_MS = 8000;
const MAX_CONSECUTIVE_FAILURES = 2; // 連續 2 次（約 10 分鐘）才判定壞掉，避免單次網路抖動誤判
let consecutiveHeartbeatFailures = 0;

setInterval(async () => {
    try {
        // 還沒綁定過 chat 就沒有可以測的對象，退回測 getMe()（至少能抓到「完全連不上
        // Telegram」這種更嚴重的情況），綁定之後就測真正會用到的送訊息路徑
        const probe = activeChatId ? bot.sendChatAction(activeChatId, 'typing') : bot.getMe();
        await Promise.race([
            probe,
            new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), HEARTBEAT_TIMEOUT_MS))
        ]);
        consecutiveHeartbeatFailures = 0;
    } catch (err) {
        consecutiveHeartbeatFailures += 1;
        console.error(`[heartbeat] 第 ${consecutiveHeartbeatFailures} 次連不到 Telegram（${err.message}）`);
        if (consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error('[heartbeat] 連續失敗次數過多，判定 process 已經壞掉，自行結束讓 systemd 拉起新的');
            process.exit(1);
        }
    }
}, HEARTBEAT_INTERVAL_MS);

// --- Telegram Bot Logic ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Bind Chat ID
    if (text === '/start') {
        activeChatId = chatId.toString();
        fs.writeFileSync(CHAT_ID_FILE, activeChatId);
        bot.sendMessage(chatId, '✅ 系統已綁定！輸入 /help 查看可用指令，或 /server_status 查看主機狀態。');
        return;
    }

    if (!activeChatId) {
        bot.sendMessage(chatId, '請先輸入 /start 綁定系統。');
        return;
    }

    // Extensible Commands
    if (text === '/server_status') {
        exec('uptime && free -m', (error, stdout) => {
            if (error) {
                bot.sendMessage(chatId, '❌ 取得狀態失敗: ' + error.message);
                return;
            }
            bot.sendMessage(chatId, '🖥️ **主機狀態:**\n```\n' + stdout + '\n```', { parse_mode: 'Markdown' });
        });
        return;
    }

    // Spec §6.4 指令（/status /today /projects /skills /help /todo）
    // 指令回傳可能是純字串，也可能是 { text, options }（/todo 需要附 Reply Keyboard）
    try {
        const commandReply = await commands.handleCommand(text, { activeChatId });
        if (commandReply !== null) {
            if (typeof commandReply === 'string') {
                bot.sendMessage(chatId, commandReply);
            } else {
                bot.sendMessage(chatId, commandReply.text, commandReply.options);
            }
            return;
        }
    } catch (err) {
        bot.sendMessage(chatId, `無法完成：${err.message}\n下一步：稍後再試，或用 /status 檢查系統狀態`);
        return;
    }

    // /todo 六個按鈕點選、以及後續等待中的子流程輸入——跟 resolveRecordSelection 共用
    // pending-selection.js 的儲存，靠 type 欄位互斥，不會誤判彼此的狀態
    try {
        const todoResult = await resolveTodoFlow(chatId.toString(), text);
        if (todoResult) {
            bot.sendMessage(chatId, todoResult.text);
            return;
        }
    } catch (err) {
        bot.sendMessage(chatId, `無法完成：${err.message}\n下一步：稍後再試`);
        return;
    }

    // /shopping 兩個按鈕都是 web_app，點了不會送出文字訊息（跟 resolveTodoFlow 同款）；
    // 保留這段呼叫只是維持既有訊息路由結構一致，resolveShoppingFlow 永遠回傳 null
    try {
        const shoppingResult = await resolveShoppingFlow(chatId.toString(), text);
        if (shoppingResult) {
            bot.sendMessage(chatId, shoppingResult.text);
            return;
        }
    } catch (err) {
        bot.sendMessage(chatId, `無法完成：${err.message}\n下一步：稍後再試`);
        return;
    }

    // 取消/完成待辦：如果這個聊天視窗正在等待回覆數字選擇，優先處理，不進 n8n 分類
    try {
        const selectionResult = await resolveRecordSelection(chatId.toString(), text);
        if (selectionResult) {
            bot.sendMessage(chatId, selectionResult.text);
            return;
        }
    } catch (err) {
        bot.sendMessage(chatId, `無法完成：${err.message}\n下一步：稍後再試`);
        return;
    }

    // Pass messages to waiting MCP
    if (isWaitingForReply) {
        replyEvents.emit('reply', text);
        isWaitingForReply = false;
        bot.sendMessage(chatId, '✅ 已收到您的回覆。');
        return;
    }

    // 一般文字訊息：轉發給 n8n webhook，流程控制交給 n8n（分類 → 路由 → 執行 → 回覆）
    if (!text.startsWith('/')) {
        fetch(N8N_MESSAGE_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, chat_id: chatId.toString() })
        }).catch(err => {
            bot.sendMessage(chatId, `無法完成：${err.message}\n下一步：稍後再試，或換個說法`);
        });
        return;
    }

    // 沒有任何處理分支匹配到的斜線指令
    bot.sendMessage(chatId, `不認識的指令：${text}\n輸入 /help 查看可用指令`);
});

// --- Local API for MCP ---
// 單向推播改呼叫共用的 Notification Gateway（機器層級服務，任何專案都能用），
// 這裡不再自己用 bot.sendMessage——維持對呼叫端（n8n、MCP）行為不變，只是內部轉發
const NOTIFICATION_GATEWAY_URL = process.env.NOTIFICATION_GATEWAY_URL || 'http://localhost:3003/notify';
app.post('/notify', async (req, res) => {
    if (!activeChatId) return res.status(400).json({ error: 'Chat ID not bound. Please send /start to the bot.' });
    const { message } = req.body;
    try {
        const gwRes = await fetch(NOTIFICATION_GATEWAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: 'axis', message })
        });
        const data = await gwRes.json();
        if (!gwRes.ok) return res.status(gwRes.status).json(data);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/ask', (req, res) => {
    if (!activeChatId) return res.status(400).json({ error: 'Chat ID not bound. Please send /start to the bot.' });
    const { question } = req.body;
    
    isWaitingForReply = true;
    bot.sendMessage(activeChatId, '❓ **[需要確認]**\n' + question, { parse_mode: 'Markdown' });

    replyEvents.once('reply', (replyText) => {
        res.json({ reply: replyText });
    });
});

// 綁定 127.0.0.1：這個 endpoint 沒有身份驗證，只給同機的 n8n（host network 模式，
// localhost 就是本機）跟本機 MCP 呼叫，不應該讓區網/Tailscale 上的其他裝置連得到
const BRIDGE_PORT = process.env.BRIDGE_PORT || 4141;
app.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`Telegram Bridge running on port ${BRIDGE_PORT} (127.0.0.1 only)`);
});

// --- AXIS Skill Interface（依 global-spec.md §4.1） ---
const skillApp = express();
skillApp.use(bodyParser.json());

skillApp.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

skillApp.post('/classify', async (req, res) => {
    const { text } = req.body;
    try {
        const result = await classifyIntent(text);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

skillApp.post('/skill', async (req, res) => {
    const { intent, params, context } = req.body;
    try {
        const result = await handleIntent(intent, params, context);
        res.json({ success: true, skill: 'assistant', result, error: null });
    } catch (err) {
        res.json({ success: false, skill: 'assistant', result: null, error: err.message });
    }
});

// 給 n8n Switch 節點用的獨立 action endpoint：每一支對應一個固定 intent，
// 「打哪一支」的路由決策在 n8n 畫布上用節點連線明確定義，不是把 intent 當參數丟給程式碼自己選。
const ACTION_ROUTES = {
    'create-record': 'create_record',
    'query-records': 'query_records',
    'modify-record': 'modify_record',
    'web-search': 'web_search',
    'persona-feedback': 'persona_feedback',
    'unknown': 'unknown',
    'daily-report-push': 'daily_report_push',
    'daily-report-today': 'daily_report_today',
    'weekly-review': 'weekly_review',
    'persona-monthly-summary': 'persona_monthly_summary',
    'check-reminders': 'check_reminders',
    'check-shopping-reminders': 'check_shopping_reminders'
};

for (const [path, intent] of Object.entries(ACTION_ROUTES)) {
    // check-shopping-reminders 需要在週期性項目觸發時額外直接推播帶 inline keyboard 的
    // WebApp 按鈕（用 tg-bridge 自己的 bot，不透過共用的 notification-gateway——那邊目前
    // 不支援 reply_markup，比照 /ask 既有的「互動式回覆留在 tg-bridge」原則），
    // 用下面專屬的 route 處理，不套用這段給其餘 action 共用的純轉發邏輯
    if (path === 'check-shopping-reminders') continue;
    skillApp.post(`/actions/${path}`, async (req, res) => {
        try {
            const result = await handleIntent(intent, req.body.params || {}, req.body.context || {});
            res.json({ success: true, result, error: null });
        } catch (err) {
            res.json({ success: false, result: null, error: err.message });
        }
    });
}

// 週期性待買模板到期時的互動確認改成 WebApp 按鈕（2026-07-09）：check_shopping_reminders
// 回傳 result.data.recurringConfirm 才需要額外推播，一般的一次性提醒文字（result.text）
// 還是照舊由 n8n relay 給 /notify，這裡不重複處理
const SHOPPING_CONFIRM_HTTPS_PORT = process.env.TODAY_HTTPS_PORT || (Number(process.env.TODAY_PORT || 3005) + 1);
const SHOPPING_CONFIRM_HOST = process.env.TAILSCALE_CERT_NAME || 'yyds.tailbc46d2.ts.net';
skillApp.post('/actions/check-shopping-reminders', async (req, res) => {
    try {
        const result = await handleIntent('check_shopping_reminders', req.body.params || {}, req.body.context || {});
        const confirm = result.data && result.data.recurringConfirm;
        if (confirm && activeChatId) {
            const confirmUrl = `https://${SHOPPING_CONFIRM_HOST}:${SHOPPING_CONFIRM_HTTPS_PORT}/shopping-recurring-confirm?` +
                new URLSearchParams({
                    templateId: confirm.templateId,
                    itemTitle: confirm.itemTitle,
                    priority: confirm.priority || '',
                    buyer: confirm.buyer || '',
                    location: confirm.location || '',
                    notes: confirm.notes || '',
                    icalString: confirm.icalString || '',
                    firedAt: confirm.firedAt || '',
                    reminderOffsets: confirm.reminderOffsets || '',
                    moreText: confirm.moreText || ''
                }).toString();
            bot.sendMessage(
                activeChatId,
                `🔔 該買${confirm.itemTitle}了（週期性提醒），點下方按鈕確認。${confirm.moreText || ''}`,
                { reply_markup: { inline_keyboard: [[{ text: '查看並確認', web_app: { url: confirmUrl } }]] } }
            ).catch(err => console.error('[check-shopping-reminders] 推播互動確認失敗：', err.message));
        }
        res.json({ success: true, result, error: null });
    } catch (err) {
        res.json({ success: false, result: null, error: err.message });
    }
});

// 同上，沒有身份驗證，只收本機連線
skillApp.listen(SKILL_PORT, '127.0.0.1', () => {
    console.log(`AXIS Skill Interface running on port ${SKILL_PORT} (127.0.0.1 only)`);
});

// --- AXIS 唯讀網頁（today/projects，指令改回連結指向這裡）---
// 比照 finance-tracker 的可達範圍：127.0.0.1（本機測試）+ Tailscale IP（同 tailnet 裝置能連，
// 例如手機），不綁 0.0.0.0，不對外公開。TODAY_TAILSCALE_IP 若機器重新加入 tailnet 導致 IP 變動要跟著更新。
// 共用同一個 port：都是唯讀小工具頁面，不用每加一頁就多開一個 port。
const TODAY_PORT = process.env.TODAY_PORT || 3005;
const TODAY_TAILSCALE_IP = process.env.TODAY_TAILSCALE_IP || '100.104.146.38';
const todayApp = express();
todayApp.use(bodyParser.json());
// 2026-07-07 真實案例：使用者打開 todo-recurring.html 看到待辦本身，但完全沒有「編輯」
// 「標記完成」按鈕——伺服器端確認過檔案內容是最新版本，判斷是瀏覽器/Telegram 內嵌瀏覽器
// 快取了舊版頁面（這批頁面常常改版，又是透過 Telegram 訊息裡的連結點進來，內嵌瀏覽器
// 快取行為本來就比較不可預期）。這幾頁都是每次都要吃到最新資料/最新互動邏輯的動態頁面，
// 不該被瀏覽器快取，統一在這個 app 層加 no-store，之後改版不用每個 route 各自補一次。
todayApp.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
todayApp.get('/today', (req, res) => res.sendFile(__dirname + '/public/today.html'));
todayApp.get('/api/today', async (req, res) => {
    try {
        const result = await handleIntent('daily_report_today', {}, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.get('/projects', (req, res) => res.sendFile(__dirname + '/public/projects.html'));
todayApp.get('/api/projects', async (req, res) => {
    try {
        const result = await handleIntent('query_records', { entity: 'project' }, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.get('/shopping', (req, res) => res.sendFile(__dirname + '/public/shopping.html'));
// Telegram WebApp 新增待買表單 + 週期性推播互動確認頁面，只能透過 HTTPS 那個 listener
// 存取（Telegram client 會擋掉非 HTTPS 的 web_app 網址），HTTP 這邊也掛著純粹方便本機測試
todayApp.get('/shopping-add', (req, res) => res.sendFile(__dirname + '/public/shopping-add.html'));
todayApp.get('/shopping-recurring-confirm', (req, res) => res.sendFile(__dirname + '/public/shopping-recurring-confirm.html'));
todayApp.get('/api/shopping', async (req, res) => {
    try {
        const result = await handleIntent('shopping_page_data', {}, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 2026-07-08：獨立的 /shopping-search 頁面拿掉了，查詢功能併進 shopping.html 本身，
// 這支 API 現在是被 shopping.html 呼叫，不是獨立頁面
todayApp.get('/api/shopping-search', async (req, res) => {
    try {
        const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const monthsBack = Number(req.query.months);
        const result = await handleIntent('shopping_search_history', { keyword, monthsBack }, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.get('/todo-recurring', (req, res) => res.sendFile(__dirname + '/public/todo-recurring.html'));
// Telegram WebApp 新增一次性待辦表單，只能透過 HTTPS 那個 listener 存取
// （Telegram client 會擋掉非 HTTPS 的 web_app 網址），HTTP 這邊也掛著純粹是方便本機測試看畫面
todayApp.get('/todo-add', (req, res) => res.sendFile(__dirname + '/public/todo-add.html'));
todayApp.get('/api/todo-recurring', async (req, res) => {
    try {
        const result = await handleIntent('todo_recurring_page_data', {}, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// todo-recurring.html 的查詢功能專用，比照 /api/shopping-search
todayApp.get('/api/task-search', async (req, res) => {
    try {
        const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const monthsBack = Number(req.query.months);
        const result = await handleIntent('task_search_history', { keyword, monthsBack }, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 一般設定頁面——本機 JSON 設定檔，不是 Notion 資料，不走 handleIntent 那套（那套是
// 給有 entity 概念的資料用），直接呼叫 lib/settings.js
todayApp.get('/settings', (req, res) => res.sendFile(__dirname + '/public/settings.html'));
todayApp.get('/api/settings', (req, res) => {
    try {
        res.json({ settings: settings.listSettingsWithMeta() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.patch('/api/settings', (req, res) => {
    try {
        const updated = settings.updateSettings(req.body || {});
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 清單頁的可編輯表單專用：只收本機/Tailscale 內網連線（跟這整組唯讀頁面同一個 express
// app、同一個 listen 範圍），沒有另外加身份驗證——跟現有安全模型一致（本機全信任）。
todayApp.patch('/api/tasks/:id', async (req, res) => {
    try {
        const result = await handleIntent('update_task_field', { pageId: req.params.id, changes: req.body.changes || {} }, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Telegram WebApp 新增一次性待辦專用：表單本身已經是結構化欄位（datetime-local 選出來的
// 到期時間、勾選的提醒 chip），不經過 AI 分類器解析自由文字——2026-07-08 真實案例證實
// 「週四」「半小時後」這類相對日期讓 AI 自己算日期本身不穩定，這條路徑直接繞開整個問題，
// 不是叫 AI 算得更準。跟 chat 路徑共用同一個 create_record，只是 params 來源不同。
todayApp.post('/api/tasks', async (req, res) => {
    try {
        const { title, priority, category, due_date, reminders, notes, recurrence } = req.body || {};
        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ error: '缺少標題' });
        }
        // recurrence 有值時，router.js 的 create_record 會自動走週期性任務那條路
        // （跟 /todo 聊天式「新增週期性」是同一段程式碼，只是這裡的 recurrence 物件
        // 是表單直接組出來的結構化資料，不用 AI 解析文字）
        const result = await handleIntent('create_record', {
            entity: 'task', title: title.trim(), priority, category, due_date, reminders, notes, recurrence
        }, {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.patch('/api/shopping/:id', async (req, res) => {
    try {
        const result = await handleIntent('update_shopping_field', { pageId: req.params.id, changes: req.body.changes || {} }, {});
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Telegram WebApp 新增待買專用：跟 /api/tasks 同款，表單本身已經是結構化欄位，
// 不經過 AI 分類器解析自由文字（直接繞開「AI 猜週期/日期」這類不穩定的問題）
todayApp.post('/api/shopping', async (req, res) => {
    try {
        const {
            title, priority, category, buyer, location, quantityNeeded, priceEstimate,
            due_date, reminders, notes, recurrence
        } = req.body || {};
        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ error: '缺少名稱' });
        }
        const result = await handleIntent('create_record', {
            entity: 'shopping', title: title.trim(), priority, category, buyer, location,
            quantityNeeded, priceEstimate, due_date, reminders, notes, recurrence
        }, {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 週期性待買模板觸發推播後的互動確認（買了/跳過/取消整個系列），2026-07-09 起改成
// 由 shopping-recurring-confirm.html 這個 WebApp 表單直接送結構化欄位，取代原本
// 靠 AI 從文字回覆解析購買明細的做法——欄位直接來自使用者按的按鈕/填的表單，不會猜錯
todayApp.post('/api/shopping/recurring-confirm', async (req, res) => {
    try {
        const {
            templateId, action, itemTitle, priority, buyer, location, notes,
            icalString, firedAt, reminderOffsets, quantityPurchased, actualPrice, purchasedDate
        } = req.body || {};
        if (!templateId || !action) {
            return res.status(400).json({ error: '缺少 templateId 或 action' });
        }
        const result = await confirmShoppingRecurring({
            templateId, action, itemTitle, priority, buyer, location, notes,
            icalString, firedAt, reminderOffsets, quantityPurchased, actualPrice, purchasedDate
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
todayApp.listen(TODAY_PORT, '127.0.0.1', () => {
    console.log(`AXIS 網頁 running on port ${TODAY_PORT} (127.0.0.1)`);
});
todayApp.listen(TODAY_PORT, TODAY_TAILSCALE_IP, () => {
    console.log(`AXIS 網頁 running on port ${TODAY_PORT} (Tailscale ${TODAY_TAILSCALE_IP})`);
});

// Telegram WebApp（Mini App）強制要求 HTTPS，一般網頁走的 HTTP port 3005 不能用——
// 憑證用 Tailscale 內建的 HTTPS 憑證功能簽發（tailnet 內部真憑證，不用對外公開/不用
// Funnel），路徑外部化到 ~/.secrets/ 不進 git，跟其它機密同一套規則。這組 HTTPS 服務
// 目前只給需要 WebApp 的頁面用（例如新增待辦表單），沒開的話（憑證檔案不存在）就跳過，
// 不影響其餘既有的 HTTP 頁面。
// 預設用 TODAY_PORT+1（正式環境 3005→3006、測試環境 3015→3016），跟現有 port
// 分配慣例（test 每個 port 都是 prod 的 +10，例如 skill-interface 3001→3011）保持
// 同一種「衍生不新增」原則——這樣兩邊都不用再多設一個環境變數，減少要碰 .env* 的地方
// （.env.test 放的是機密設定檔，改起來比較麻煩，能少改就少改）
const TODAY_HTTPS_PORT = process.env.TODAY_HTTPS_PORT || (Number(TODAY_PORT) + 1);
const TAILSCALE_CERT_DIR = process.env.TAILSCALE_CERT_DIR || (process.env.HOME + '/.secrets/tailscale-cert');
const TAILSCALE_CERT_NAME = process.env.TAILSCALE_CERT_NAME || 'yyds.tailbc46d2.ts.net';
const certPath = `${TAILSCALE_CERT_DIR}/${TAILSCALE_CERT_NAME}.crt`;
const keyPath = `${TAILSCALE_CERT_DIR}/${TAILSCALE_CERT_NAME}.key`;
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, todayApp)
        .listen(TODAY_HTTPS_PORT, TODAY_TAILSCALE_IP, () => {
            console.log(`AXIS 網頁（HTTPS，供 Telegram WebApp 用）running on https://${TAILSCALE_CERT_NAME}:${TODAY_HTTPS_PORT}`);
        });
} else {
    console.error(`[https] 找不到 Tailscale 憑證（${certPath}），Telegram WebApp 頁面無法使用，其餘 HTTP 頁面不受影響`);
}
