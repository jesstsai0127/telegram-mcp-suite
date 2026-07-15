const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../lib/commands');
const financeTracker = require('../lib/finance-tracker');

test('handleCommand: 未知指令回傳 null（讓呼叫端轉去一般文字流程）', async () => {
    const result = await commands.handleCommand('/notreal', {});
    assert.equal(result, null);
});

test('handleCommand: /net_worth 回傳淨值文字，並附上開啟 WebApp 的 inline keyboard 按鈕（HTTPS）', async (t) => {
    t.mock.method(financeTracker, 'getNetworth', async () => ({ total_by_currency: { TWD: 100 } }));

    const reply = await commands.handleCommand('/net_worth', {});
    assert.match(reply.text, /目前淨值/);
    assert.match(reply.text, /TWD\s+100/);
    const button = reply.options.reply_markup.inline_keyboard[0][0];
    assert.ok(button.web_app && button.web_app.url, 'web_app.url 沒有設定');
    assert.match(button.web_app.url, /^https:\/\//, 'Telegram WebApp 網址必須是 HTTPS');
    assert.equal(button.web_app.url, financeTracker.UI_HTTPS_URL);
});

test('handleCommand: /net_worth 呼叫失敗時把例外往上丟，不吞掉', async (t) => {
    t.mock.method(financeTracker, 'getNetworth', async () => {
        throw new Error('finance-tracker HTTP 500');
    });

    await assert.rejects(() => commands.handleCommand('/net_worth', {}), /HTTP 500/);
});

test('handleCommand: /shopping 回傳 { text, options } 附 Reply Keyboard（兩個按鈕都是 web_app）', async () => {
    const reply = await commands.handleCommand('/shopping', {});
    assert.match(reply.text, /待買清單/);
    const buttons = reply.options.reply_markup.keyboard.flat();
    assert.ok(buttons.some(btn => typeof btn === 'object' && btn.text === '新增待買' && btn.web_app));
});

test('handleCommand: /settings 回傳一般設定網頁連結', async () => {
    const reply = await commands.handleCommand('/settings', {});
    assert.match(reply, /一般設定/);
    assert.match(reply, /https?:\/\//);
});
