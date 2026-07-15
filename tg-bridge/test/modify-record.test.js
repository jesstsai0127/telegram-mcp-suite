// 這裡補的是之前漏掉的一層：不能只測 resolveScope/toTaipeiISO 這種底層純函式，
// 還要測 handleIntent('modify_record', ...) 這個實際使用情境本身有沒有做對——
// 這正是 2026-07-06 那個「找不到已逾期項目」的真實 bug 會被抓到的地方。
// Notion 呼叫用 t.mock 隔離，不打真實 API，但情境（含逾期資料）要貼近真實使用。

const test = require('node:test');
const assert = require('node:assert/strict');
const notion = require('../lib/notion');
const router = require('../lib/router');
const pendingSelection = require('../lib/pending-selection');

function fakeTaskRow(id, title, dueDateISO) {
    return {
        id,
        properties: {
            Title: { title: [{ plain_text: title }] },
            'Due Date': { date: dueDateISO ? { start: dueDateISO } : null }
        }
    };
}

test('modify_record: 找得到已逾期的真實任務（不會被預設日期範圍濾掉）', async (t) => {
    const overdueRow = fakeTaskRow('page-1', '到台北車站接人', '2026-07-04T11:00:00.000+08:00'); // 早於「今天」

    t.mock.method(notion, 'findRecords', async (dbKey) => {
        if (dbKey === 'Tasks') return [overdueRow];
        return []; // Shopping/Ideas 這個情境沒有東西，聚焦測 task 的逾期情況
    });

    const result = await router.handleIntent(
        'modify_record',
        { title_hint: '到台北車站接人', action: '完成', changes: {}, scope: null },
        {}
    );

    assert.match(result.text, /到台北車站接人/);
    assert.doesNotMatch(result.text, /找不到符合/);
});

test('modify_record: 真的沒有符合的紀錄時才回覆找不到', async (t) => {
    t.mock.method(notion, 'findRecords', async () => []);

    const result = await router.handleIntent(
        'modify_record',
        { title_hint: '不存在的關鍵字', action: '完成', changes: {}, scope: null },
        {}
    );

    assert.match(result.text, /找不到符合/);
});

test('modify_record: 候選跨 task/shopping/idea 三個 DB 合併，各自標註來源', async (t) => {
    t.mock.method(notion, 'findRecords', async (dbKey) => {
        if (dbKey === 'Shopping') return [{ id: 'p-shop', properties: { Item: { title: [{ plain_text: '洗衣精' }] } } }];
        if (dbKey === 'Ideas') return [{ id: 'p-idea', properties: { Title: { title: [{ plain_text: '洗衣精' }] } } }];
        return [];
    });

    const result = await router.handleIntent(
        'modify_record',
        { title_hint: '洗衣精', action: '取消', changes: {}, scope: null },
        {}
    );

    assert.match(result.text, /\[購物\] 洗衣精/);
    assert.match(result.text, /\[點子\] 洗衣精/);
});

test('resolveRecordSelection: pending type 是 todo_flow 時直接忽略（讓 /todo 流程自己處理，不誤判成候選選擇）', async () => {
    const chatId = 'test-chat-type-guard';
    pendingSelection.setPending(chatId, { type: 'todo_flow', flow: 'create_once' });

    const result = await router.resolveRecordSelection(chatId, '1');

    assert.equal(result, null);
    pendingSelection.clearPending(chatId);
});

test('resolveRecordSelection: pending type 是 select_candidate 時正常處理數字選擇', async (t) => {
    const chatId = 'test-chat-candidate-guard';
    t.mock.method(notion, 'updateRecord', async () => {});
    t.mock.method(notion, 'logOperation', async () => {});
    pendingSelection.setPending(chatId, {
        type: 'select_candidate',
        action: '取消',
        changes: {},
        candidates: [{ entity: 'task', pageId: 'p1', title: '倒垃圾費', due: null }]
    });

    const result = await router.resolveRecordSelection(chatId, '1');

    assert.match(result.text, /已將「倒垃圾費」標記為取消/);
});

test('resolveRecordSelection: task 標記完成時，走 toUpdateFields 順便寫入 Completed Date（不是直接寫 Status，兩處各自維護一份邏輯的老問題）', async (t) => {
    const chatId = 'test-chat-complete-date';
    let updatedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { updatedFields = fields; });
    t.mock.method(notion, 'logOperation', async () => {});
    pendingSelection.setPending(chatId, {
        type: 'select_candidate',
        action: '完成',
        changes: {},
        candidates: [{ entity: 'task', pageId: 'p2', title: '交報告', due: null }]
    });

    await router.resolveRecordSelection(chatId, '1');

    assert.equal(updatedFields.Status.select.name, '完成');
    assert.ok(updatedFields['Completed Date'].date.start);
});
