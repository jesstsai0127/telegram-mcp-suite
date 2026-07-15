const test = require('node:test');
const assert = require('node:assert/strict');
const intent = require('../lib/intent');
const {
    tryParseShoppingOnce, tryParseShoppingRecurring, tryParseShoppingPurchase,
    tryParseShoppingRecurringConfirm, isSkipReply, isCancelSeriesReply
} = intent;

// 2026-07-09：/shopping 的按鈕跟週期性推播互動確認都改成 Telegram WebApp（比照 /todo），
// 下面這批窄範圍分類函式暫時保留（intent.js 還沒清掉，等真機驗證過 WebApp 流程後才會拿掉），
// 這裡的測試維持不動，純粹確保還沒被清掉的程式碼行為不變。

test('tryParseShoppingOnce: extracts title/priority/buyer/location/quantity/price/notes', () => {
    const result = tryParseShoppingOnce(
        '{"title": "洗衣精", "priority": "急需", "buyer": "室友", "location": "全聯", "quantity_needed": 2, "price_estimate": 150, "notes": null}',
        '急需買洗衣精，2瓶，全聯，大概150元，請室友幫忙買'
    );
    assert.deepEqual(result, {
        title: '洗衣精', priority: '急需', buyer: '室友', location: '全聯', category: null,
        quantityNeeded: 2, priceEstimate: 150, due_date: null, reminders: null, notes: null
    });
});

test('tryParseShoppingOnce: 沒提到的欄位都是 null（不是呼叫端補預設值，那是 db-schemas 的責任）', () => {
    const result = tryParseShoppingOnce(
        '{"title": "牙膏", "priority": null, "buyer": null, "location": null, "quantity_needed": null, "price_estimate": null, "notes": null}',
        '要買牙膏'
    );
    assert.equal(result.priority, null);
    assert.equal(result.buyer, null);
});

test('tryParseShoppingOnce: 可以抽取 due_date/reminders（出國前買 sim 卡這類有時間壓力的一次性項目）', () => {
    const result = tryParseShoppingOnce(
        '{"title": "sim卡", "priority": null, "buyer": null, "location": null, "quantity_needed": null, "price_estimate": null, "due_date": "2026-07-15", "reminders": ["1天前"], "notes": null}',
        '這個月底出國前要買好sim卡，提前一天提醒我'
    );
    assert.equal(result.due_date, '2026-07-15');
    assert.deepEqual(result.reminders, ['1天前']);
});

test('tryParseShoppingOnce: 沒提到到期日時 due_date/reminders 都是 null', () => {
    const result = tryParseShoppingOnce(
        '{"title": "衛生紙", "priority": null, "buyer": null, "location": null, "quantity_needed": null, "price_estimate": null, "due_date": null, "reminders": null, "notes": null}',
        '要買衛生紙'
    );
    assert.equal(result.due_date, null);
    assert.equal(result.reminders, null);
});

test('tryParseShoppingOnce: 拒絕沒出現在原文的範例 echo', () => {
    const result = tryParseShoppingOnce(
        '{"title": "衛生紙", "priority": null, "buyer": null, "location": null, "quantity_needed": null, "price_estimate": null, "notes": null}',
        '隨便打的訊息'
    );
    assert.equal(result, null);
});

test('tryParseShoppingRecurring: extracts title + valid recurrence', () => {
    const result = tryParseShoppingRecurring(
        '{"title": "衛生紙", "priority": null, "buyer": null, "location": null, "quantity_needed": null, "price_estimate": null, "notes": null, "reminders": null, "recurrence": {"freq": "monthly", "bymonthday": 1, "time": "09:00"}}',
        '每個月要買衛生紙'
    );
    assert.equal(result.title, '衛生紙');
    assert.equal(result.recurrence.freq, 'monthly');
    assert.equal(result.reminders, null);
});

test('tryParseShoppingRecurring: 可以抽取提前通知清單', () => {
    const result = tryParseShoppingRecurring(
        '{"title": "衛生紙", "reminders": ["1天前", "1小時前"], "recurrence": {"freq": "monthly", "bymonthday": 1, "time": "09:00"}}',
        '每個月要買衛生紙，提前一天跟一小時通知我'
    );
    assert.deepEqual(result.reminders, ['1天前', '1小時前']);
});

