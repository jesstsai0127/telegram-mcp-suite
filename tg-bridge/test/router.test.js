const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveScope, toTaipeiISO } = require('../lib/router');

test('toTaipeiISO: converts "YYYY-MM-DD HH:MM" to Taipei-offset ISO', () => {
    assert.equal(toTaipeiISO('2026-07-05 15:00'), '2026-07-05T15:00:00+08:00');
});

test('resolveScope: no scope means no date restriction (must still find overdue items)', () => {
    assert.deepEqual(resolveScope(null), {});
    assert.deepEqual(resolveScope(undefined), {});
});

test('resolveScope: "這個月"/"本月" resolves to the current calendar month', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const lastDay = new Date(year, month, 0).getDate();
    const expectedStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const expectedEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    assert.deepEqual(resolveScope('這個月'), { start: expectedStart, end: expectedEnd });
    assert.deepEqual(resolveScope('本月'), { start: expectedStart, end: expectedEnd });
});

test('resolveScope: "N月" resolves to that month, rolling to next year if already past', () => {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const targetMonth = 3; // 固定測試 3 月，跟目前月份比較決定年份，邏輯跟 resolveScope 本身一致
    const year = targetMonth < currentMonth ? now.getFullYear() + 1 : now.getFullYear();
    const lastDay = new Date(year, targetMonth, 0).getDate();

    const { start, end } = resolveScope('3月');
    assert.equal(start, `${year}-03-01`);
    assert.equal(end, `${year}-03-${String(lastDay).padStart(2, '0')}`);
});
