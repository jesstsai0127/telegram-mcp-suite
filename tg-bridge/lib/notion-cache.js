// 通用 cache-aside 快取層，跟 entity 無關——Task/Shopping 現在共用同一套，之後 Idea/Health/
// Diet/Activity 要接上也是直接沿用，不用各自兜一份。研究依據：Notion 自己的桌面/網頁 App 就是
// 用 SQLite 做本機快取（官方文件記載加速 30-50%），Cache-Aside 是這類「本機快取 + 遠端權威來源」
// 架構的正式名稱（Azure Architecture Center 有記載）。
//
// 用 Node 22+ 內建的 node:sqlite，不用額外裝套件。快取檔本身會存到完整的個人資料（任務/購物內容），
// 比照 chat_id.txt/notion-dbs.json 的規則放在 repo 外，不進 git。

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DB_PATH = process.env.NOTION_CACHE_DB_PATH ||
    path.join(os.homedir(), '.cache', 'tg-bridge', 'notion-cache.db');

let _db = null;
function getDb() {
    if (_db) return _db;
    fs.mkdirSync(path.dirname(CACHE_DB_PATH), { recursive: true });
    _db = new DatabaseSync(CACHE_DB_PATH);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS cache_meta (
            db_key TEXT PRIMARY KEY,
            last_synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS cache_rows (
            db_key TEXT NOT NULL,
            page_id TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (db_key, page_id)
        );
        -- upsertRowByPageId 只用 page_id 查（不知道 dbKey），複合主鍵 (db_key, page_id)
        -- 用不到索引，沒有這個索引的話每次 updatePage 都要全表掃描
        CREATE INDEX IF NOT EXISTS idx_cache_rows_page_id ON cache_rows(page_id);
    `);
    return _db;
}

function getLastSyncedAt(dbKey) {
    const row = getDb().prepare('SELECT last_synced_at FROM cache_meta WHERE db_key = ?').get(dbKey);
    return row ? row.last_synced_at : null;
}

// 整批取代：拿到 Notion 的完整結果後，先清空這個 dbKey 的舊快取再整批寫入，
// 跟更新 last_synced_at 包在同一個交易裡，避免中途失敗留下不一致的半套資料。
function replaceCachedRows(dbKey, rows, syncedAtISO) {
    const db = getDb();
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM cache_rows WHERE db_key = ?').run(dbKey);
        const insert = db.prepare('INSERT INTO cache_rows (db_key, page_id, data) VALUES (?, ?, ?)');
        for (const row of rows) {
            insert.run(dbKey, row.id, JSON.stringify(row));
        }
        db.prepare(`
            INSERT INTO cache_meta (db_key, last_synced_at) VALUES (?, ?)
            ON CONFLICT(db_key) DO UPDATE SET last_synced_at = excluded.last_synced_at
        `).run(dbKey, syncedAtISO);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function getCachedRows(dbKey) {
    const rows = getDb().prepare('SELECT data FROM cache_rows WHERE db_key = ?').all(dbKey);
    return rows.map(r => JSON.parse(r.data));
}

// 我們自己的 create/update 寫入 Notion 成功後，順手同步更新快取裡的這一筆——
// 不用等下一次整批重新整理，馬上就能讀到最新狀態。不影響 last_synced_at
// （這只是單筆補丁，不是整批重新確認過所有資料）。
function upsertRow(dbKey, row) {
    getDb().prepare(`
        INSERT INTO cache_rows (db_key, page_id, data) VALUES (?, ?, ?)
        ON CONFLICT(db_key, page_id) DO UPDATE SET data = excluded.data
    `).run(dbKey, row.id, JSON.stringify(row));
}

// notion.js 的 updatePage(pageId, properties) 本來就不知道這個 page 屬於哪個 dbKey
// （呼叫端從沒傳過），改動每個呼叫點太傷；page_id 在 Notion 裡本來就是全域唯一，
// 反查目前快取哪個 dbKey 有這筆頁面就好，找不到（非快取 entity）就是沒事發生。
function upsertRowByPageId(row) {
    const existing = getDb().prepare('SELECT db_key FROM cache_rows WHERE page_id = ?').get(row.id);
    if (!existing) return;
    upsertRow(existing.db_key, row);
}

module.exports = { getLastSyncedAt, replaceCachedRows, getCachedRows, upsertRow, upsertRowByPageId, CACHE_DB_PATH };