test('tryParseShoppingRecurring: 無效的 recurrence 回傳 null', () => {
    const result = tryParseShoppingRecurring(
        '{"title": "衛生紙", "recurrence": {"freq": "biweekly"}}',
        '隨便'
    );
    assert.equal(result, null);
});

test('tryParseShoppingPurchase: 月份必填，抽不到日期視為失敗', () => {
    const result = tryParseShoppingPurchase(
        '{"title_hint": "洗衣精", "quantity_purchased": null, "actual_price": null, "purchased_date": null}',
        '洗衣精買了'
    );
    assert.equal(result, null);
});

test('tryParseShoppingPurchase: 完整購買明細正確解析', () => {
    const result = tryParseShoppingPurchase(
        '{"title_hint": "衛生紙", "quantity_purchased": 2, "actual_price": 120, "purchased_date": "2026-07-06"}',
        '衛生紙買了，2包，花了120'
    );
    assert.deepEqual(result, {
        title_hint: '衛生紙', quantity_purchased: 2, actual_price: 120, purchased_date: '2026-07-06'
    });
});

test('isSkipReply: 認得常見的跳過用語', () => {
    assert.equal(isSkipReply('跳過'), true);
    assert.equal(isSkipReply('這次不用'), true);
    assert.equal(isSkipReply('略過這次'), true);
    assert.equal(isSkipReply('買了3包'), false);
});

test('tryParseShoppingRecurringConfirm: 購買明細正確解析（不需要 title_hint）', () => {
    const result = tryParseShoppingRecurringConfirm(
        '{"quantity_purchased": 3, "actual_price": 100, "purchased_date": "2026-07-06", "buyer": null, "notes": null}'
    );
    assert.deepEqual(result, { quantity_purchased: 3, actual_price: 100, purchased_date: '2026-07-06', buyer: null, notes: null });
});

test('tryParseShoppingRecurringConfirm: 有提到這次是誰買的，正確抽取 buyer 覆寫值', () => {
    const result = tryParseShoppingRecurringConfirm(
        '{"quantity_purchased": 2, "actual_price": 80, "purchased_date": "2026-07-06", "buyer": "室友", "notes": null}'
    );
    assert.equal(result.buyer, '室友');
});

test('tryParseShoppingRecurringConfirm: 沒有 purchased_date 視為失敗', () => {
    const result = tryParseShoppingRecurringConfirm('{"quantity_purchased": 3, "actual_price": 100, "purchased_date": null}');
    assert.equal(result, null);
});

test('isCancelSeriesReply: 認得「取消整個週期」類的用語，跟單純跳過這次分開', () => {
    assert.equal(isCancelSeriesReply('取消'), true);
    assert.equal(isCancelSeriesReply('以後都不用了'), true);
    assert.equal(isCancelSeriesReply('不用再提醒了'), true);
    assert.equal(isCancelSeriesReply('跳過'), false);
    assert.equal(isCancelSeriesReply('這次不用'), false);
});

test('classifyShoppingRecurringConfirm: 「取消」類用語不叫 AI，直接回傳 cancelSeries', async () => {
    const result = await intent.classifyShoppingRecurringConfirm('以後都不用買了');
    assert.deepEqual(result, { skip: true, cancelSeries: true });
});

test('classifyShoppingRecurringConfirm: 單純「跳過」不會被誤判成取消整個週期', async () => {
    const result = await intent.classifyShoppingRecurringConfirm('跳過');
    assert.deepEqual(result, { skip: true, cancelSeries: false });
});

// --- router.js check_shopping_reminders 測試（mock notion） ---
const notion = require('../lib/notion');
const router = require('../lib/router');

