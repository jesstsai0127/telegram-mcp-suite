// notion.js 的 queryDb() cache-aside 分支邏輯——mock notion-cache 模組跟底層 Notion Client，
// 不用真的碰檔案系統或打 API，專注驗證「什麼情況該整批重新查、什麼情況該直接吃快取」這條判斷。
// dataSourceId() 查表這一步無法 mock 掉（不是我們自己寫的函式邊界），給一份假設定檔讓它能解析。
process.env.NOTION_DBS_CONFIG_PATH = require('path').join(__dirname, 'fixtures', 'notion-dbs.test.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const notionModule = require('../lib/notion');
const cache = require('../lib/notion-cache');

function fakePage(id, lastEditedTime) {
    return { id, last_edited_time: lastEditedTime, properties: { Title: { title: [{ plain_text: id }] } } };
}

test('queryDb: 非快取 entity（例如 Idea）不管 cache 模組，直接打 Notion', async (t) => {
    let queried = 0;
    t.mock.method(notionModule.notion.dataSources, 'query', async () => {
        queried++;
        return { results: [fakePage('idea-1', '2026-07-01T00:00:00.000Z')], has_more: false, next_cursor: null };
    });
    const getLastSyncedAtCalled = t.mock.method(cache, 'getLastSyncedAt');

    const rows = await notionModule.queryDb('Ideas', {}, []);
    assert.equal(rows.length, 1);
    assert.equal(queried, 1);
    assert.equal(getLastSyncedAtCalled.mock.callCount(), 0); // 完全不查快取模組
});

test('queryDb: 快取 entity（Tasks）從沒同步過時，整批抓全部資料並寫入快取', async (t) => {
    t.mock.method(cache, 'getLastSyncedAt', () => null);
    let replaceCalledWith = null;
    t.mock.method(cache, 'replaceCachedRows', (dbKey, rows) => { replaceCalledWith = { dbKey, rows }; });
    let queryCallCount = 0;
    t.mock.method(notionModule.notion.dataSources, 'query', async (args) => {
        queryCallCount++;
        assert.equal(args.filter, undefined); // 整批抓取不能帶原本呼叫端給的 filter
        return { results: [fakePage('t1', '2026-07-01T00:00:00.000Z')], has_more: false, next_cursor: null };
    });

    const rows = await notionModule.queryDb('Tasks', { property: 'Status', select: { equals: '待辦' } }, []);
    assert.equal(queryCallCount, 1);
    assert.equal(replaceCalledWith.dbKey, 'Tasks');
    assert.equal(replaceCalledWith.rows.length, 1);
    assert.equal(rows.length, 0); // fakePage 沒有 Status 屬性，本機過濾後篩不到，證明真的有經過本機 filter
});

test('queryDb: 快取 entity 已同步過、且沒有東西被改過時，直接吃快取不重新查全部', async (t) => {
    t.mock.method(cache, 'getLastSyncedAt', () => '2026-07-01T00:00:00.000Z');
    t.mock.method(cache, 'getCachedRows', () => [fakePage('t1', '2026-06-30T00:00:00.000Z')]);
    let fullQueryCount = 0;
    t.mock.method(notionModule.notion.dataSources, 'query', async (args) => {
        // 輕量檢查一定會帶 page_size:1 + timestamp filter，不會是整批查詢
        assert.equal(args.page_size, 1);
        assert.equal(args.filter.timestamp, 'last_edited_time');
        fullQueryCount++;
        return { results: [], has_more: false, next_cursor: null }; // 沒有比快取新的資料
    });
    const replaceCalled = t.mock.method(cache, 'replaceCachedRows');

    const rows = await notionModule.queryDb('Tasks', {}, []);
    assert.equal(fullQueryCount, 1); // 只打了一次輕量檢查
    assert.equal(replaceCalled.mock.callCount(), 0); // 沒有整批重新查詢
    assert.equal(rows.length, 1);
});

test('queryDb: 快取 entity 已同步過、但輕量檢查發現有變動時，整批重新查詢並更新快取', async (t) => {
    t.mock.method(cache, 'getLastSyncedAt', () => '2026-07-01T00:00:00.000Z');
    let replaceCalled = false;
    t.mock.method(cache, 'replaceCachedRows', () => { replaceCalled = true; });
    let callCount = 0;
    t.mock.method(notionModule.notion.dataSources, 'query', async (args) => {
        callCount++;
        if (callCount === 1) {
            assert.equal(args.page_size, 1);
            return { results: [fakePage('t-changed', '2026-07-05T00:00:00.000Z')], has_more: false, next_cursor: null };
        }
        return { results: [fakePage('t1', '2026-07-05T00:00:00.000Z')], has_more: false, next_cursor: null };
    });

    await notionModule.queryDb('Tasks', {}, []);
    assert.equal(callCount, 2); // 輕量檢查 + 整批重新查詢
    assert.equal(replaceCalled, true);
});

// 真實案例的疑慮：「今天延長過到期時間的待辦，晚報要用延長後的值，不能用延長前的」——
// 驗證即使輕量檢查誤判成「沒有變動」（例如 Notion 分鐘級捨去時間造成的已知盲點），
// updatePage() 的 write-through 也已經把快取裡那一筆更新成最新值，讀到的不會是舊資料。
test('queryDb: 透過 updatePage() 改過欄位後，即使輕量檢查誤判沒變動，讀到的還是更新後的值', async (t) => {
    t.mock.method(cache, 'getLastSyncedAt', () => '2026-07-01T00:00:00.000Z');
    const patchedRow = fakePage('t1', '2026-07-01T00:00:00.000Z');
    patchedRow.properties['Due Date'] = { date: { start: '2026-07-20T09:00:00.000+08:00' } };

    // updatePage() 本身：Notion API 回傳更新後的完整 page，write-through 寫回快取
    t.mock.method(notionModule.notion.pages, 'update', async () => patchedRow);
    let upsertedWith = null;
    t.mock.method(cache, 'upsertRowByPageId', (row) => { upsertedWith = row; });
    await notionModule.updatePage('t1', { 'Due Date': { date: { start: '2026-07-20T09:00:00.000+08:00' } } });
    assert.equal(upsertedWith.id, 't1');

    // 緊接著的 queryDb：輕量檢查誤判成「沒有變動」（模擬已知的分鐘級捨去盲點），
    // 應該直接吃快取——但快取要是 upsertRowByPageId 剛剛寫入的新值，不是查詢前的舊值
    t.mock.method(notionModule.notion.dataSources, 'query', async () => ({
        results: [], has_more: false, next_cursor: null // 輕量檢查：沒有比快取新的資料
    }));
    t.mock.method(cache, 'getCachedRows', () => [patchedRow]); // 快取已經是 write-through 後的狀態

    const rows = await notionModule.queryDb('Tasks', {}, []);
    assert.equal(rows[0].properties['Due Date'].date.start, '2026-07-20T09:00:00.000+08:00');
});
