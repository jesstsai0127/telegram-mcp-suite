const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseReminderOffsetMinutes, computeNextReminderTrigger,
    offsetsToStoredString, offsetsFromStoredString, DEFAULT_REMINDER_OFFSETS_MINUTES
} = require('../lib/reminder-offset');

test('presets', () => {
    assert.equal(parseReminderOffsetMinutes('半天前'), 12 * 60);
    assert.equal(parseReminderOffsetMinutes('一天前'), 24 * 60);
    assert.equal(parseReminderOffsetMinutes('一小時前'), 60);
    assert.equal(parseReminderOffsetMinutes('1小時前'), 60);
});

test('custom N單位前', () => {
    assert.equal(parseReminderOffsetMinutes('3小時前'), 180);
    assert.equal(parseReminderOffsetMinutes('30分鐘前'), 30);
    assert.equal(parseReminderOffsetMinutes('2天前'), 2880);
    assert.equal(parseReminderOffsetMinutes('5分鐘'), 5); // 「前」可省略
});

test('null/unrecognized input', () => {
    assert.equal(parseReminderOffsetMinutes(null), null);
    assert.equal(parseReminderOffsetMinutes(undefined), null);
    assert.equal(parseReminderOffsetMinutes('隨便'), null);
    assert.equal(parseReminderOffsetMinutes(''), null);
});

test('computeNextReminderTrigger: 兩個 offset 都還沒到，挑最快到的那個', () => {
    const anchor = new Date('2026-07-10T12:00:00.000Z'); // 到期時刻
    const now = new Date('2026-07-01T00:00:00.000Z');
    const result = computeNextReminderTrigger(anchor, [24 * 60, 60], now);
    // 24小時前 = 07-09T12:00，1小時前 = 07-10T11:00，最快到的是 24小時前那個
    assert.equal(result.offsetMin, 24 * 60);
    assert.equal(result.trigger.toISOString(), '2026-07-09T12:00:00.000Z');
});

test('computeNextReminderTrigger: 已經過了 24 小時前那個提醒點，只剩 1 小時前', () => {
    const anchor = new Date('2026-07-10T12:00:00.000Z');
    const now = new Date('2026-07-10T00:00:00.000Z'); // 已經過了 07-09T12:00（24小時前）
    const result = computeNextReminderTrigger(anchor, [24 * 60, 60], now);
    assert.equal(result.offsetMin, 60);
    assert.equal(result.trigger.toISOString(), '2026-07-10T11:00:00.000Z');
});

test('computeNextReminderTrigger: 兩個提醒點都已經過期（例如任務快到期才建立），回傳 null', () => {
    const anchor = new Date('2026-07-10T12:00:00.000Z');
    const now = new Date('2026-07-10T11:30:00.000Z'); // 24小時前跟1小時前都已經過了
    const result = computeNextReminderTrigger(anchor, [24 * 60, 60], now);
    assert.equal(result, null);
});

test('computeNextReminderTrigger: 空 offsets 清單直接回傳 null（不用提醒）', () => {
    const result = computeNextReminderTrigger(new Date('2026-07-10T12:00:00.000Z'), [], new Date('2026-07-01T00:00:00.000Z'));
    assert.equal(result, null);
});

test('offsetsToStoredString / offsetsFromStoredString: 往返轉換一致', () => {
    assert.equal(offsetsToStoredString([1440, 60]), '1440,60');
    assert.deepEqual(offsetsFromStoredString('1440,60'), [1440, 60]);
});

test('offsetsFromStoredString: 空值回傳預設兩筆（24小時前+1小時前）', () => {
    assert.deepEqual(offsetsFromStoredString(null), DEFAULT_REMINDER_OFFSETS_MINUTES);
    assert.deepEqual(offsetsFromStoredString(''), DEFAULT_REMINDER_OFFSETS_MINUTES);
});

test('offsetsFromStoredString: 混雜壞資料時濾掉無效值，全部無效才退回預設', () => {
    assert.deepEqual(offsetsFromStoredString('1440,abc,60'), [1440, 60]);
    assert.deepEqual(offsetsFromStoredString('abc,xyz'), DEFAULT_REMINDER_OFFSETS_MINUTES);
});