function fakeShoppingTemplateRow(id, item, nextTriggerISO, { occurrenceAtISO, reminderOffsets } = {}) {
    return {
        id,
        properties: {
            Item: { title: [{ plain_text: item }] },
            Buyer: { rich_text: [{ plain_text: '我自己' }] },
            Location: { rich_text: [] },
            Notes: { rich_text: [] },
            Priority: { select: { name: '一般' } },
            Recurrence: { rich_text: [{ plain_text: 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY' }] },
            'Next Trigger': { date: { start: nextTriggerISO } },
            'Occurrence At': { date: occurrenceAtISO ? { start: occurrenceAtISO } : null },
            'Reminder Offsets': { rich_text: reminderOffsets ? [{ plain_text: reminderOffsets }] : [] }
        }
    };
}

// check_shopping_reminders 現在會查兩次（週期性模板 + 一次性到期項目），這裡的 mock
// 只準備週期性模板的假資料，靠 filter 裡的 Type 值判斷這次是哪個查詢，一次性查詢一律
// 回傳空陣列——一次性項目的獨立測試在下面「一次性項目到期提醒」區塊
function mockRecurringOnly(t, recurringRows) {
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        const isOneTimeQuery = JSON.stringify(filter).includes('"單次"');
        return isOneTimeQuery ? [] : recurringRows;
    });
}

test('check_shopping_reminders: 沒有到期項目回傳空字串', async (t) => {
    mockRecurringOnly(t, []);
    const result = await router.handleIntent('check_shopping_reminders', {}, {});
    assert.equal(result.text, '');
});

// 2026-07-09：互動確認改成 WebApp 按鈕——不再靠 pendingSelection 等文字回覆，check_shopping_reminders
// 只回傳 data.recurringConfirm 這個結構化欄位，真正推播（帶 inline keyboard）交給 server.js
test('check_shopping_reminders: 一筆到期，text 只有 oneTimePushText（空），data.recurringConfirm 帶齊模板資訊', async (t) => {
    mockRecurringOnly(t, [fakeShoppingTemplateRow('p1', '衛生紙', '2026-07-01T01:00:00.000Z')]);
    const result = await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-shopping-reminder-chat' });
    assert.equal(result.text, '');
    assert.equal(result.data.recurringConfirm.templateId, 'p1');
    assert.equal(result.data.recurringConfirm.itemTitle, '衛生紙');
    assert.equal(result.data.recurringConfirm.icalString, 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY');
    assert.equal(result.data.recurringConfirm.firedAt, '2026-07-01T01:00:00.000Z');
});

test('check_shopping_reminders: Next Trigger 比 Occurrence At 早，代表是提前通知，只是被動推播不進互動流程', async (t) => {
    mockRecurringOnly(t, [
        fakeShoppingTemplateRow('p1', '衛生紙', '2026-07-31T01:00:00.000Z', {
            occurrenceAtISO: '2026-08-01T01:00:00.000Z', reminderOffsets: '1440,60'
        })
    ]);
    let advancedTo = null;
    t.mock.method(notion, 'advanceRecurrence', async (pageId, nextISO) => { advancedTo = { pageId, nextISO }; });
    const result = await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-advance-notice-chat' });
    assert.match(result.text, /衛生紙快到期了/);
    assert.deepEqual(result.data, {}); // 不是互動流程，不帶 recurringConfirm
    // 觸發的是 24小時前那筆，還有 1小時前沒發過，應該推進到 2026-08-01T00:00（1小時前）
    assert.equal(advancedTo.pageId, 'p1');
    assert.equal(advancedTo.nextISO, '2026-08-01T00:00:00.000Z');
});

test('check_shopping_reminders: 提前通知都發完了（觸發的就是最後一筆），Next Trigger 直接等於 Occurrence At', async (t) => {
    mockRecurringOnly(t, [
        fakeShoppingTemplateRow('p2', '洗手乳', '2026-08-01T00:00:00.000Z', {
            occurrenceAtISO: '2026-08-01T01:00:00.000Z', reminderOffsets: '1440,60'
        })
    ]);
    let advancedTo = null;
    t.mock.method(notion, 'advanceRecurrence', async (pageId, nextISO) => { advancedTo = { pageId, nextISO }; });
    await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-advance-notice-chat-2' });
    assert.equal(advancedTo.nextISO, '2026-08-01T01:00:00.000Z'); // 等於 Occurrence At，下次查詢就會走真正到期的互動流程
});

test('check_shopping_reminders: Next Trigger 等於 Occurrence At（真正到期），回傳 recurringConfirm 並帶上 reminderOffsets 供之後推進用', async (t) => {
    mockRecurringOnly(t, [
        fakeShoppingTemplateRow('p3', '牙膏', '2026-08-01T01:00:00.000Z', {
            occurrenceAtISO: '2026-08-01T01:00:00.000Z', reminderOffsets: '1440,60'
        })
    ]);
    const result = await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-real-occurrence-chat' });
    assert.equal(result.data.recurringConfirm.itemTitle, '牙膏');
    assert.equal(result.data.recurringConfirm.reminderOffsets, '1440,60');
});

test('check_shopping_reminders: 多筆到期時只處理第一筆，data.recurringConfirm.moreText 提到還有幾筆', async (t) => {
    mockRecurringOnly(t, [
        fakeShoppingTemplateRow('p1', '衛生紙', '2026-07-01T01:00:00.000Z'),
        fakeShoppingTemplateRow('p2', '洗衣精', '2026-07-01T01:00:00.000Z')
    ]);
    const result = await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-shopping-reminder-chat-2' });
    assert.equal(result.data.recurringConfirm.itemTitle, '衛生紙');
    assert.match(result.data.recurringConfirm.moreText, /還有 1 筆到期/);
});

// --- check_shopping_reminders：一次性項目到期提醒（被動推播，不進互動流程） ---
function fakeShoppingOneTimeRow(id, item, dueDateISO, nextTriggerISO, reminderOffsets) {
    return {
        id,
        properties: {
            Item: { title: [{ plain_text: item }] },
            'Due Date': { date: { start: dueDateISO } },
            'Next Trigger': { date: { start: nextTriggerISO } },
            'Reminder Offsets': { rich_text: reminderOffsets ? [{ plain_text: reminderOffsets }] : [] }
        }
    };
}

test('check_shopping_reminders: 一次性項目到期，被動推播且不進互動流程，一次可以處理多筆', async (t) => {
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        const isOneTimeQuery = JSON.stringify(filter).includes('"單次"');
        if (!isOneTimeQuery) return [];
        return [
            fakeShoppingOneTimeRow('s1', 'sim卡', '2026-07-15T09:00:00.000Z', '2026-07-14T09:00:00.000Z', '1440'),
            fakeShoppingOneTimeRow('s2', '防曬乳', '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z', '')
        ];
    });
    const advanced = [];
    const cleared = [];
    t.mock.method(notion, 'advanceRecurrence', async (pageId, nextISO) => { advanced.push({ pageId, nextISO }); });
    t.mock.method(notion, 'clearReminder', async (pageId) => { cleared.push(pageId); });
    const result = await router.handleIntent('check_shopping_reminders', {}, { chat_id: 'test-onetime-shopping-chat' });
    assert.match(result.text, /sim卡/);
    assert.match(result.text, /防曬乳/);
    assert.deepEqual(result.data, {});
    // s1 提前1天提醒剛發完，沒有更早的 offset 了；s2 沒有 Reminder Offsets、觸發的就是到期
    // 時刻本身——兩筆都沒有更早的提醒可排，應該都直接清空 Next Trigger
    assert.deepEqual(cleared.sort(), ['s1', 's2']);
    assert.deepEqual(advanced, []);
});

