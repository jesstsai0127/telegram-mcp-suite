const search = require('./search');
const notion = require('./notion');
const format = require('./format');
const persona = require('./persona');
const ai = require('./ai');
const pendingSelection = require('./pending-selection');
const {
    parseReminderOffsetMinutes, computeNextReminderTrigger, formatOffsetMinutes,
    offsetsToStoredString, offsetsFromStoredString, DEFAULT_REMINDER_OFFSETS_MINUTES
} = require('./reminder-offset');

// 使用者講的提醒詞（例如「1天前」「6小時前」）換算成分鐘清單；一個都解析不出來
// （或使用者根本沒講）就退回預設兩筆——24小時前 + 1小時前，跟 Outlook/Google Calendar/
// iPhone/Android 的「每個項目預設有提醒、可以自己調整」是同一套模式。
function resolveOffsetsMinutes(remindersPhrases) {
    const parsed = (remindersPhrases || []).map(parseReminderOffsetMinutes).filter(Boolean);
    return parsed.length > 0 ? parsed : [...DEFAULT_REMINDER_OFFSETS_MINUTES];
}
const { SCHEMAS } = require('./db-schemas');
const health = require('./health');
const recurrence = require('./recurrence');
const settings = require('./settings');

class NotImplementedError extends Error {}

// modify_record 跨 DB 搜尋的範圍——project 沒有 toUpdateFields（由 setup script 建立，
// 不透過聊天修改），本來就不支援 modify，不用納入搜尋
const MODIFIABLE_ENTITIES = ['task', 'shopping', 'idea'];

// AI 意圖解析只會給「完成」這個通用動詞，但各 entity 的 Status 選項用字不同
// （task/idea 是「完成」，shopping 是「已購」）——resolveRecordSelection 是共用流程，
// 這裡負責把通用動詞轉成該 entity 實際存在的 Status 值，不要把「完成」原封不動寫進
// shopping 的 Status（那個欄位只有「待購」「已購」兩個合法值）。
const TERMINAL_STATUS_BY_ENTITY = { task: '完成', shopping: '已購', idea: '完成' };

// 各 entity 標記「週期性/規則性模板」的 Type 值不同，用來擋掉「直接把模板標記完成」
// 這種會摧毀模板本身的操作——週期性項目該用專屬的購買/完成流程另外建一筆紀錄，
// 不是改模板的 Status（模板要靠 Status=待購 永遠有效，才能靠 Next Trigger 繼續推進）。
const RECURRING_TYPE_NAME_BY_ENTITY = { task: '規則性', shopping: '週期性' };

// 預設 +08:00（Asia/Taipei），換裝到別的時區只需要設 TIMEZONE_OFFSET，不用改程式碼
const TIMEZONE_OFFSET = process.env.TIMEZONE_OFFSET || '+08:00';

function toTaipeiISO(dateTimeStr) {
    return dateTimeStr.replace(' ', 'T') + ':00' + TIMEZONE_OFFSET;
}

function resolveScope(scope) {
    const now = new Date();
    const monthMatch = scope && scope.match(/(\d{1,2})\s*月/);
    if (monthMatch) {
        const month = parseInt(monthMatch[1], 10);
        const currentMonth = now.getMonth() + 1;
        const year = month < currentMonth ? now.getFullYear() + 1 : now.getFullYear();
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        return { start, end };
    }
    if (scope && (scope.includes('這個月') || scope.includes('本月'))) {
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        return { start, end };
    }
    // 沒提到時間範圍就不做日期限制——modify_record 常常就是要找「已經逾期」的東西
    // 來取消/完成，預設縮到「今天~未來7天」會把所有逾期項目都濾掉，等於找不到
    return {};
}

function plainTitle(row, titleProperty) {
    return (row.properties[titleProperty].title || []).map(t => t.plain_text).join('');
}


// 取消/完成/修改都走同一套「列候選→回覆數字確認」流程，不因為 action 不同而各自重寫。
async function resolveRecordSelection(chatId, text) {
    const pendingItem = pendingSelection.getPending(chatId);
    // type 區分「候選選擇」跟 todo-flow 的 pending，避免誤把 todo-flow 的 pending 當成候選清單處理
    if (!pendingItem || pendingItem.type !== 'select_candidate') return null;

    const num = parseInt(text.trim(), 10);
    if (!Number.isInteger(num) || num < 1 || num > pendingItem.candidates.length) {
        return { text: `請回覆 1 到 ${pendingItem.candidates.length} 之間的數字，或換個方式重新開始`, data: {}, actions: [] };
    }

    const chosen = pendingItem.candidates[num - 1];
    // entity 以候選項目本身為準（跨 DB 搜尋後每筆候選可能來自不同 entity），
    // 不是分類器一開始猜的那個——猜錯也沒關係，選到哪筆就用哪筆的 schema
    const config = SCHEMAS[chosen.entity];
    pendingSelection.clearPending(chatId);

    if (pendingItem.action === '修改') {
        const changes = { ...(pendingItem.changes || {}) };
        if (changes.due_date && /\d{2}:\d{2}$/.test(changes.due_date)) {
            changes.due_date = toTaipeiISO(changes.due_date);
        }
        const fields = config.toUpdateFields(changes);
        await notion.updateRecord(chosen.pageId, fields);
        await notion.logOperation({
            project: 'axis', entity: chosen.entity, action: '修改',
            summary: `修改：${chosen.title}`, detail: JSON.stringify(changes)
        });
        return { text: `已將「${chosen.title}」更新`, data: {}, actions: [] };
    }

    if (pendingItem.action === '完成' && chosen.recurring) {
        return {
            text: `「${chosen.title}」是週期性模板，不能直接標記完成——模板本身要留著讓 Next Trigger 繼續推進，這一輪真的完成/買了的話，請用對應的完成/購買流程另外記一筆`,
            data: {}, actions: []
        };
    }

    const statusToWrite = pendingItem.action === '完成'
        ? (TERMINAL_STATUS_BY_ENTITY[chosen.entity] || pendingItem.action)
        : pendingItem.action;
    // 走 toUpdateFields 而不是直接寫 Status——task 標記完成時要順便寫 Completed Date，
    // 這段邏輯只在 toUpdateFields 裡有一份，這裡不能繞過去，不然又會變回兩處各自維護一份的老問題
    await notion.updateRecord(chosen.pageId, config.toUpdateFields({ status: statusToWrite }));
    await notion.logOperation({
        project: 'axis', entity: chosen.entity, action: pendingItem.action,
        summary: `${pendingItem.action}：${chosen.title}`, detail: ''
    });
    return { text: `已將「${chosen.title}」標記為${pendingItem.action}`, data: {}, actions: [] };
}

