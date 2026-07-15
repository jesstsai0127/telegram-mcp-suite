const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMAS } = require('../lib/db-schemas');

test('task.toCreateFields: 單次任務不帶 due_date', () => {
    const fields = SCHEMAS.task.toCreateFields({ title: '買菜' });
    assert.equal(fields.Type.select.name, '單次');
    assert.equal(fields.Status.select.name, '待辦');
    assert.equal(fields.Title.title[0].text.content, '買菜');
    assert.equal(fields['Due Date'], undefined);
});

test('task.toCreateFields: 帶 priority/notes 時寫入 Priority/Notes', () => {
    const fields = SCHEMAS.task.toCreateFields({ title: '交報告', priority: '高', notes: '記得帶隨身碟' });
    assert.equal(fields.Priority.select.name, '高');
    assert.equal(fields.Notes.rich_text[0].text.content, '記得帶隨身碟');
});

test('task.toCreateFields: 沒給 priority/notes 就不寫入這兩個欄位', () => {
    const fields = SCHEMAS.task.toCreateFields({ title: '買菜' });
    assert.equal(fields.Priority, undefined);
    assert.equal(fields.Notes, undefined);
});

test('task.toUpdateFields: 可以修改 notes', () => {
    const fields = SCHEMAS.task.toUpdateFields({ notes: '新的備註' });
    assert.equal(fields.Notes.rich_text[0].text.content, '新的備註');
});

test('task.toCreateFields: 沒給 category 預設「一般」，給了就照填', () => {
    const f1 = SCHEMAS.task.toCreateFields({ title: '買菜' });
    assert.equal(f1.Category.select.name, '一般');
    const f2 = SCHEMAS.task.toCreateFields({ title: '交報告', category: '工作' });
    assert.equal(f2.Category.select.name, '工作');
});

test('task.toUpdateFields: 可以修改 category', () => {
    const fields = SCHEMAS.task.toUpdateFields({ category: '興趣' });
    assert.equal(fields.Category.select.name, '興趣');
});

test('task.toCreateFields: 單次任務帶 due_date 跟 next_trigger', () => {
    const fields = SCHEMAS.task.toCreateFields({ title: '開會', due_date: '2026-07-05T15:00:00+08:00', next_trigger: '2026-07-05T14:00:00.000Z' });
    assert.equal(fields['Due Date'].date.start, '2026-07-05T15:00:00+08:00');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-05T14:00:00.000Z');
});

test('task.toCreateFields: 帶 reminderOffsets 時寫入 Reminder Offsets 欄位', () => {
    const fields = SCHEMAS.task.toCreateFields({
        title: '交報告', due_date: '2026-07-05T15:00:00+08:00', next_trigger: '2026-07-04T15:00:00.000Z', reminderOffsets: '1440,60'
    });
    assert.equal(fields['Reminder Offsets'].rich_text[0].text.content, '1440,60');
});

test('task.toUpdateFields: 可以單獨改 reminderOffsets/next_trigger（提醒排程推進用）', () => {
    const fields = SCHEMAS.task.toUpdateFields({ reminderOffsets: '60', next_trigger: '2026-07-10T11:00:00.000Z' });
    assert.equal(fields['Reminder Offsets'].rich_text[0].text.content, '60');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-10T11:00:00.000Z');
});

test('task.toCreateFields: 規則性任務不寫 Due Date，寫 Recurrence', () => {
    const fields = SCHEMAS.task.toCreateFields({
        title: '運動', recurring: { icalString: 'DTSTART:...\nRRULE:FREQ=DAILY', firstTrigger: '2026-07-05T01:00:00.000Z' }
    });
    assert.equal(fields.Type.select.name, '規則性');
    assert.equal(fields.Recurrence.rich_text[0].text.content, 'DTSTART:...\nRRULE:FREQ=DAILY');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-05T01:00:00.000Z');
    assert.equal(fields['Due Date'], undefined);
});