// --- lib/shopping-flow.js（2026-07-09 起：兩個按鈕都是 web_app，比照 todo-flow.js 的最終形態） ---
const { resolveShoppingFlow, confirmShoppingRecurring } = require('../lib/shopping-flow');

test('menuMessage: 「新增待買」是 web_app 類型按鈕（合併了原本的一次性/週期性），網址是 HTTPS', () => {
    const menu = require('../lib/shopping-flow').menuMessage();
    const firstRow = menu.options.reply_markup.keyboard[0];
    const addButton = firstRow.find(btn => typeof btn === 'object' && btn.text === '新增待買');
    assert.ok(addButton, '找不到「新增待買」按鈕');
    assert.ok(addButton.web_app && addButton.web_app.url, 'web_app.url 沒有設定');
    assert.match(addButton.web_app.url, /^https:\/\//, 'Telegram WebApp 網址必須是 HTTPS');
});

test('menuMessage: 「待買清單」也是 web_app 類型按鈕，不再是「標記已購買」獨立按鈕', () => {
    const menu = require('../lib/shopping-flow').menuMessage();
    const firstRow = menu.options.reply_markup.keyboard[0];
    const listButton = firstRow.find(btn => typeof btn === 'object' && btn.text === '待買清單');
    assert.ok(listButton, '找不到「待買清單」按鈕');
    assert.ok(listButton.web_app && listButton.web_app.url, 'web_app.url 沒有設定');
    assert.match(listButton.web_app.url, /^https:\/\//, 'Telegram WebApp 網址必須是 HTTPS');
    const purchaseButton = firstRow.find(btn => typeof btn === 'object' && btn.text === '標記已購買');
    assert.equal(purchaseButton, undefined, '標記已購買按鈕應該已經拿掉，改成清單頁點圓圓');
});

test('resolveShoppingFlow: 兩個按鈕都是 web_app，點了不會送出文字訊息，永遠交給其他 handler（回傳 null）', async () => {
    assert.equal(await resolveShoppingFlow('sf-chat-1', '新增待買'), null);
    assert.equal(await resolveShoppingFlow('sf-chat-1', '待買清單'), null);
    assert.equal(await resolveShoppingFlow('sf-chat-1', '隨便打的訊息'), null);
});

// --- confirmShoppingRecurring：週期性推播互動確認的參數化版本，取代原本靠
// intent.classifyShoppingRecurringConfirm 解析文字的 handleRecurringConfirm ---

test('confirmShoppingRecurring: action=skip 推進到下一輪的 Occurrence At/Next Trigger，不建立購買紀錄', async (t) => {
    let updatedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { updatedFields = fields; });
    let created = false;
    t.mock.method(notion, 'createRecord', async () => { created = true; });
    const result = await confirmShoppingRecurring({
        templateId: 'tmpl-1', action: 'skip', itemTitle: '衛生紙', buyer: '我自己', location: null, priority: '一般',
        icalString: 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY', firedAt: '2026-07-01T01:00:00.000Z',
        reminderOffsets: '1440,60'
    });
    assert.match(result.text, /已跳過/);
    // 下一輪是 2026-08-01T01:00:00Z，往前推 24小時的提前通知還沒過期，Next Trigger 應該是那個時間點
    assert.equal(updatedFields['Occurrence At'].date.start, '2026-08-01T01:00:00.000Z');
    assert.equal(updatedFields['Next Trigger'].date.start, '2026-07-31T01:00:00.000Z');
    assert.equal(created, false);
});

test('confirmShoppingRecurring: action=cancelSeries 模板直接標記取消並清空 Next Trigger（避免之後又被 check_shopping_reminders 撈到再推播一次），不推進到下一輪也不建立購買紀錄', async (t) => {
    let advanced = false;
    t.mock.method(notion, 'advanceRecurrence', async () => { advanced = true; });
    let updatedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { updatedFields = fields; });
    const result = await confirmShoppingRecurring({
        templateId: 'tmpl-3', action: 'cancelSeries', itemTitle: '衛生紙', buyer: '我自己', location: null,
        priority: '一般', notes: null,
        icalString: 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY', firedAt: '2026-07-01T01:00:00.000Z'
    });
    assert.match(result.text, /已取消「衛生紙」的週期性提醒/);
    assert.equal(advanced, false);
    assert.equal(updatedFields.Status.select.name, '取消');
    assert.equal(updatedFields['Next Trigger'].date, null);
});

