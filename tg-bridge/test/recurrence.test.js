const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRecurrence, computeNextOccurrence } = require('../lib/recurrence');

test('parseRecurrence: weekly multi-weekday builds a valid rule', () => {
    const rule = parseRecurrence({
        freq: 'weekly', byweekday: ['MO', 'WE', 'FR'],
        dtstart: new Date('2026-07-04T01:00:00Z')
    });
    assert.ok(rule);
    assert.match(rule.toString(), /FREQ=WEEKLY/);
    assert.match(rule.toString(), /BYDAY=MO,WE,FR/);
});

test('parseRecurrence: monthly Nth-weekday + count', () => {
    const rule = parseRecurrence({
        freq: 'monthly', byweekday: ['TU'], bysetpos: 2, count: 3,
        dtstart: new Date('2026-07-04T01:00:00Z')
    });
    assert.ok(rule);
    const occurrences = rule.all();
    assert.equal(occurrences.length, 3);
});

test('parseRecurrence: monthly bymonthday (每月N號)', () => {
    const rule = parseRecurrence({
        freq: 'monthly', bymonthday: 5,
        dtstart: new Date('2026-07-05T01:00:00Z')
    });
    assert.ok(rule);
    assert.match(rule.toString(), /BYMONTHDAY=5/);
    const next3 = rule.all((date, i) => i < 3);
    assert.equal(next3.length, 3);
    for (const d of next3) assert.equal(d.getUTCDate(), 5);
});

test('parseRecurrence: bymonthday 跟 byweekday 互斥，同時給視為無效', () => {
    const rule = parseRecurrence({
        freq: 'monthly', bymonthday: 5, byweekday: ['TU'],
        dtstart: new Date('2026-07-05T01:00:00Z')
    });
    assert.equal(rule, null);
});

test('parseRecurrence: yearly + bymonth/bymonthday（每年3月5號）每年只觸發一次', () => {
    const rule = parseRecurrence({
        freq: 'yearly', bymonth: 3, bymonthday: 5,
        dtstart: new Date('2026-07-05T01:00:00Z') // dtstart 是「今天」，不是 3 月，驗證仍會正確找到明年 3/5
    });
    assert.ok(rule);
    const next3 = rule.all((date, i) => i < 3);
    assert.equal(next3.length, 3);
    assert.deepEqual(next3.map(d => d.toISOString()), [
        '2027-03-05T01:00:00.000Z', '2028-03-05T01:00:00.000Z', '2029-03-05T01:00:00.000Z'
    ]);
});

test('parseRecurrence: yearly + bymonthday 沒有 bymonth 視為無效（避免 RRule 誤展開成每月）', () => {
    const rule = parseRecurrence({
        freq: 'yearly', bymonthday: 5,
        dtstart: new Date('2026-07-05T01:00:00Z')
    });
    assert.equal(rule, null);
});

test('parseRecurrence: interval（每兩週）每 2 週觸發一次', () => {
    const rule = parseRecurrence({
        freq: 'weekly', interval: 2,
        dtstart: new Date('2026-07-05T01:00:00Z')
    });
    assert.ok(rule);
    const next3 = rule.all((date, i) => i < 3);
    assert.equal(next3.length, 3);
    assert.deepEqual(next3.map(d => d.toISOString()), [
        '2026-07-05T01:00:00.000Z', '2026-07-19T01:00:00.000Z', '2026-08-02T01:00:00.000Z'
    ]);
});

test('parseRecurrence: rejects unknown freq', () => {
    const rule = parseRecurrence({ freq: 'biweekly', dtstart: new Date() });
    assert.equal(rule, null);
});

test('parseRecurrence: rejects a rule with no future occurrence (until before dtstart)', () => {
    const rule = parseRecurrence({
        freq: 'daily', until: '2020-01-01',
        dtstart: new Date('2026-07-04T01:00:00Z')
    });
    assert.equal(rule, null);
});

test('computeNextOccurrence: advances daily rule by exactly one day', () => {
    const rule = parseRecurrence({ freq: 'daily', dtstart: new Date('2026-07-04T01:00:00Z') });
    const stored = rule.toString();
    const next = computeNextOccurrence(stored, new Date('2026-07-04T01:00:00Z'));
    assert.equal(next.toISOString(), '2026-07-05T01:00:00.000Z');
});

test('computeNextOccurrence: returns null once COUNT is exhausted', () => {
    const rule = parseRecurrence({ freq: 'daily', count: 1, dtstart: new Date('2026-07-04T01:00:00Z') });
    const stored = rule.toString();
    const next = computeNextOccurrence(stored, new Date('2026-07-04T01:00:00Z'));
    assert.equal(next, null);
});