test('task.toUpdateFields: 改 due_date 連帶清空 Next Trigger', () => {
    const fields = SCHEMAS.task.toUpdateFields({ due_date: '2026-07-10' });
    assert.equal(fields['Due Date'].date.start, '2026-07-10');
    assert.equal(fields['Next Trigger'].date, null);
});

test('task.toUpdateFields: due_date 為 null 時清空 Due Date', () => {
    const fields = SCHEMAS.task.toUpdateFields({ due_date: null });
    assert.equal(fields['Due Date'].date, null);
});

test('task.toUpdateFields: 修改整條週期規則會寫 Recurrence/Next Trigger 並把 Type 標成規則性', () => {
    const fields = SCHEMAS.task.toUpdateFields({
        recurring: { icalString: 'DTSTART:...\nRRULE:FREQ=WEEKLY', firstTrigger: '2026-07-13T01:00:00.000Z' }
    });
    assert.equal(fields.Type.select.name, '規則性');
    assert.equal(fields.Recurrence.rich_text[0].text.content, 'DTSTART:...\nRRULE:FREQ=WEEKLY');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-13T01:00:00.000Z');
});

test('task.toUpdateFields: 只給 priority 不動 Title/Due Date', () => {
    const fields = SCHEMAS.task.toUpdateFields({ priority: '高' });
    assert.equal(fields.Priority.select.name, '高');
    assert.equal(fields.Title, undefined);
    assert.equal(fields['Due Date'], undefined);
});

test('task.toUpdateFields: status=完成 順便寫入 Completed Date；status=取消/其他值不寫', () => {
    const done = SCHEMAS.task.toUpdateFields({ status: '完成' });
    assert.equal(done.Status.select.name, '完成');
    assert.ok(done['Completed Date'].date.start);

    const cancelled = SCHEMAS.task.toUpdateFields({ status: '取消' });
    assert.equal(cancelled['Completed Date'], undefined);
});

test('shopping.toCreateFields: 預設 priority 為一般', () => {
    const fields = SCHEMAS.shopping.toCreateFields({ title: '衛生紙' });
    assert.equal(fields.Priority.select.name, '一般');
    assert.equal(fields.Status.select.name, '待購');
});

test('shopping.toUpdateFields: title 對應到 Item 欄位', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({ title: '洗衣精' });
    assert.equal(fields.Item.title[0].text.content, '洗衣精');
});

test('shopping.toCreateFields: 沒給 category 預設「一般」，給了就照填', () => {
    const f1 = SCHEMAS.shopping.toCreateFields({ title: '衛生紙' });
    assert.equal(f1.Category.select.name, '一般');
    const f2 = SCHEMAS.shopping.toCreateFields({ title: '牙膏', category: '日常用品' });
    assert.equal(f2.Category.select.name, '日常用品');
});

test('shopping.toUpdateFields: 可以修改 category', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({ category: '興趣' });
    assert.equal(fields.Category.select.name, '興趣');
});

test('idea.toCreateFields: content 缺省時寫空字串', () => {
    const fields = SCHEMAS.idea.toCreateFields({ title: '一個點子' });
    assert.equal(fields.Content.rich_text[0].text.content, '');
    assert.equal(fields.Status.select.name, '新增');
    assert.equal(fields.Source.select.name, 'Telegram');
});

test('project：沒有 toCreateFields/toUpdateFields（由 setup script 建立，不透過聊天新增/修改）', () => {
    assert.equal(SCHEMAS.project.toCreateFields, undefined);
    assert.equal(SCHEMAS.project.toUpdateFields, undefined);
});

test('hasDueDate: task/shopping 是 true（兩者的一次性項目都有到期日概念），idea 沒有', () => {
    assert.equal(SCHEMAS.task.hasDueDate, true);
    assert.equal(SCHEMAS.shopping.hasDueDate, true);
    assert.equal(SCHEMAS.idea.hasDueDate, undefined);
});