test('confirmShoppingRecurring: action=purchase 覆寫這次的購買人，不影響模板預設值', async (t) => {
    t.mock.method(notion, 'updateRecord', async () => {});
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; });
    await confirmShoppingRecurring({
        templateId: 'tmpl-4', action: 'purchase', itemTitle: '衛生紙', buyer: '室友', location: null,
        priority: '一般', notes: '順便買了大罐的',
        icalString: 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY', firedAt: '2026-07-01T01:00:00.000Z',
        quantityPurchased: 2, actualPrice: 80, purchasedDate: '2026-07-06'
    });
    assert.equal(createdFields.Buyer.rich_text[0].text.content, '室友');
    assert.equal(createdFields.Notes.rich_text[0].text.content, '順便買了大罐的');
});

test('confirmShoppingRecurring: action=purchase 建立獨立購買紀錄並推進到下一輪', async (t) => {
    let updatedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { updatedFields = fields; });
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; });
    const result = await confirmShoppingRecurring({
        templateId: 'tmpl-2', action: 'purchase', itemTitle: '衛生紙', buyer: '我自己', location: null, priority: '一般',
        icalString: 'DTSTART:20260701T010000Z\nRRULE:FREQ=MONTHLY', firedAt: '2026-07-01T01:00:00.000Z',
        quantityPurchased: 3, actualPrice: 90, purchasedDate: '2026-07-06'
    });
    assert.match(result.text, /已記錄「衛生紙」的購買/);
    assert.ok(updatedFields['Occurrence At'].date.start);
    assert.equal(createdFields.Status.select.name, '已購');
    assert.equal(createdFields['Quantity Purchased'].number, 3);
    assert.equal(createdFields['Actual Price'].number, 90);
    assert.equal(createdFields['Purchased Date'].date.start, '2026-07-06');
});
