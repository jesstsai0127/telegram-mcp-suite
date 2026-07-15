// check_reminders 的一次性任務分支：這次觸發的是「提前通知」（還有更接近到期的 offset 沒發過）
// 就推進 Next Trigger 到下一個，都發完了才真的清空——mock notion，不打真的 API。
const test = require('node:test');
const assert = require('node:assert/strict');
const notion = require('../lib/notion');
const router = require('../lib/router');

function fakeOneTimeTaskRow({ id, title, dueDateISO, nextTriggerISO, reminderOffsets }) {
    return {
        id,
        properties: {
            Title: { title: [{ plain_text: title }] },
            Type: { select: { name: '單次' } },
            'Due Date': { date: { start: dueDateISO } },
            'Next Trigger': { date: { start: nextTriggerISO } },
            'Reminder Offsets': { rich_text: reminderOffsets ? [{ plain_text: reminderOffsets }] : [] }
        }
    };
}

test('check_reminders: 觸發的是 24小時前那筆，還有 1小時前沒發過，推進 Next Trigger 不清空', async (t) => {
    const due = '2026-07-10T12:00:00.000Z';
    const firedAt = '2026-07-09T12:00:00.000Z'; // 24小時前
    t.mock.method(notion, 'findDueReminders', async () => [
        fakeOneTimeTaskRow({ id: 't1', title: '交報告', dueDateISO: due, nextTriggerISO: firedAt, reminderOffsets: '1440,60' })
    ]);
    let advancedTo = null;
    t.mock.method(notion, 'advanceRecurrence', async (pageId, nextISO) => { advancedTo = { pageId, nextISO }; });
    let cleared = false;
    t.mock.method(notion, 'clearReminder', async () => { cleared = true; });

    await router.handleIntent('check_reminders', {}, {});
    assert.equal(cleared, false);
    assert.equal(advancedTo.pageId, 't1');
    assert.equal(advancedTo.nextISO, '2026-07-10T11:00:00.000Z'); // 1小時前
});

test('check_reminders: 觸發的是最後一筆（1小時前），沒有更早的 offset 了，清空 Next Trigger', async (t) => {
    const due = '2026-07-10T12:00:00.000Z';
    const firedAt = '2026-07-10T11:00:00.000Z'; // 1小時前，已經是清單裡最接近到期的
    t.mock.method(notion, 'findDueReminders', async () => [
        fakeOneTimeTaskRow({ id: 't2', title: '交報告', dueDateISO: due, nextTriggerISO: firedAt, reminderOffsets: '1440,60' })
    ]);
    let advanced = false;
    t.mock.method(notion, 'advanceRecurrence', async () => { advanced = true; });
    let clearedId = null;
    t.mock.method(notion, 'clearReminder', async (pageId) => { clearedId = pageId; });

    await router.handleIntent('check_reminders', {}, {});
    assert.equal(advanced, false);
    assert.equal(clearedId, 't2');
});

test('check_reminders: 只設了一筆提醒（沒有多筆）時，觸發後直接清空，行為跟舊版一致', async (t) => {
    const due = '2026-07-10T12:00:00.000Z';
    const firedAt = '2026-07-09T12:00:00.000Z';
    t.mock.method(notion, 'findDueReminders', async () => [
        fakeOneTimeTaskRow({ id: 't3', title: '單一提醒任務', dueDateISO: due, nextTriggerISO: firedAt, reminderOffsets: '1440' })
    ]);
    let advanced = false;
    t.mock.method(notion, 'advanceRecurrence', async () => { advanced = true; });
    let clearedId = null;
    t.mock.method(notion, 'clearReminder', async (pageId) => { clearedId = pageId; });

    await router.handleIntent('check_reminders', {}, {});
    assert.equal(advanced, false);
    assert.equal(clearedId, 't3');
});
