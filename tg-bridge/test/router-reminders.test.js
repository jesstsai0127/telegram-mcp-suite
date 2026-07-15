// create_record 的多筆提醒排程——Task 的一次性到期提醒（預設 24小時前+1小時前），
// Shopping 週期性模板的提前通知（Occurrence At vs Next Trigger 分開）。mock notion，不打真的 API。
const test = require('node:test');
const assert = require('node:assert/strict');
const notion = require('../lib/notion');
const router = require('../lib/router');
const settings = require('../lib/settings');

test('create_record: task 帶到期時間但沒指定提醒時，預設兩筆（24小時前+1小時前），Next Trigger 是最快到的那個', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    // 用很遠的到期時間，確保兩筆預設提醒都還沒過期
    const result = await router.handleIntent('create_record', {
        entity: 'task', title: '交報告', due_date: '2099-01-10 15:00'
    }, {});

    assert.equal(createdFields['Reminder Offsets'].rich_text[0].text.content, '1440,60');
    assert.ok(createdFields['Next Trigger'].date.start);
    // formatOffsetMinutes 把 1440 分鐘化簡成「1天前」，不是「24小時前」
    assert.match(result.text, /1天前、1小時前 提醒你/);
});

test('create_record: task 2026-07-08 真實案例——只給日期沒給時間（例如「明天提醒我跑步」），要補預設提醒時間，不能整段提醒排程被跳過', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    const result = await router.handleIntent('create_record', {
        entity: 'task', title: '跑步', due_date: '2099-01-10'
    }, {});

    assert.match(createdFields['Due Date'].date.start, /09:00/);
    assert.ok(createdFields['Next Trigger'].date.start, '沒有補時間的話這裡會是 undefined，代表完全不會提醒');
    assert.match(result.text, /提醒你/);
});

test('create_record: task 只給日期時，讀取一般設定頁面的預設提醒時間，不是寫死 09:00', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });
    t.mock.method(settings, 'getSetting', () => '20:30');

    await router.handleIntent('create_record', {
        entity: 'task', title: '跑步', due_date: '2099-01-10'
    }, {});

    assert.match(createdFields['Due Date'].date.start, /20:30/);
});

test('create_record: task 完全沒給日期時，不受預設提醒時間影響，不會被排提醒', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    await router.handleIntent('create_record', { entity: 'task', title: '想學做麵包', due_date: null }, {});

    assert.equal(createdFields['Due Date'], undefined);
    assert.equal(createdFields['Next Trigger'], undefined);
});

test('create_record: task 使用者自訂提醒清單時，覆寫預設值', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    await router.handleIntent('create_record', {
        entity: 'task', title: '交報告', due_date: '2099-01-10 15:00', reminders: ['3天前', '6小時前']
    }, {});

    assert.equal(createdFields['Reminder Offsets'].rich_text[0].text.content, `${3 * 24 * 60},${6 * 60}`);
});

test('create_record: task 到期時間已經很近，兩個預設提醒點都已經過期時，不排 Next Trigger', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    // 30 分鐘後到期——24小時前跟1小時前都已經是過去式
    const soon = new Date(Date.now() + 30 * 60000);
    const dueDateStr = `${soon.toISOString().slice(0, 10)} ${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;

    const result = await router.handleIntent('create_record', { entity: 'task', title: '緊急任務', due_date: dueDateStr }, {});
    assert.equal(createdFields['Next Trigger'], undefined);
    assert.doesNotMatch(result.text, /提醒你/);
});

test('create_record: shopping 週期性模板預設提前通知，Occurrence At 跟 Next Trigger 分開', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 'p1' }; });

    await router.handleIntent('create_record', {
        entity: 'shopping', title: '衛生紙',
        recurrence: { freq: 'yearly', bymonth: 1, bymonthday: 1, time: '09:00' }
    }, {});

    assert.ok(createdFields['Occurrence At'].date.start);
    assert.ok(createdFields['Next Trigger'].date.start);
    // 有提前通知可排的話，Next Trigger 應該早於 Occurrence At
    assert.ok(new Date(createdFields['Next Trigger'].date.start) < new Date(createdFields['Occurrence At'].date.start));
    assert.equal(createdFields['Reminder Offsets'].rich_text[0].text.content, '1440,60');
});

// 2026-07-08：Shopping 一次性項目也可能有到期日（出國前一週要買 sim 卡），跟 Task 的一次性
// 到期提醒是同一套語意/同一段程式碼路徑（generalize 自 entity==='task' 專屬判斷），
// 這裡驗證 Shopping 也能正確走完整段排程計算，不是只有 Task 能用
test('create_record: shopping 一次性項目帶到期時間，也能算出預設兩筆提醒（跟 task 同一套邏輯）', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 's1' }; });

    const result = await router.handleIntent('create_record', {
        entity: 'shopping', title: 'sim卡', due_date: '2099-01-10 15:00'
    }, {});

    assert.equal(createdFields['Reminder Offsets'].rich_text[0].text.content, '1440,60');
    assert.ok(createdFields['Next Trigger'].date.start);
    assert.match(result.text, /1天前、1小時前 提醒你/);
});

test('create_record: shopping 一次性項目只給日期沒給時間，補一般設定頁面的預設提醒時間（跟 task 同一個 bug 修正）', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 's1' }; });

    const result = await router.handleIntent('create_record', {
        entity: 'shopping', title: 'sim卡', due_date: '2099-01-10'
    }, {});

    assert.match(createdFields['Due Date'].date.start, /09:00/);
    assert.ok(createdFields['Next Trigger'].date.start, '沒有補時間的話這裡會是 undefined，代表完全不會提醒');
    assert.match(result.text, /提醒你/);
});

test('create_record: shopping 一次性項目沒有 due_date 時，不受影響，不會被排提醒（單純想買，沒有時間壓力）', async (t) => {
    let createdFields = null;
    t.mock.method(notion, 'createRecord', async (dbKey, fields) => { createdFields = fields; return { id: 's1' }; });

    await router.handleIntent('create_record', { entity: 'shopping', title: '衛生紙', due_date: null }, {});

    assert.equal(createdFields['Due Date'], undefined);
    assert.equal(createdFields['Next Trigger'], undefined);
});