test('health.toCreateFields: Title 是日期，沒給 date 就用今天，預設 Status 為普通', () => {
    const fields = SCHEMAS.health.toCreateFields({ symptoms: '拉肚子' });
    assert.match(fields.Date.title[0].text.content, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(fields.Status.select.name, '普通');
    assert.equal(fields.Symptoms.rich_text[0].text.content, '拉肚子');
    assert.equal(fields['Energy Level'], undefined);
});

test('health.toCreateFields: 給了 date/status/energy_level/sleep_hours 都正確帶入', () => {
    const fields = SCHEMAS.health.toCreateFields({
        date: '2026-07-06', status: '不適', energy_level: '低', sleep_hours: 6
    });
    assert.equal(fields.Date.title[0].text.content, '2026-07-06');
    assert.equal(fields.Status.select.name, '不適');
    assert.equal(fields['Energy Level'].select.name, '低');
    assert.equal(fields['Sleep Hours'].number, 6);
});

test('diet.toCreateFields: 沒給 date 就用今天，預設 Meal Type 為點心', () => {
    const fields = SCHEMAS.diet.toCreateFields({ title: '牛肉麵' });
    assert.equal(fields.Title.title[0].text.content, '牛肉麵');
    assert.equal(fields['Meal Type'].select.name, '點心');
    assert.match(fields.Date.date.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(fields.Calories, undefined);
});

test('diet.toCreateFields: 給了 meal_type/calories 都正確帶入', () => {
    const fields = SCHEMAS.diet.toCreateFields({ title: '牛肉麵', meal_type: '午餐', calories: 650 });
    assert.equal(fields['Meal Type'].select.name, '午餐');
    assert.equal(fields.Calories.number, 650);
});

test('activity.toCreateFields: 沒給 duration 預設 0，預設 Type 為運動', () => {
    const fields = SCHEMAS.activity.toCreateFields({ title: '跑步' });
    assert.equal(fields.Type.select.name, '運動');
    assert.equal(fields.Duration.number, 0);
});

test('activity.toCreateFields: 給了 type/duration/intensity 都正確帶入', () => {
    const fields = SCHEMAS.activity.toCreateFields({ title: '跑步', type: '運動', duration: 30, intensity: '中' });
    assert.equal(fields.Duration.number, 30);
    assert.equal(fields.Intensity.select.name, '中');
});

test('shopping.toCreateFields: 一次性項目，buyer 沒填預設「我自己」', () => {
    const fields = SCHEMAS.shopping.toCreateFields({ title: '衛生紙', priority: '一般' });
    assert.equal(fields.Type.select.name, '單次');
    assert.equal(fields.Buyer.rich_text[0].text.content, '我自己');
    assert.equal(fields.Item.title[0].text.content, '衛生紙');
});

test('shopping.toCreateFields: 帶 buyer/location/quantity/price/notes', () => {
    const fields = SCHEMAS.shopping.toCreateFields({
        title: '洗衣精', priority: '急需', buyer: '室友', location: '全聯',
        quantityNeeded: 2, priceEstimate: 150, notes: '大罐裝'
    });
    assert.equal(fields.Buyer.rich_text[0].text.content, '室友');
    assert.equal(fields.Location.rich_text[0].text.content, '全聯');
    assert.equal(fields['Quantity Needed'].number, 2);
    assert.equal(fields['Price Estimate'].number, 150);
    assert.equal(fields.Notes.rich_text[0].text.content, '大罐裝');
});

test('shopping.toCreateFields: 週期性模板寫 Recurrence/Next Trigger，不寫 Due Date 概念的欄位', () => {
    const fields = SCHEMAS.shopping.toCreateFields({
        title: '衛生紙', recurring: { icalString: 'DTSTART:...\nRRULE:FREQ=MONTHLY', firstTrigger: '2026-08-01T01:00:00.000Z' }
    });
    assert.equal(fields.Type.select.name, '週期性');
    assert.equal(fields.Recurrence.rich_text[0].text.content, 'DTSTART:...\nRRULE:FREQ=MONTHLY');
    assert.equal(fields['Next Trigger'].date.start, '2026-08-01T01:00:00.000Z');
    // 沒給 nextTrigger 時，Occurrence At 跟 Next Trigger 一樣都是 firstTrigger（沒有提前通知可排）
    assert.equal(fields['Occurrence At'].date.start, '2026-08-01T01:00:00.000Z');
});

test('shopping.toCreateFields: 週期性模板有提前通知時，Next Trigger 跟 Occurrence At 分開', () => {
    const fields = SCHEMAS.shopping.toCreateFields({
        title: '衛生紙', reminderOffsets: '1440,60',
        recurring: {
            icalString: 'DTSTART:...\nRRULE:FREQ=MONTHLY',
            firstTrigger: '2026-08-01T01:00:00.000Z', // 真正到期時刻
            nextTrigger: '2026-07-31T01:00:00.000Z' // 24小時前的提前通知
        }
    });
    assert.equal(fields['Occurrence At'].date.start, '2026-08-01T01:00:00.000Z');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-31T01:00:00.000Z');
    assert.equal(fields['Reminder Offsets'].rich_text[0].text.content, '1440,60');
});

test('shopping.toUpdateFields: 單獨推進 nextTrigger/occurrenceAt（提醒排程推進用，不用整個 recurring 物件）', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({ nextTrigger: '2026-08-01T00:00:00.000Z', occurrenceAt: '2026-08-01T01:00:00.000Z' });
    assert.equal(fields['Next Trigger'].date.start, '2026-08-01T00:00:00.000Z');
    assert.equal(fields['Occurrence At'].date.start, '2026-08-01T01:00:00.000Z');
});

test('shopping.toUpdateFields: 標記已購買一次寫入 Status/數量/金額/日期', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({
        purchase: { quantityPurchased: 3, actualPrice: 180, purchasedDate: '2026-07-06' }
    });
    assert.equal(fields.Status.select.name, '已購');
    assert.equal(fields['Quantity Purchased'].number, 3);
    assert.equal(fields['Actual Price'].number, 180);
    assert.equal(fields['Purchased Date'].date.start, '2026-07-06');
});

