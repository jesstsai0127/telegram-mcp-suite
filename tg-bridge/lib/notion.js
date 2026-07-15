const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const { SCHEMAS } = require('./db-schemas');
const cache = require('./notion-cache');
const { queryLocal } = require('./notion-filter');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Cache-aside 只套用在這兩個 dbKey——Task 跟 Shopping 是這次明確要求要一致處理的兩個 entity，
// 其他 entity（Idea/Project/Health/Diet/Activity/Search Cache/Operation Log/Skill Registry）
// 資料量小、查詢頻率低，繼續直接打 Notion，之後真的有需要再照同一套模組延伸，不用這次全部套用。
const CACHED_DB_KEYS = [SCHEMAS.task.dbKey, SCHEMAS.shopping.dbKey];
// 可覆寫路徑，讓測試環境指向獨立的設定檔，不會跟正式環境共用同一份。
// 延遲到實際呼叫時才讀檔（不是 require 這個檔案的當下），這樣單元測試只要
// mock 掉 createPage/queryDb 這類函式，就不需要真的有這個設定檔存在。
let _dbIds = null;
function loadDbIds() {
    if (_dbIds) return _dbIds;
    const configPath = process.env.NOTION_DBS_CONFIG_PATH ||
        path.join(__dirname, '..', 'config', 'notion-dbs.json');
    if (!fs.existsSync(configPath)) {
        throw new Error(`Notion DB 設定檔不存在：${configPath}（設定 NOTION_DBS_CONFIG_PATH 或建立這個檔案）`);
    }
    _dbIds = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return _dbIds;
}

function dbId(key) {
    return loadDbIds()[key].database_id;
}

function dataSourceId(key) {
    return loadDbIds()[key].data_source_id;
}

async function createPage(dbKey, properties) {
    const page = await notion.pages.create({
        parent: { database_id: dbId(dbKey) },
        properties
    });
    // write-through：我們自己的寫入直接更新快取，不用等下一次整批重新整理才看得到
    if (CACHED_DB_KEYS.includes(dbKey)) cache.upsertRow(dbKey, page);
    return page;
}

// Notion 一次最多回傳 100 筆（has_more/next_cursor），沒有分頁處理的話結果會被靜默截斷，
// 不會報錯也看不出來少了資料——2026-07-07 拿 1000 筆測試資料實測 shopping_search_history 時發現。
async function fetchAllFromNotion(dbKey, filter, sorts) {
    let results = [];
    let cursor;
    let hasMore = true;
    while (hasMore) {
        const res = await notion.dataSources.query({
            data_source_id: dataSourceId(dbKey),
            filter,
            sorts,
            ...(cursor ? { start_cursor: cursor } : {})
        });
        results = results.concat(res.results);
        hasMore = res.has_more;
        cursor = res.next_cursor;
    }
    return results;
}

// 這個 dbKey 的資料自從上次整批同步後，有沒有東西被改過（不管是我們自己改的，還是有人直接在
// Notion 介面手動改的）——只查一筆存不存在就好，不用真的抓資料，比整批重新查詢輕量很多。
// 2026-07-07 發現：Notion 從 7/1 起把 last_edited_time／created_time 無條件捨去到最近的
// 分鐘（官方 changelog 證實），實測發現同一分鐘內建立+修改，兩次回傳的 last_edited_time
// 完全相同，導致「用剛好落在同一分鐘的時間點去比對」會誤判成沒有變動、吃到過期的快取。
// 修法：往回抓 1 分鐘的容錯空間，寧可偶爾多做一次不必要的整批重新整理，也不要漏掉真的變動過的資料。
const STALENESS_CHECK_BUFFER_MS = 60000;

async function hasChangedSince(dbKey, sinceISO) {
    const bufferedSince = new Date(new Date(sinceISO).getTime() - STALENESS_CHECK_BUFFER_MS).toISOString();
    const res = await notion.dataSources.query({
        data_source_id: dataSourceId(dbKey),
        filter: { timestamp: 'last_edited_time', last_edited_time: { after: bufferedSince } },
        page_size: 1
    });
    return res.results.length > 0;
}

