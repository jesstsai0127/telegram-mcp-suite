const test = require('node:test');
const assert = require('node:assert/strict');
const todoFlow = require('../lib/todo-flow');
const { resolveTodoFlow } = todoFlow;

// 2026-07-09：/todo 的按鈕分派邏輯整個拿掉了——「新增一次性」「新增週期性」合併成
// 「新增待辦」，「待辦清單」也改成 WebApp，兩個按鈕現在都是 web_app 類型（點了開表單/
// 開清單頁，不會送出文字訊息），不再需要 pending 狀態機、也不再需要窄範圍分類器
// classifyTodoOnce/classifyTodoRecurring 抽取自由文字（那兩個連同底層的
// tryParseTodoOnce/tryParseTodoRecurring 已經整個移除，被 web_app 表單取代）。

test('menuMessage: 「新增待辦」是 web_app 類型按鈕（合併了原本的一次性/週期性），網址是 HTTPS', () => {
    const menu = todoFlow.menuMessage();
    const firstRow = menu.options.reply_markup.keyboard[0];
    const addButton = firstRow.find(btn => typeof btn === 'object' && btn.text === '新增待辦');
    assert.ok(addButton, '找不到「新增待辦」按鈕');
    assert.ok(addButton.web_app && addButton.web_app.url, 'web_app.url 沒有設定');
    assert.match(addButton.web_app.url, /^https:\/\//, 'Telegram WebApp 網址必須是 HTTPS');
});

test('menuMessage: 「待辦清單」也改成 web_app 類型按鈕，不是純文字連結訊息', () => {
    const menu = todoFlow.menuMessage();
    const firstRow = menu.options.reply_markup.keyboard[0];
    const listButton = firstRow.find(btn => typeof btn === 'object' && btn.text === '待辦清單');
    assert.ok(listButton, '找不到「待辦清單」按鈕');
    assert.ok(listButton.web_app && listButton.web_app.url, 'web_app.url 沒有設定');
    assert.match(listButton.web_app.url, /^https:\/\//, 'Telegram WebApp 網址必須是 HTTPS');
    assert.match(listButton.web_app.url, /\/todo-recurring$/);
});

test('resolveTodoFlow: 兩個按鈕都是 web_app，點了不會送出文字訊息，永遠交給其他 handler（回傳 null）', async () => {
    assert.equal(await resolveTodoFlow('tf-chat-1', '新增待辦'), null);
    assert.equal(await resolveTodoFlow('tf-chat-1', '待辦清單'), null);
    assert.equal(await resolveTodoFlow('tf-chat-1', '隨便打的訊息'), null);
});