test('shopping.toUpdateFields: 修改週期規則會把 Type 標成週期性', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({
        recurring: { icalString: 'DTSTART:...\nRRULE:FREQ=WEEKLY', firstTrigger: '2026-07-13T01:00:00.000Z' }
    });
    assert.equal(fields.Type.select.name, '週期性');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-13T01:00:00.000Z');
});

test('shopping.toCreateFields: 一次性項目有 due_date 時寫入 Due Date/Next Trigger/Reminder Offsets', () => {
    const fields = SCHEMAS.shopping.toCreateFields({
        title: 'sim卡', due_date: '2026-07-15T09:00:00+08:00', next_trigger: '2026-07-14T09:00:00+08:00',
        reminderOffsets: '1440'
    });
    assert.equal(fields.Type.select.name, '單次');
    assert.equal(fields['Due Date'].date.start, '2026-07-15T09:00:00+08:00');
    assert.equal(fields['Next Trigger'].date.start, '2026-07-14T09:00:00+08:00');
    assert.equal(fields['Reminder Offsets'].rich_text[0].text.content, '1440');
});

test('shopping.toCreateFields: 一次性項目沒有 due_date 時完全不寫這三個欄位（單純想買，沒有時間壓力）', () => {
    const fields = SCHEMAS.shopping.toCreateFields({ title: '衛生紙' });
    assert.equal(fields['Due Date'], undefined);
    assert.equal(fields['Next Trigger'], undefined);
    assert.equal(fields['Reminder Offsets'], undefined);
});

test('shopping.toUpdateFields: 修改 due_date 會同時清空 Next Trigger（舊的提醒基準已經失效）', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({ due_date: '2026-07-20T09:00:00+08:00' });
    assert.equal(fields['Due Date'].date.start, '2026-07-20T09:00:00+08:00');
    assert.equal(fields['Next Trigger'].date, null);
});

test('shopping.toUpdateFields: due_date 設為 null（清除到期日）', () => {
    const fields = SCHEMAS.shopping.toUpdateFields({ due_date: null });
    assert.equal(fields['Due Date'].date, null);
});
