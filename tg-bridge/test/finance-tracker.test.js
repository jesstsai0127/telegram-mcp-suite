const test = require('node:test');
const assert = require('node:assert/strict');
const financeTracker = require('../lib/finance-tracker');

test('getNetworth: 回傳正常 total_by_currency 時直接回傳原始資料', async (t) => {
    t.mock.method(global, 'fetch', async () => ({
        ok: true,
        json: async () => ({
            total_by_currency: { TWD: 42225, USD: 900 },
            accounts_total: { TWD: 30000 },
            holdings_value: { TWD: 12225, USD: 900 }
        })
    }));

    const result = await financeTracker.getNetworth();
    assert.deepEqual(result.total_by_currency, { TWD: 42225, USD: 900 });
});

test('getNetworth: HTTP 非 2xx 時拋錯，不吞例外', async (t) => {
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500 }));

    await assert.rejects(() => financeTracker.getNetworth(), /HTTP 500/);
});

test('getNetworth: 回傳格式對不上（缺 total_by_currency）時拋錯，不靜默回傳殘缺資料', async (t) => {
    t.mock.method(global, 'fetch', async () => ({
        ok: true,
        json: async () => ({ accounts_total: {} })
    }));

    await assert.rejects(() => financeTracker.getNetworth(), /格式不符預期/);
});

test('checkHealth: 非 2xx 時拋錯', async (t) => {
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 503 }));

    await assert.rejects(() => financeTracker.checkHealth(), /HTTP 503/);
});

test('formatNetworth: 依幣別各自成行', () => {
    const text = financeTracker.formatNetworth({
        total_by_currency: { TWD: 42225, USD: 900 }
    });
    assert.match(text, /TWD\s+42,225/);
    assert.match(text, /USD\s+900/);
});

test('UI_URL: 有匯出給 commands.js 組訊息用', () => {
    assert.equal(typeof financeTracker.UI_URL, 'string');
    assert.match(financeTracker.UI_URL, /^https?:\/\//);
});