// Cache-aside：Task/Shopping 兩個 dbKey 才走快取，其他 entity 照舊直接打 Notion（見
// CACHED_DB_KEYS 的說明）。研究依據：Notion 自己的桌面/網頁 App 就是用 SQLite 做本機快取
// （官方文件記載加速 30-50%），這裡採用的 Cache-Aside 是同一類架構的正式名稱。
async function queryDb(dbKey, filter, sorts) {
    if (!CACHED_DB_KEYS.includes(dbKey)) {
        return fetchAllFromNotion(dbKey, filter, sorts);
    }

    const lastSyncedAt = cache.getLastSyncedAt(dbKey);
    const stale = !lastSyncedAt || await hasChangedSince(dbKey, lastSyncedAt);

    if (stale) {
        const nowISO = new Date().toISOString();
        const allRows = await fetchAllFromNotion(dbKey, undefined, undefined);
        cache.replaceCachedRows(dbKey, allRows, nowISO);
        return queryLocal(allRows, filter, sorts);
    }

    return queryLocal(cache.getCachedRows(dbKey), filter, sorts);
}

async function updatePage(pageId, properties) {
    const page = await notion.pages.update({ page_id: pageId, properties });
    // write-through：不知道這筆屬於哪個 dbKey（updatePage 本來就只吃 pageId），
    // 用 page_id 反查快取裡哪個 dbKey 有這筆，找不到就是非快取 entity，不做事
    cache.upsertRowByPageId(page);
    return page;
}

const richText = (content) => ({ rich_text: [{ text: { content } }] });
const title = (content) => ({ title: [{ text: { content } }] });

// 通用 CRUD——不因為 entity（task/idea/shopping/...）不同而重寫，
// entity 特有的欄位轉換規則在 lib/db-schemas.js 裡，這裡只負責通用的 Notion 呼叫。
async function createRecord(dbKey, fields) {
    return createPage(dbKey, fields);
}

async function queryRecords(dbKey, filter, sorts) {
    return queryDb(dbKey, filter, sorts);
}

async function updateRecord(pageId, fields) {
    return updatePage(pageId, fields);
}

async function findRecords(dbKey, { titleProperty, hint, pendingStatuses = [], start, end } = {}) {
    const and = [];
    if (pendingStatuses.length > 0) {
        and.push({ or: pendingStatuses.map(s => ({ property: 'Status', select: { equals: s } })) });
    }
    if (hint) and.push({ property: titleProperty, title: { contains: hint } });
    if (start) and.push({ property: 'Due Date', date: { on_or_after: start } });
    if (end) and.push({ property: 'Due Date', date: { on_or_before: end } });
    const filter = and.length > 0 ? { and } : undefined;
    return queryDb(dbKey, filter, [{ property: 'Created', direction: 'descending' }]);
}

async function findDueReminders() {
    const nowISO = new Date().toISOString();
    return queryDb(SCHEMAS.task.dbKey, {
        and: [
            { property: 'Next Trigger', date: { is_not_empty: true } },
            { property: 'Next Trigger', date: { on_or_before: nowISO } },
            {
                or: [
                    { property: 'Status', select: { equals: '待辦' } },
                    { property: 'Status', select: { equals: '進行中' } }
                ]
            }
        ]
    });
}

async function clearReminder(pageId) {
    return updatePage(pageId, { 'Next Trigger': { date: null } });
}

// 規則性任務響過一次之後推進到下一次，跟 clearReminder（單次任務響完就清空）語意對稱
async function advanceRecurrence(pageId, nextTriggerISO) {
    return updatePage(pageId, { 'Next Trigger': { date: { start: nextTriggerISO } } });
}

// 輕量操作歷史，供未來 debug/查詢用（不是通用 log 平台——Notion 沒有聚合查詢、API 有 rate limit，
// 量大就不適合；AXIS 目前的操作頻率完全沒問題）。Project/Entity/Action 都用 rich_text 不用 select，
// 讓未來其它專案要寫入時不用先改 schema 加選項。
async function logOperation({ project, entity, action, summary, detail }) {
    return createPage('Operation Log', {
        Summary: title(summary),
        Project: richText(project),
        Entity: richText(entity),
        Action: richText(action),
        Detail: richText(detail || '')
    });
}

async function findSearchCache(query) {
    const rows = await queryDb('Search Cache', { property: 'Query', title: { equals: query } }, [
        { property: 'Created', direction: 'descending' }
    ]);
    return rows[0] || null;
}

async function createSearchCache({ query, searchKeywords, summary, sourceUrls, expiresAt, forceRefresh }) {
    return createPage('Search Cache', {
        Query: title(query),
        'Search Keywords': richText(searchKeywords),
        Summary: richText(summary),
        'Source URLs': richText(sourceUrls),
        'Expires At': { date: { start: expiresAt } },
        'Force Refresh': { checkbox: Boolean(forceRefresh) }
    });
}

module.exports = {
    notion, dbId, dataSourceId, createPage, queryDb, updatePage,
    createRecord, queryRecords, updateRecord, findRecords,
    findSearchCache, createSearchCache,
    findDueReminders, clearReminder, advanceRecurrence, logOperation
};
