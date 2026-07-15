// lib/notion-cache.js 的獨立測試——每個測試用獨立的 SQLite 檔案（NOTION_CACHE_DB_PATH 指向
// 唯一路徑），避免測試之間互相污染，也不會碰到正式/測試環境實際在用的快取檔。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function freshCacheModule() {
    const dbPath = path.join(os.tmpdir(), `notion-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.NOTION_CACHE_DB_PATH = dbPath;
    delete require.cache[require.resolve('../lib/notion-cache')];
    const mod = require('../lib/notion-cache');
    return { mod, dbPath };
}

test('getLastSyncedAt: 從沒同步過回傳 null', () => {
    const { mod, dbPath } = freshCacheModule();
    assert.equal(mod.getLastSyncedAt('Tasks'), null);
    fs.rmSync(dbPath, { force: true });
});

test('replaceCachedRows + getCachedRows: 整批寫入後可以讀回，且更新 last_synced_at', () => {
    const { mod, dbPath } = freshCacheModule();
    mod.replaceCachedRows('Tasks', [{ id: 'p1', properties: {} }, { id: 'p2', properties: {} }], '2026-07-07T00:00:00.000Z');
    assert.equal(mod.getLastSyncedAt('Tasks'), '2026-07-07T00:00:00.000Z');
    const rows = mod.getCachedRows('Tasks');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.id).sort(), ['p1', 'p2']);
    fs.rmSync(dbPath, { force: true });
});

test('replaceCachedRows: 對同一個 dbKey 再次呼叫會整批取代舊資料，不是疊加', () => {
    const { mod, dbPath } = freshCacheModule();
    mod.replaceCachedRows('Tasks', [{ id: 'p1', properties: {} }], '2026-07-01T00:00:00.000Z');
    mod.replaceCachedRows('Tasks', [{ id: 'p2', properties: {} }], '2026-07-02T00:00:00.000Z');
    const rows = mod.getCachedRows('Tasks');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'p2');
    fs.rmSync(dbPath, { force: true });
});

test('replaceCachedRows: 不同 dbKey 互不影響', () => {
    const { mod, dbPath } = freshCacheModule();
    mod.replaceCachedRows('Tasks', [{ id: 't1', properties: {} }], '2026-07-01T00:00:00.000Z');
    mod.replaceCachedRows('Shopping', [{ id: 's1', properties: {} }], '2026-07-01T00:00:00.000Z');
    assert.equal(mod.getCachedRows('Tasks').length, 1);
    assert.equal(mod.getCachedRows('Shopping').length, 1);
    fs.rmSync(dbPath, { force: true });
});

test('upsertRow: 對已存在的 page_id 是更新內容，不是新增一筆', () => {
    const { mod, dbPath } = freshCacheModule();
    mod.replaceCachedRows('Tasks', [{ id: 'p1', properties: { Title: { title: [{ plain_text: 'old' }] } } }], '2026-07-01T00:00:00.000Z');
    mod.upsertRow('Tasks', { id: 'p1', properties: { Title: { title: [{ plain_text: 'new' }] } } });
    const rows = mod.getCachedRows('Tasks');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].properties.Title.title[0].plain_text, 'new');
    fs.rmSync(dbPath, { force: true });
});

test('upsertRowByPageId: 反查出這個 page_id 屬於哪個 dbKey 並更新，不需要呼叫端指定', () => {
    const { mod, dbPath } = freshCacheModule();
    mod.replaceCachedRows('Shopping', [{ id: 's1', properties: { Item: { title: [{ plain_text: 'old' }] } } }], '2026-07-01T00:00:00.000Z');
    mod.upsertRowByPageId({ id: 's1', properties: { Item: { title: [{ plain_text: 'new' }] } } });
    const rows = mod.getCachedRows('Shopping');
    assert.equal(rows[0].properties.Item.title[0].plain_text, 'new');
    fs.rmSync(dbPath, { force: true });
});

test('upsertRowByPageId: 找不到對應的 dbKey（非快取 entity 的頁面）時安靜跳過，不報錯', () => {
    const { mod, dbPath } = freshCacheModule();
    assert.doesNotThrow(() => mod.upsertRowByPageId({ id: 'unknown-page', properties: {} }));
    fs.rmSync(dbPath, { force: true });
});
