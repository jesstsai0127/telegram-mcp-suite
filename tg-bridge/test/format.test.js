const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../lib/format');
const { formatTodayReport } = format;

test('formatTodayReport: empty completed/unfinished shows the empty-state lines', () => {
    const text = formatTodayReport({ completed: [], unfinished: [] });
    assert.match(text, /（無）/);
    assert.match(text, /目前沒有待辦事項/);
});

test('formatTodayReport: renders clean completed/unfinished objects (not raw Notion pages)', () => {
    const text = formatTodayReport({
        completed: [{ title: '倒垃圾' }],
        unfinished: [
            { title: '開會', status: '進行中', dueDate: '2026-07-06 14:00' },
            { title: '買名片', status: '待辦', dueDate: null }
        ]
    });
    assert.match(text, /✅ 倒垃圾/);
    assert.match(text, /⏳ 開會（截止：2026-07-06 14:00）/);
    assert.match(text, /📌 買名片（無截止時間）/);
});

test('formatDateTimeShort: 純日期字串原樣回傳，不做時區轉換', () => {
    assert.equal(format.formatDateTimeShort('2026-07-07'), '2026-07-07');
});

test('formatDateTimeShort: UTC ISO 字串轉成台灣時區並截斷到分鐘', () => {
    // 2026-07-06T23:00:00.000Z 是 UTC，轉成 +08:00 應該是 2026-07-07 07:00
    assert.equal(format.formatDateTimeShort('2026-07-06T23:00:00.000Z'), '2026-07-07 07:00');
});

test('formatDateTimeShort: 已經帶 +08:00 offset 的字串截斷到分鐘，時間不變', () => {
    assert.equal(format.formatDateTimeShort('2026-07-07T15:00:00.000+08:00'), '2026-07-07 15:00');
});

test('formatDateTimeShort: null/undefined 回傳 null', () => {
    assert.equal(format.formatDateTimeShort(null), null);
    assert.equal(format.formatDateTimeShort(undefined), null);
});

test('formatActionSummary: 完成/取消直接回對應字樣', () => {
    assert.equal(format.formatActionSummary('完成', {}), '標記完成');
    assert.equal(format.formatActionSummary('取消', {}), '取消');
});

test('formatActionSummary: 修改列出實際要改的欄位，不是籠統的「修改」', () => {
    const summary = format.formatActionSummary('修改', { due_date: '2026-07-10 20:00', priority: '高' });
    assert.match(summary, /時間改成 2026-07-10 20:00/);
    assert.match(summary, /優先度改成「高」/);
});

test('formatActionSummary: 修改但沒有任何實際欄位時，回傳籠統的「修改」', () => {
    assert.equal(format.formatActionSummary('修改', {}), '修改');
});

test('formatCandidates: 2026-07-07 真實案例——標題不再是「選要動哪一筆」，要先講清楚會做什麼動作，使用者才能在回數字前確認', () => {
    const text = format.formatCandidates(
        [{ entity: 'task', title: '確認這次 Jaina 專案是否需要預訂 PVT 機器', due: '2026-07-07T03:00:00.000Z' }],
        '完成', {}
    );
    assert.match(text, /回覆數字確認要「標記完成」/);
});

test('formatCandidates: action 是修改時，標題也要顯示實際變更內容', () => {
    const text = format.formatCandidates(
        [{ entity: 'shopping', title: '衛生紙' }],
        '修改', { priority: '急需' }
    );
    assert.match(text, /回覆數字確認要「優先度改成「急需」」/);
});