const FEEDBACK_SYSTEM_PROMPT = `你是規則萃取器。使用者對 AXIS（個人助理）的回應風格提出反饋，
把它轉換成一條可以加入 persona.md 的具體規則。只輸出 JSON，不要任何其他文字或 markdown 標記。

可用章節（必須從中選一個最貼切的）：${persona.SECTIONS.join('、')}

輸出格式範例：{"section": "語氣", "rule": "回覆不超過三句話", "summary": "使用者反映回應太長，加入簡潔規則"}`;

function parseFeedbackResponse(raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI 回應中找不到 JSON');
    const parsed = JSON.parse(match[0]);
    if (!parsed.rule || !parsed.section || !parsed.summary) {
        throw new Error('AI 回應缺少 rule、section 或 summary 欄位');
    }
    return parsed;
}

// skill_route 排到 Phase 2+
async function handleIntent(intent, params = {}, context = {}) {
    switch (intent) {
        case 'create_record': {
            const config = SCHEMAS[params.entity];

            // 規則性任務/週期性待買模板：跟單次項目是兩條不同的路，AI 只給結構化欄位，
            // 實際日期運算交給 rrule，task/shopping 共用同一段轉換（entity 只影響存哪個 DB、
            // 回覆文字用什麼字眼，核心的 rrule 解析邏輯完全一樣）
            const RECURRING_ENTITIES = ['task', 'shopping'];
            if (RECURRING_ENTITIES.includes(params.entity) && params.recurrence) {
                const r = params.recurrence;
                const dtstart = new Date(toTaipeiISO(`${format.todayStr()} ${r.time}`));
                const rule = recurrence.parseRecurrence({
                    freq: r.freq, byweekday: r.byweekday, bysetpos: r.bysetpos, bymonthday: r.bymonthday,
                    bymonth: r.bymonth, interval: r.interval, count: r.count, until: r.until, dtstart
                });
                if (!rule) {
                    return {
                        text: '看不懂這個週期，換個講法，例如「每天」「每週一三五」「每月第二個星期二」「每年3月5號」',
                        data: {}, actions: []
                    };
                }
                const firstTrigger = rule.after(dtstart, true).toISOString();
                const recurringPayload = { icalString: rule.toString(), firstTrigger };
                let reminderOffsetsStored;

                // 只有 Shopping 的週期性模板需要「提前通知」——Task 的規則性任務本身就是靠
                // rrule 反覆觸發，不是「到期前 N 分鐘提醒」這種語意，維持原本行為不變
                if (params.entity === 'shopping') {
                    const offsetsMinutes = resolveOffsetsMinutes(params.reminders);
                    reminderOffsetsStored = offsetsToStoredString(offsetsMinutes);
                    const nextReminder = computeNextReminderTrigger(new Date(firstTrigger), offsetsMinutes, new Date());
                    if (nextReminder) recurringPayload.nextTrigger = nextReminder.trigger.toISOString();
                }

                const fields = config.toCreateFields({
                    ...params, recurring: recurringPayload, reminderOffsets: reminderOffsetsStored
                });
                await notion.createRecord(config.dbKey, fields);
                const label = params.entity === 'task' ? '規律任務' : '週期性待買';
                // Shopping 實際寫進 Notion 的 Next Trigger 可能是提前通知時刻（比到期時刻早），
                // 顯示 firstTrigger 會跟真正會推播的時間對不上，這裡改顯示真正存進去的那個值
                const nextTriggerDisplay = recurringPayload.nextTrigger || firstTrigger;
                return {
                    text: `已記錄${label}：${params.title}，下次觸發：${format.formatDateTimeShort(nextTriggerDisplay)}`,
                    data: {}, actions: []
                };
            }

            let dueDateForNotion = params.due_date;
            let nextTrigger = null;
            let reminderOffsetsStored;
            let offsetsMinutesUsed = [];
            let offsetsMinutesFuture = [];

            // 2026-07-08 真實案例：使用者說「明天提醒我跑步」沒帶時間，due_date 只有日期，
            // 下面的 hasTime 判斷會是 false，整段提醒排程完全不會執行——即使使用者講的是
            // 「提醒」也不會真的收到通知。比照週期性任務「沒提到時間就補預設值」的既有慣例，
            // 這裡也補一個預設時間；完全沒給日期的（due_date 本身是 null）不受影響，不會
            // 被硬塞一個時間、也不會被排提醒，「還在考慮、沒時間」的待辦本來就不該收到通知。
            // Shopping 一次性項目有到期日的情境（例如出國前一週要買 sim 卡）跟 Task 是同一種
            // 語意，同樣需要有時間才能算出 Next Trigger，這裡一起處理。
            const ONE_TIME_REMINDER_ENTITIES = ['task', 'shopping'];
            if (ONE_TIME_REMINDER_ENTITIES.includes(params.entity) && params.due_date && !/\d{2}:\d{2}$/.test(params.due_date)) {
                params.due_date = `${params.due_date} ${settings.getSetting('defaultReminderTime')}`;
                dueDateForNotion = params.due_date;
            }

            if (ONE_TIME_REMINDER_ENTITIES.includes(params.entity)) {
                const hasTime = params.due_date && /\d{2}:\d{2}$/.test(params.due_date);
                if (hasTime) {
                    dueDateForNotion = toTaipeiISO(params.due_date);
                    offsetsMinutesUsed = resolveOffsetsMinutes(params.reminders);
                    reminderOffsetsStored = offsetsToStoredString(offsetsMinutesUsed);
                    const anchor = new Date(dueDateForNotion);
                    const now = new Date();
                    // 建立當下就已經過了的提醒點永遠不會觸發（Next Trigger 只會指到最快的
                    // 那個未來時間點），確認訊息只列出真的還會提醒的，避免使用者以為
                    // 已經過期的那個也會響
                    offsetsMinutesFuture = offsetsMinutesUsed.filter(o => new Date(anchor.getTime() - o * 60000) > now);
                    const nextReminder = computeNextReminderTrigger(anchor, offsetsMinutesUsed, now);
                    nextTrigger = nextReminder ? nextReminder.trigger.toISOString() : null;
                }
            }

            const fields = config.toCreateFields({
                ...params, due_date: dueDateForNotion, next_trigger: nextTrigger, reminderOffsets: reminderOffsetsStored
            });
            await notion.createRecord(config.dbKey, fields);

            // health 沒有 title 欄位（Title 本身就是日期），用 Status 當作回覆裡的摘要顯示，
            // 避免直接印出 params.title（undefined）
            const displayTitle = params.entity === 'health'
                ? `${params.date || format.todayStr()}（${params.status || '普通'}）`
                : params.title;
            const dueText = params.due_date ? `（截止：${params.due_date}）` : '';
            const priorityText = params.priority ? `（${params.priority}）` : '';
            const reminderText = nextTrigger
                ? `，將於 ${offsetsMinutesFuture.map(formatOffsetMinutes).join('、')} 提醒你`
                : '';
            return { text: `已記錄 ${config.dbKey}：${displayTitle}${dueText}${priorityText}${reminderText}`, data: {}, actions: [] };
        }

        case 'query_records': {
            const config = SCHEMAS[params.entity];
            const rows = await notion.queryRecords(config.dbKey, config.queryFilter, config.querySorts);
            let text = config.formatter(rows);
            let data = {};
            // 維運狀況只在查 project 時附加，不放進 Today／每日推播——這是你確認過的位置
            if (params.entity === 'project') {
                const checks = await health.checkOpsHealth();
                text += `\n\n🔧 維運狀況\n${checks.join('\n')}`;
                // /projects 網頁跟 Telegram 文字共用這份乾淨資料，不用各自解析一次 Notion property 格式
                data = {
                    projects: rows.map(r => {
                        const p = r.properties;
                        return {
                            name: format.plain(p.Name.title),
                            status: p.Status.select?.name || null,
                            phase: p['Current Phase'].select?.name || null,
                            summary: format.plain(p.Summary.rich_text),
                            issues: format.plain(p.Issues.rich_text),
                            lastUpdated: format.relativeTime(p['Last Updated'].date?.start)
                        };
                    }),
                    opsHealth: checks
                };
            }
            return { text, data, actions: [] };
        }

        case 'modify_record': {
            const { title_hint, action, changes, scope } = params;
            // 跨 DB 搜尋：分類器猜的 entity 只是提示，不拿來限制搜尋範圍——
            // 猜錯 entity（例如把 idea 誤判成 task）不該讓明明存在的紀錄變成「找不到」。
            // entity 真正定案的時機是使用者選完候選之後，見 resolveRecordSelection。
            let candidates = [];
            for (const entityKey of MODIFIABLE_ENTITIES) {
                const config = SCHEMAS[entityKey];
                const range = config.hasDueDate ? resolveScope(scope) : {};
                const rows = await notion.findRecords(config.dbKey, {
                    titleProperty: config.titleProperty,
                    hint: title_hint,
                    pendingStatuses: config.pendingStatuses,
                    ...range
                });
                const recurringTypeName = RECURRING_TYPE_NAME_BY_ENTITY[entityKey];
                candidates.push(...rows.map(r => ({
                    entity: entityKey,
                    pageId: r.id,
                    title: plainTitle(r, config.titleProperty),
                    due: config.hasDueDate ? (r.properties['Due Date']?.date?.start || null) : null,
                    recurring: recurringTypeName ? r.properties.Type?.select?.name === recurringTypeName : false
                })));
            }

            if (candidates.length === 0) {
                return {
                    text: `找不到符合「${title_hint}」的紀錄，換個關鍵字再試，或查詢目前清單`,
                    data: {}, actions: []
                };
            }

            if (context.chat_id) {
                pendingSelection.setPending(context.chat_id, { type: 'select_candidate', action, changes, candidates });
            }
            return { text: format.formatCandidates(candidates, action, changes), data: {}, actions: [] };
        }

        // 早報+晚結合併：自動排程，晚間觸發一次。內容只保留一份，不重複維護兩套模板。
        case 'daily_report_push': {
            // todayStr() 回的是台北在地日期，直接接 Z 會把台北午夜當成 UTC 午夜（差 8 小時），
            // 漏掉台北 00:00-08:00 之間完成的任務——要接台北時區的 offset，不是 Z
            const todayStart = `${format.todayStr()}T00:00:00${TIMEZONE_OFFSET}`;
            const completed = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    { property: 'Status', select: { equals: '完成' } },
                    { timestamp: 'last_edited_time', last_edited_time: { on_or_after: todayStart } }
                ]
            });
            const unfinished = await notion.queryDb(SCHEMAS.task.dbKey, {
                or: [
                    { property: 'Status', select: { equals: '待辦' } },
                    { property: 'Status', select: { equals: '進行中' } }
                ]
            });
            // 已逾期：像真人助理一樣只在每天固定的回顧時機提起，不另外做即時通知；
            // 用逾期天數呈現輕重，不用另外設計分級/追蹤機制。
            const overdue = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    {
                        or: [
                            { property: 'Status', select: { equals: '待辦' } },
                            { property: 'Status', select: { equals: '進行中' } }
                        ]
                    },
                    { property: 'Due Date', date: { before: new Date().toISOString() } }
                ]
            });
            const tomorrowDue = await notion.queryDb(SCHEMAS.task.dbKey, {
                property: 'Due Date', date: { equals: format.todayStr(1) }
            });
            const tomorrowRecurring = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    { property: 'Type', select: { equals: '規則性' } },
                    { property: 'Next Trigger', date: { equals: format.todayStr(1) } }
                ]
            });
            const reportData = { completed, unfinished, overdue, upcoming: [...tomorrowDue, ...tomorrowRecurring] };
            return { text: format.formatDailyPush(reportData), data: {}, actions: [] };
        }

        // 每週回顧：自動排程（週日 21:00）。抓每日推播看不到的東西，不是每日內容的週期複製——
        // 本週完成量（只算數量，清單每天都推過了）、真的被晾超過一週的停滯項目、Projects 定期進度。
        case 'weekly_review': {
            const past7d = new Date(Date.now() - 7 * 86400000).toISOString();
            const completedRows = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    { property: 'Status', select: { equals: '完成' } },
                    { timestamp: 'last_edited_time', last_edited_time: { on_or_after: past7d } }
                ]
            });
            // 用「7 天沒異動」而不是「Due Date 過期」判斷 stale：後者會漏掉根本沒填 Due Date
            // 的待辦（Notion 對空的日期欄位做 before 比較會直接不匹配），跟這個功能原本要
            // 「揪出放著沒動的舊待辦」的用意對不上
            const stale = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    {
                        or: [
                            { property: 'Status', select: { equals: '待辦' } },
                            { property: 'Status', select: { equals: '進行中' } }
                        ]
                    },
                    { timestamp: 'last_edited_time', last_edited_time: { before: past7d } }
                ]
            });
            const projectRows = await notion.queryDb(SCHEMAS.project.dbKey);
            return {
                text: format.formatWeeklyReview({ completedCount: completedRows.length, stale, projectRows }),
                data: {}, actions: []
            };
        }

        // Today：手動觸發（/today 指令），滾動 24 小時視窗（過去 24 小時完成＋未來 24 小時待辦），
        // 跟 daily_report_push 內容形狀類似（都有已完成/未完成）但時間範圍不同（推播是日曆日 00:00-23:59），
        // 用途也不同：daily_report_push 排程可能因為主機沒開而沒推播，Today 讓你隨時手動補查。
        case 'daily_report_today': {
            const past24h = new Date(Date.now() - 24 * 3600000).toISOString();
            const in24h = new Date(Date.now() + 24 * 3600000).toISOString();

            const completed = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    { property: 'Status', select: { equals: '完成' } },
                    { timestamp: 'last_edited_time', last_edited_time: { on_or_after: past24h } }
                ]
            });
            const unfinished = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [
                    {
                        or: [
                            { property: 'Status', select: { equals: '待辦' } },
                            { property: 'Status', select: { equals: '進行中' } }
                        ]
                    },
                    {
                        or: [
                            { property: 'Due Date', date: { is_empty: true } },
                            { property: 'Due Date', date: { on_or_before: in24h } }
                        ]
                    }
                ]
            });
            // 轉成跟 Notion property 格式脫鉤的乾淨物件，Telegram 文字跟 /api/today 網頁共用同一份，
            // 不用各自解析一次 Notion 回傳格式
            const cleanData = {
                date: format.todayStr(),
                completed: completed.map(r => ({ title: format.plain(r.properties.Title.title) })),
                unfinished: unfinished.map(r => ({
                    title: format.plain(r.properties.Title.title),
                    status: r.properties.Status.select?.name || null,
                    dueDate: format.formatDateTimeShort(r.properties['Due Date'].date?.start)
                }))
            };
            return { text: format.formatTodayReport(cleanData), data: cleanData, actions: [] };
        }

        // shopping.html 專用：待購（含週期性模板）+ 已購買歷史，網頁自己依 purchasedDate 分組，
        // 不在後端先分組，避免月份分組邏輯卡在 API 合約裡難以之後調整呈現方式
        case 'shopping_page_data': {
            const pending = await notion.queryDb(SCHEMAS.shopping.dbKey, {
                property: 'Status', select: { equals: '待購' }
            });
            const purchased = await notion.queryDb(SCHEMAS.shopping.dbKey, {
                property: 'Status', select: { equals: '已購' }
            }, [{ property: 'Purchased Date', direction: 'descending' }]);

            const cleanData = {
                pending: pending.map(r => {
                    const p = r.properties;
                    return {
                        id: r.id,
                        title: format.plain(p.Item.title),
                        priority: p.Priority.select?.name || null,
                        type: p.Type.select?.name || '單次',
                        category: p.Category?.select?.name || null,
                        buyer: format.plain(p.Buyer.rich_text) || null,
                        location: format.plain(p.Location.rich_text) || null,
                        quantityNeeded: p['Quantity Needed']?.number ?? null,
                        priceEstimate: p['Price Estimate']?.number ?? null,
                        notes: format.plain(p.Notes.rich_text) || null,
                        // 只有一次性項目才可能有值（週期性模板用 Next Trigger/Occurrence At 驅動，
                        // 不用 Due Date）
                        dueDate: format.formatDateTimeShort(p['Due Date']?.date?.start),
                        nextTrigger: format.formatDateTimeShort(p['Next Trigger']?.date?.start)
                    };
                }),
                purchased: purchased.map(r => {
                    const p = r.properties;
                    return {
                        title: format.plain(p.Item.title),
                        buyer: format.plain(p.Buyer.rich_text) || null,
                        location: format.plain(p.Location.rich_text) || null,
                        quantityPurchased: p['Quantity Purchased']?.number ?? null,
                        actualPrice: p['Actual Price']?.number ?? null,
                        purchasedDate: p['Purchased Date']?.date?.start || null,
                        notes: format.plain(p.Notes.rich_text) || null
                    };
                })
            };
            return { text: '', data: cleanData, actions: [] };
        }

        // shopping.html 的查詢紀錄功能專用（2026-07-08 前是獨立頁面 shopping-search.html，
        // 已併入 shopping.html 本身）：關鍵字 + 時間範圍查詢已購買紀錄，用來比價（有沒有漲價/
        // 更便宜的選擇）。模糊比對就是 Notion 原生的 title contains（子字串、不分大小寫）——
        // 查過 Notion API 文件跟 Grocy 的實作，兩者都只有這種子字串比對，沒有更進階的用法，
        // 這裡故意不多引入 fuzzy-search 套件。
        case 'shopping_search_history': {
            const monthsBack = Number.isFinite(params.monthsBack) && params.monthsBack > 0 ? params.monthsBack : 6;
            const startDate = new Date();
            startDate.setMonth(startDate.getMonth() - monthsBack);

            const and = [
                { property: 'Status', select: { equals: '已購' } },
                { property: 'Purchased Date', date: { on_or_after: startDate.toISOString().slice(0, 10) } }
            ];
            if (params.keyword) and.push({ property: 'Item', title: { contains: params.keyword } });

            const rows = await notion.queryDb(SCHEMAS.shopping.dbKey, { and },
                [{ property: 'Purchased Date', direction: 'descending' }]);

            const cleanData = {
                results: rows.map(r => {
                    const p = r.properties;
                    const quantityPurchased = p['Quantity Purchased']?.number ?? null;
                    const actualPrice = p['Actual Price']?.number ?? null;
                    // 單價方便比價：同一品項不同時間買、數量不一樣時，直接比總價沒有意義
                    const unitPrice = (Number.isFinite(quantityPurchased) && quantityPurchased > 0 && Number.isFinite(actualPrice))
                        ? Math.round((actualPrice / quantityPurchased) * 100) / 100
                        : null;
                    return {
                        title: format.plain(p.Item.title),
                        purchasedDate: p['Purchased Date']?.date?.start || null,
                        quantityPurchased, actualPrice, unitPrice,
                        buyer: format.plain(p.Buyer.rich_text) || null,
                        location: format.plain(p.Location.rich_text) || null,
                        notes: format.plain(p.Notes.rich_text) || null
                    };
                })
            };
            return { text: '', data: cleanData, actions: [] };
        }

        // todo-recurring.html 專用：所有待辦（一次性+規則性都要看到，跟 shopping_page_data
        // 的「待購（含週期性模板）」同一種結構，task/shopping 兩邊清單頁保持對稱）
        case 'todo_recurring_page_data': {
            const pendingStatus = {
                or: [
                    { property: 'Status', select: { equals: '待辦' } },
                    { property: 'Status', select: { equals: '進行中' } }
                ]
            };
            const oneTimeRows = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [{ property: 'Type', select: { equals: '單次' } }, pendingStatus]
            }, [{ property: 'Due Date', direction: 'ascending' }]);
            const recurringRows = await notion.queryDb(SCHEMAS.task.dbKey, {
                and: [{ property: 'Type', select: { equals: '規則性' } }, pendingStatus]
            });
            // 已完成歷史——跟 shopping_page_data 的 purchased 同一種用途，讓 todo-recurring.html
            // 也能有「歷史」區塊，兩邊清單頁保持對稱（差別只在欄位：task 沒有金額/單價這些
            // 購物專屬欄位）。跟 shopping 一樣不在後端先分組，月份分組邏輯留給前端。
            const completedRows = await notion.queryDb(SCHEMAS.task.dbKey, {
                property: 'Status', select: { equals: '完成' }
            }, [{ property: 'Completed Date', direction: 'descending' }]);
            const cleanData = {
                oneTime: oneTimeRows.map(r => {
                    const p = r.properties;
                    return {
                        id: r.id,
                        title: format.plain(p.Title.title),
                        priority: p.Priority?.select?.name || null,
                        category: p.Category?.select?.name || null,
                        dueDate: format.formatDateTimeShort(p['Due Date']?.date?.start),
                        notes: format.plain(p.Notes?.rich_text) || null
                    };
                }),
                recurring: recurringRows.map(r => {
                    const p = r.properties;
                    return {
                        id: r.id,
                        title: format.plain(p.Title.title),
                        priority: p.Priority?.select?.name || null,
                        category: p.Category?.select?.name || null,
                        nextTrigger: format.formatDateTimeShort(p['Next Trigger'].date?.start)
                    };
                }),
                completed: completedRows.map(r => {
                    const p = r.properties;
                    return {
                        title: format.plain(p.Title.title),
                        priority: p.Priority?.select?.name || null,
                        category: p.Category?.select?.name || null,
                        completedDate: p['Completed Date']?.date?.start || null,
                        notes: format.plain(p.Notes?.rich_text) || null
                    };
                })
            };
            return { text: '', data: cleanData, actions: [] };
        }

        // todo-recurring.html 的查詢功能專用，比照 shopping_search_history：關鍵字 +
        // 時間範圍查詢已完成的待辦。task 沒有金額，沒有單價可比，比 shopping 版單純。
        case 'task_search_history': {
            const monthsBack = Number.isFinite(params.monthsBack) && params.monthsBack > 0 ? params.monthsBack : 6;
            const startDate = new Date();
            startDate.setMonth(startDate.getMonth() - monthsBack);

            const and = [
                { property: 'Status', select: { equals: '完成' } },
                { property: 'Completed Date', date: { on_or_after: startDate.toISOString().slice(0, 10) } }
            ];
            if (params.keyword) and.push({ property: 'Title', title: { contains: params.keyword } });

            const rows = await notion.queryDb(SCHEMAS.task.dbKey, { and },
                [{ property: 'Completed Date', direction: 'descending' }]);

            const cleanData = {
                results: rows.map(r => {
                    const p = r.properties;
                    return {
                        title: format.plain(p.Title.title),
                        completedDate: p['Completed Date']?.date?.start || null,
                        priority: p.Priority?.select?.name || null,
                        category: p.Category?.select?.name || null,
                        notes: format.plain(p.Notes?.rich_text) || null
                    };
                })
            };
            return { text: '', data: cleanData, actions: [] };
        }

        // shopping.html／todo-recurring.html 的可編輯表單專用：只接受白名單欄位再交給
        // toUpdateFields（跟 chat 路徑共用同一份轉換），Recurrence/Next Trigger/Occurrence At
        // 這些排程用的欄位不開放網頁直接改——改壞會讓提醒排程跟著壞掉，這類異動還是走 chat
        // 對話讓 AI 輔助解析規則比較穩。
        case 'update_task_field': {
            const ALLOWED_FIELDS = ['title', 'due_date', 'priority', 'category', 'notes', 'status'];
            const changes = {};
            for (const key of ALLOWED_FIELDS) {
                if (params.changes?.[key] !== undefined) changes[key] = params.changes[key];
            }
            // 網頁表單送的是 "YYYY-MM-DD HH:MM"（本地時間，無時區），跟 chat 路徑一樣要轉成
            // 帶 +08:00 offset 的 ISO 字串，否則 Notion 會把它當成 UTC 存錯 8 小時
            if (changes.due_date) changes.due_date = toTaipeiISO(changes.due_date);
            await notion.updateRecord(params.pageId, SCHEMAS.task.toUpdateFields(changes));
            return { text: '', data: {}, actions: [] };
        }

        case 'update_shopping_field': {
            const ALLOWED_FIELDS = ['title', 'priority', 'buyer', 'location', 'category', 'notes', 'quantityNeeded', 'priceEstimate', 'due_date', 'status', 'purchase'];
            const changes = {};
            for (const key of ALLOWED_FIELDS) {
                if (params.changes?.[key] !== undefined) changes[key] = params.changes[key];
            }
            await notion.updateRecord(params.pageId, SCHEMAS.shopping.toUpdateFields(changes));
            return { text: '', data: {}, actions: [] };
        }

        case 'persona_monthly_summary': {
            const markdown = persona.loadPersona();
            return { text: format.formatPersonaSummary(markdown), data: {}, actions: [] };
        }

        case 'web_search': {
            if (!params.search_query) {
                return { text: '無法完成：缺少搜尋關鍵字\n下一步：換個說法再問一次', data: {}, actions: [] };
            }
            const result = await search.webSearch(params.search_query, {
                forceRefresh: params.force_refresh,
                results: params.results
            });
            return { text: format.formatSearchResult(result), data: {}, actions: [] };
        }

        case 'persona_feedback': {
            const feedback = params.feedback;
            const raw = await ai.callLevel2(FEEDBACK_SYSTEM_PROMPT, feedback);
            const { rule, section, summary } = parseFeedbackResponse(raw);
            const { section: appliedSection, applied } = persona.applyFeedback(rule, section, summary);
            if (!applied) {
                return { text: `更新失敗：persona.md 找不到「${appliedSection}」章節，規則沒有寫入`, data: {}, actions: [] };
            }
            const fallbackNote = appliedSection !== section
                ? `（AI 指定章節「${section}」不存在，改套用「${appliedSection}」）`
                : '';
            persona.appendPersonaLog(feedback, rule, `${summary}${fallbackNote}`);
            return { text: `已更新回應風格：${summary}`, data: {}, actions: [] };
        }

        case 'check_reminders': {
            const rows = await notion.findDueReminders();
            if (rows.length === 0) {
                return { text: '', data: {}, actions: [] };
            }
            for (const r of rows) {
                const isRecurring = r.properties.Type.select?.name === '規則性';
                if (isRecurring) {
                    const icalString = (r.properties.Recurrence.rich_text || []).map(t => t.plain_text).join('');
                    // 用「這次響的那個 Next Trigger」當基準，不是拿即時的 wall-clock now——
                    // cron 每 5 分鐘才查一次，用 now 當基準在延遲情境下可能算錯下一次
                    const firedAt = new Date(r.properties['Next Trigger'].date.start);
                    const next = recurrence.computeNextOccurrence(icalString, firedAt);
                    if (next) {
                        await notion.advanceRecurrence(r.id, next.toISOString());
                    } else {
                        // 撞到 COUNT/UNTIL，這個系列已經跑完，不要留著待辦一直被抓到
                        await notion.updateRecord(r.id, { Status: { select: { name: '完成' } } });
                    }
                } else {
                    // 一次性任務可能設了不只一筆提前通知（預設 24小時前+1小時前）：這次觸發的
                    // 是哪一個 offset，靠「到期時間 - 這次的 Next Trigger」反推，比它更接近到期
                    // 的 offset 才是還沒發過的，挑最快到的當下一個；都發完了才真的清空 Next Trigger
                    const dueDateStr = r.properties['Due Date'].date?.start;
                    const firedTrigger = r.properties['Next Trigger'].date.start;
                    let nextReminder = null;
                    if (dueDateStr) {
                        const anchor = new Date(dueDateStr);
                        const fired = new Date(firedTrigger);
                        const firedOffsetMin = Math.round((anchor.getTime() - fired.getTime()) / 60000);
                        const offsetsMinutes = offsetsFromStoredString(format.plain(r.properties['Reminder Offsets']?.rich_text));
                        const remaining = offsetsMinutes.filter(o => o < firedOffsetMin);
                        nextReminder = computeNextReminderTrigger(anchor, remaining, fired);
                    }
                    if (nextReminder) {
                        await notion.advanceRecurrence(r.id, nextReminder.trigger.toISOString());
                    } else {
                        await notion.clearReminder(r.id);
                    }
                }
            }
            return { text: format.formatReminderPush(rows), data: {}, actions: [] };
        }

        // 週期性待買模板到期時不能只是被動推播（那是上面 check_reminders 的做法）——
        // 要能收使用者回覆的購買明細，或讓使用者回覆「跳過」略過這次、不影響下次繼續提醒。
        // 一次只處理一筆（避免同時到期時互相蓋掉彼此的 pending 狀態），其餘留到下次排程再抓，
        // 不會漏（Next Trigger 還沒推進，下次查詢還是會抓到）。
        case 'check_shopping_reminders': {
            const nowISO = new Date().toISOString();
            const rows = await notion.queryDb(SCHEMAS.shopping.dbKey, {
                and: [
                    { property: 'Type', select: { equals: '週期性' } },
                    { property: 'Next Trigger', date: { on_or_before: nowISO } }
                ]
            });

            // 一次性項目的到期提醒是被動推播（跟 check_reminders 對 Task 的一次性分支同一套
            // 邏輯：反推剩餘的 offset、推進或清空 Next Trigger），不用等使用者回覆，可以一次
            // 處理完所有到期的；週期性模板才需要互動式確認，維持原本一次只處理一筆的做法。
            const oneTimeRows = await notion.queryDb(SCHEMAS.shopping.dbKey, {
                and: [
                    { property: 'Type', select: { equals: '單次' } },
                    { property: 'Status', select: { equals: '待購' } },
                    { property: 'Next Trigger', date: { on_or_before: nowISO } }
                ]
            });
            const oneTimePushLines = [];
            for (const oneTimeRow of oneTimeRows) {
                const dueDateStr = oneTimeRow.properties['Due Date']?.date?.start;
                const firedTrigger = oneTimeRow.properties['Next Trigger'].date.start;
                let nextReminder = null;
                if (dueDateStr) {
                    const anchor = new Date(dueDateStr);
                    const fired = new Date(firedTrigger);
                    const firedOffsetMin = Math.round((anchor.getTime() - fired.getTime()) / 60000);
                    const offsetsMinutes = offsetsFromStoredString(format.plain(oneTimeRow.properties['Reminder Offsets']?.rich_text));
                    const remaining = offsetsMinutes.filter(o => o < firedOffsetMin);
                    nextReminder = computeNextReminderTrigger(anchor, remaining, fired);
                }
                if (nextReminder) {
                    await notion.advanceRecurrence(oneTimeRow.id, nextReminder.trigger.toISOString());
                } else {
                    await notion.clearReminder(oneTimeRow.id);
                }
                const due = dueDateStr ? format.formatDateTimeShort(dueDateStr) : '未設定';
                oneTimePushLines.push(`📌 ${format.plain(oneTimeRow.properties.Item.title)}（截止：${due}）`);
            }
            const oneTimePushText = oneTimePushLines.length > 0
                ? ['⏰ 待買提醒', '', ...oneTimePushLines].join('\n')
                : '';

            if (rows.length === 0) {
                return { text: oneTimePushText, data: {}, actions: [] };
            }
            const r = rows[0];
            const title = format.plain(r.properties.Item.title);
            const buyer = format.plain(r.properties.Buyer.rich_text) || '我自己';
            const location = format.plain(r.properties.Location.rich_text) || null;
            const priority = r.properties.Priority.select?.name || '一般';
            const notes = format.plain(r.properties.Notes.rich_text) || null;
            // icalString/firedAt 放進回傳的 data，讓呼叫端（server.js）不用重新查一次 Notion
            // 就能算出下一次觸發時間（跟 check_reminders 算 task 下一次的邏輯一致）
            const icalString = (r.properties.Recurrence.rich_text || []).map(t => t.plain_text).join('');
            const firedAt = r.properties['Next Trigger'].date.start;
            const occurrenceAtStr = r.properties['Occurrence At']?.date?.start;
            const reminderOffsetsStored = format.plain(r.properties['Reminder Offsets']?.rich_text);
            const moreText = rows.length > 1 ? `（還有 ${rows.length - 1} 筆到期，處理完這筆後下次排程會再提醒）` : '';

            // 提前通知：這次的 Next Trigger 比真正該買的 Occurrence At 早，代表只是被動 FYI，
            // 不用進互動流程——直接推進到下一個提醒點（或都發完了就等於 Occurrence At 本身）
            const isAdvanceNotice = occurrenceAtStr && new Date(firedAt) < new Date(occurrenceAtStr);
            if (isAdvanceNotice) {
                const occurrenceAt = new Date(occurrenceAtStr);
                const fired = new Date(firedAt);
                const firedOffsetMin = Math.round((occurrenceAt.getTime() - fired.getTime()) / 60000);
                const remaining = offsetsFromStoredString(reminderOffsetsStored).filter(o => o < firedOffsetMin);
                const nextReminder = computeNextReminderTrigger(occurrenceAt, remaining, fired);
                await notion.advanceRecurrence(r.id, nextReminder ? nextReminder.trigger.toISOString() : occurrenceAtStr);
                const advanceNoticeText = `🔔 ${title}快到期了（${format.formatDateTimeShort(occurrenceAtStr)} 該買）。${moreText}`;
                return {
                    text: oneTimePushText ? `${oneTimePushText}\n\n${advanceNoticeText}` : advanceNoticeText,
                    data: {}, actions: []
                };
            }

            // 2026-07-09：互動確認改成 Telegram WebApp 按鈕，不再靠等文字回覆——這裡只回傳
            // 結構化資料，實際推播（帶 inline keyboard）由 server.js 用 tg-bridge 自己的 bot
            // 直接送（比照 /ask 既有模式：互動式回覆留在 tg-bridge，不透過共用的
            // notification-gateway，因為它目前不支援 reply_markup）。text 只保留
            // oneTimePushText，避免跟 server.js 直接送的訊息重複。
            return {
                text: oneTimePushText,
                data: {
                    recurringConfirm: {
                        templateId: r.id,
                        itemTitle: title,
                        priority,
                        buyer,
                        location,
                        notes,
                        icalString,
                        firedAt,
                        reminderOffsets: reminderOffsetsStored,
                        moreText
                    }
                },
                actions: []
            };
        }

        case 'skill_route':
            throw new NotImplementedError('skill_route 尚未實作（Phase 2+）');

        case 'unknown':
        default:
            return {
                text: '無法確定你的意圖，可以換個說法，或告訴我你想記錄點子/任務/購物，還是想查詢？',
                data: {},
                actions: []
            };
    }
}

module.exports = {
    handleIntent, resolveRecordSelection, NotImplementedError,
    // 內部輔助函式，額外 export 只是為了讓自動化測試能直接單元測試
    resolveScope, toTaipeiISO
};
