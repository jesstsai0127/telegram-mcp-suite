// /shopping 獨立技能。2026-07-09 起兩個按鈕都改成 Telegram WebApp（比照 lib/todo-flow.js
// 的最終形態）：「新增待買」合併了原本的一次性/週期性表單，「待買清單」直接開網頁，
// 標記已購買改成統一從清單頁點圓圓進入（shopping.html 本來就有 buildPurchaseForm），
// 不再需要獨立的「標記已購買」按鈕跟對話式子流程，也不再需要 pending 狀態機。
//
// 週期性項目觸發推播後的互動確認（買了/跳過/取消整個系列）也一併改成 WebApp 按鈕，
// 不再等文字回覆——confirmShoppingRecurring() 是參數化版本，取代原本靠
// intent.classifyShoppingRecurringConfirm 解析自由文字的 handleRecurringConfirm()，
// 由 server.js 的 POST /api/shopping/recurring-confirm 呼叫，欄位直接來自表單而不是 AI 猜測。

const notion = require('./notion');
const recurrence = require('./recurrence');
const { computeNextReminderTrigger, offsetsFromStoredString } = require('./reminder-offset');
const { SCHEMAS } = require('./db-schemas');

const HTTPS_PORT = process.env.TODAY_HTTPS_PORT || (Number(process.env.TODAY_PORT || 3005) + 1);
// web_app 按鈕強制要求 HTTPS，跟 todo-flow.js 同一個 HTTPS listener（同一個 todayApp）
const SHOPPING_ADD_UI_URL = process.env.SHOPPING_ADD_UI_URL ||
    `https://yyds.tailbc46d2.ts.net:${HTTPS_PORT}/shopping-add`;
const SHOPPING_LIST_UI_URL = process.env.SHOPPING_LIST_UI_URL ||
    `https://yyds.tailbc46d2.ts.net:${HTTPS_PORT}/shopping`;

const KEYBOARD_OPTIONS = {
    reply_markup: {
        keyboard: [[
            { text: '新增待買', web_app: { url: SHOPPING_ADD_UI_URL } },
            { text: '待買清單', web_app: { url: SHOPPING_LIST_UI_URL } }
        ]],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

function menuMessage() {
    return { text: '🛒 待買清單，請選擇：', options: KEYBOARD_OPTIONS };
}

// 回傳 { text } 或 null（null 代表這則訊息不是 /shopping 流程的一部分，交給其他 handler 處理）
// 兩個按鈕都是 web_app，點了是開表單/開清單頁，不會送出文字訊息，不再需要任何 pending 狀態機
async function resolveShoppingFlow() {
    return null;
}

// 週期性模板觸發推播後的確認結果——action 直接來自 WebApp 表單的按鈕選擇，不用再靠 AI
// 從文字猜測。三種結果：cancelSeries（這次也不買，以後也不用再提醒了）、skip（只跳過這次，
// 下次照常提醒）、purchase（建立一筆獨立的購買紀錄，可以順便覆寫這次的購買人/備註）。
async function confirmShoppingRecurring({
    templateId, action, itemTitle, priority, buyer, location, notes,
    icalString, firedAt, reminderOffsets, quantityPurchased, actualPrice, purchasedDate
}) {
    if (action === 'cancelSeries') {
        // 整個系列直接停掉——用 toUpdateFields 而不是自己組 fields，確保 Next Trigger
        // 也跟著清空（跟其他地方「取消時順便清空 Next Trigger」的既有慣例一致）。
        // 2026-07-09 修正：舊版這裡只寫 Status，沒清 Next Trigger，導致取消過的模板
        // 只要 Next Trigger 還留著過去的到期時間，check_shopping_reminders 之後掃描
        // 還是會撈到、再推播一次——這個 bug 是從原本的 handleRecurringConfirm 沿用過來的。
        await notion.updateRecord(templateId, SCHEMAS.shopping.toUpdateFields({ status: '取消' }));
        return { text: `已取消「${itemTitle}」的週期性提醒，之後不會再收到通知` };
    }

    // 不管跳過還是購買，都要推進模板到下一輪（跟 task 的 check_reminders 邏輯一致：
    // 觸發後一定往下一次走，差別只在跳過的話不建立購買紀錄）。下一輪的 Occurrence At
    // 算出來之後，同時要重算這一輪要不要有提前通知——跟 create_record 新建模板同一套邏輯。
    const fired = new Date(firedAt);
    const next = recurrence.computeNextOccurrence(icalString, fired);
    if (next) {
        const offsetsMinutes = offsetsFromStoredString(reminderOffsets);
        const nextReminder = computeNextReminderTrigger(next, offsetsMinutes, fired);
        await notion.updateRecord(templateId, SCHEMAS.shopping.toUpdateFields({
            occurrenceAt: next.toISOString(),
            nextTrigger: nextReminder ? nextReminder.trigger.toISOString() : next.toISOString()
        }));
    } else {
        // 撞到 COUNT/UNTIL，這個系列已經跑完
        await notion.updateRecord(templateId, { Status: { select: { name: '取消' } } });
    }

    if (action === 'skip') {
        return { text: `已跳過這次「${itemTitle}」，下次排程還是會繼續提醒` };
    }

    const fields = SCHEMAS.shopping.toCreateFields({
        title: itemTitle,
        priority,
        buyer: buyer || '我自己',
        location,
        notes: notes || null
    });
    // 這筆是「這次真的買了」的獨立購買紀錄，直接標記已購買，不是待購狀態
    fields.Status = { select: { name: '已購' } };
    if (Number.isFinite(quantityPurchased)) fields['Quantity Purchased'] = { number: quantityPurchased };
    if (Number.isFinite(actualPrice)) fields['Actual Price'] = { number: actualPrice };
    fields['Purchased Date'] = { date: { start: purchasedDate || new Date().toISOString().slice(0, 10) } };
    await notion.createRecord(SCHEMAS.shopping.dbKey, fields);

    return { text: `已記錄「${itemTitle}」的購買` };
}

module.exports = { menuMessage, resolveShoppingFlow, confirmShoppingRecurring };
