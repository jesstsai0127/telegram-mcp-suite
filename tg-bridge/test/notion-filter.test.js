const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesFilter, applySort, queryLocal } = require('../lib/notion-filter');

function fakeRow({ id, title, status, dueDate, lastEditedTime, createdTime, createdProp }) {
    return {
        id,
        last_edited_time: lastEditedTime || '2026-07-01T00:00:00.000Z',
        created_time: createdTime || '2026-06-01T00:00:00.000Z',
        properties: {
            Title: { title: [{ plain_text: title }] },
            Status: { select: status ? { name: status } : null },
            'Due Date': { date: dueDate ? { start: dueDate } : null },
            // Notion 的 created_time 型別屬性值放在 prop.created_time，不是 prop.date——
            // 跟 fakeRow 頂層的 row.created_time（timestamp filter 用）是兩回事
            ...(createdProp ? { Created: { type: 'created_time', created_time: createdProp } } : {})
        }
    };
}

test('matchesFilter: 空 filter 一律成立', () => {
    assert.equal(matchesFilter(fakeRow({ id: '1', title: 'a' }), {}), true);
    assert.equal(matchesFilter(fakeRow({ id: '1', title: 'a' }), null), true);
});

test('matchesFilter: select equals', () => {
    const row = fakeRow({ id: '1', title: 'a', status: '待辦' });
    assert.equal(matchesFilter(row, { property: 'Status', select: { equals: '待辦' } }), true);
    assert.equal(matchesFilter(row, { property: 'Status', select: { equals: '完成' } }), false);
});

test('matchesFilter: title contains 不分大小寫（跟 Notion API 行為一致）', () => {
    const row = fakeRow({ id: '1', title: '熊寶貝洗衣精' });
    assert.equal(matchesFilter(row, { property: 'Title', title: { contains: '洗衣精' } }), true);
    assert.equal(matchesFilter(row, { property: 'Title', title: { contains: 'ABC' } }), false);
});

test('matchesFilter: date on_or_after/on_or_before/before', () => {
    const row = fakeRow({ id: '1', title: 'a', dueDate: '2026-07-10' });
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { on_or_after: '2026-07-01' } }), true);
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { on_or_after: '2026-08-01' } }), false);
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { before: '2026-08-01' } }), true);
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { before: '2026-07-01' } }), false);
});

test('matchesFilter: date is_empty/is_not_empty', () => {
    const withDue = fakeRow({ id: '1', title: 'a', dueDate: '2026-07-10' });
    const noDue = fakeRow({ id: '2', title: 'b' });
    assert.equal(matchesFilter(noDue, { property: 'Due Date', date: { is_empty: true } }), true);
    assert.equal(matchesFilter(withDue, { property: 'Due Date', date: { is_empty: true } }), false);
    assert.equal(matchesFilter(withDue, { property: 'Due Date', date: { is_not_empty: true } }), true);
});

test('matchesFilter: and 巢狀全部成立才算符合', () => {
    const row = fakeRow({ id: '1', title: 'a', status: '待辦', dueDate: '2026-07-10' });
    const filter = {
        and: [
            { property: 'Status', select: { equals: '待辦' } },
            { property: 'Due Date', date: { on_or_after: '2026-07-01' } }
        ]
    };
    assert.equal(matchesFilter(row, filter), true);
    assert.equal(matchesFilter(row, { and: [filter.and[0], { property: 'Due Date', date: { on_or_after: '2026-08-01' } }] }), false);
});

test('matchesFilter: or 巢狀只要一個成立就算符合', () => {
    const row = fakeRow({ id: '1', title: 'a', status: '進行中' });
    const filter = { or: [{ property: 'Status', select: { equals: '待辦' } }, { property: 'Status', select: { equals: '進行中' } }] };
    assert.equal(matchesFilter(row, filter), true);
});

test('matchesFilter: and/or 混合巢狀（daily_report_today 的 unfinished 篩選同款結構）', () => {
    const row = fakeRow({ id: '1', title: 'a', status: '待辦' }); // 沒有 Due Date
    const filter = {
        and: [
            { or: [{ property: 'Status', select: { equals: '待辦' } }, { property: 'Status', select: { equals: '進行中' } }] },
            { or: [{ property: 'Due Date', date: { is_empty: true } }, { property: 'Due Date', date: { on_or_before: '2026-07-08' } }] }
        ]
    };
    assert.equal(matchesFilter(row, filter), true);
});

test('matchesFilter: timestamp last_edited_time on_or_after', () => {
    const row = fakeRow({ id: '1', title: 'a', lastEditedTime: '2026-07-05T00:00:00.000Z' });
    const filter = { timestamp: 'last_edited_time', last_edited_time: { on_or_after: '2026-07-01T00:00:00.000Z' } };
    assert.equal(matchesFilter(row, filter), true);
    assert.equal(matchesFilter(row, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: '2026-07-10T00:00:00.000Z' } }), false);
});

test('matchesFilter: date before/after 比較實際時間點，不是字典序字串（真實案例：Due Date 用 +08:00 offset 寫入，但 before 邊界常是 .toISOString() 算出來的 UTC Z 字串，台北當地 00:00-08:00 這段兩種格式字典序會相反）', () => {
    // 2026-07-08 02:00 台北時間 = 2026-07-07 18:00 UTC，已經過了 nowISO（2026-07-07 20:00 UTC）
    // 字典序比較會因為日期數字 '08' > '07' 誤判成還沒過期
    const row = fakeRow({ id: '1', title: 'a', dueDate: '2026-07-08T02:00:00+08:00' });
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { before: '2026-07-07T20:00:00.000Z' } }), true);
    assert.equal(matchesFilter(row, { property: 'Due Date', date: { after: '2026-07-07T20:00:00.000Z' } }), false);
});

test('applySort: 依 created_time 型別屬性排序（findRecords 固定用 Created 排序的真實案例）', () => {
    const rows = [
        fakeRow({ id: '1', title: 'a', createdProp: '2026-07-01T00:00:00.000Z' }),
        fakeRow({ id: '2', title: 'b', createdProp: '2026-07-10T00:00:00.000Z' }),
        fakeRow({ id: '3', title: 'c', createdProp: '2026-07-05T00:00:00.000Z' })
    ];
    const sorted = applySort(rows, [{ property: 'Created', direction: 'descending' }]);
    assert.deepEqual(sorted.map(r => r.id), ['2', '3', '1']);
});

test('applySort: descending by date, 缺值排最後', () => {
    const rows = [
        fakeRow({ id: '1', title: 'a', dueDate: '2026-07-01' }),
        fakeRow({ id: '2', title: 'b', dueDate: '2026-07-10' }),
        fakeRow({ id: '3', title: 'c' })
    ];
    const sorted = applySort(rows, [{ property: 'Due Date', direction: 'descending' }]);
    assert.deepEqual(sorted.map(r => r.id), ['2', '1', '3']);
});

test('queryLocal: 過濾 + 排序一次做完', () => {
    const rows = [
        fakeRow({ id: '1', title: 'a', status: '待辦', dueDate: '2026-07-01' }),
        fakeRow({ id: '2', title: 'b', status: '完成', dueDate: '2026-07-05' }),
        fakeRow({ id: '3', title: 'c', status: '待辦', dueDate: '2026-07-10' })
    ];
    const result = queryLocal(rows, { property: 'Status', select: { equals: '待辦' } }, [{ property: 'Due Date', direction: 'ascending' }]);
    assert.deepEqual(result.map(r => r.id), ['1', '3']);
});
