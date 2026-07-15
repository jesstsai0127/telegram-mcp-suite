// shopping.html / todo-recurring.html 用的乾淨資料 API（mock notion，不真的打 Notion）
const test = require('node:test');
const assert = require('node:assert/strict');
const notion = require('../lib/notion');
const router = require('../lib/router');

function fakeShoppingRow({ id, item, type, status, priority, category, buyer, location, quantityNeeded, quantityPurchased, priceEstimate, actualPrice, notes, nextTrigger, purchasedDate }) {
    return {
        id,
        properties: {
            Item: { title: [{ plain_text: item }] },
            Type: { select: type ? { name: type } : null },
            Status: { select: status ? { name: status } : null },
            Priority: { select: priority ? { name: priority } : null },
            Category: { select: category ? { name: category } : null },
            Buyer: { rich_text: buyer ? [{ plain_text: buyer }] : [] },
            Location: { rich_text: location ? [{ plain_text: location }] : [] },
            Notes: { rich_text: notes ? [{ plain_text: notes }] : [] },
            'Quantity Needed': { number: quantityNeeded ?? null },
            'Quantity Purchased': { number: quantityPurchased ?? null },
            'Price Estimate': { number: priceEstimate ?? null },
            'Actual Price': { number: actualPrice ?? null },
            'Next Trigger': { date: nextTrigger ? { start: nextTrigger } : null },
            'Purchased Date': { date: purchasedDate ? { start: purchasedDate } : null }
        }
    };
}

test('shopping_page_data: 待購跟已購買分兩次查詢，回傳乾淨資料', async (t) => {
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        if (filter.select.equals === '待購') {
            return [fakeShoppingRow({
                id: 'p1', item: '衛生紙', type: '週期性', status: '待購', priority: '一般', category: '日常用品',
                buyer: '我自己', nextTrigger: '2026-08-01T01:00:00.000Z'
            })];
        }
        return [fakeShoppingRow({
            id: 'p2', item: '洗衣精', status: '已購', buyer: '室友', location: '全聯',
            quantityPurchased: 2, actualPrice: 150, purchasedDate: '2026-07-06'
        })];
    });

    const result = await router.handleIntent('shopping_page_data', {}, {});
    assert.equal(result.data.pending.length, 1);
    assert.equal(result.data.pending[0].title, '衛生紙');
    assert.equal(result.data.pending[0].type, '週期性');
    assert.equal(result.data.pending[0].category, '日常用品');
    assert.equal(result.data.pending[0].nextTrigger, '2026-08-01 09:00');

    assert.equal(result.data.purchased.length, 1);
    assert.equal(result.data.purchased[0].title, '洗衣精');
    assert.equal(result.data.purchased[0].buyer, '室友');
    assert.equal(result.data.purchased[0].actualPrice, 150);
});

test('shopping_search_history: 沒給 keyword 時只用時間範圍過濾，預設六個月', async (t) => {
    let capturedFilter = null;
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        capturedFilter = filter;
        return [fakeShoppingRow({
            id: 'h1', item: '衛生紙', status: '已購', quantityPurchased: 3, actualPrice: 90, purchasedDate: '2026-06-01'
        })];
    });

    const result = await router.handleIntent('shopping_search_history', {}, {});
    assert.equal(capturedFilter.and.length, 2);
    assert.equal(capturedFilter.and[0].property, 'Status');
    assert.equal(capturedFilter.and[1].property, 'Purchased Date');

    assert.equal(result.data.results.length, 1);
    assert.equal(result.data.results[0].title, '衛生紙');
    assert.equal(result.data.results[0].unitPrice, 30);
});

test('shopping_search_history: 有給 keyword 時加上 Item contains 條件', async (t) => {
    let capturedFilter = null;
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        capturedFilter = filter;
        return [];
    });

    await router.handleIntent('shopping_search_history', { keyword: '洗衣精', monthsBack: 12 }, {});
    assert.equal(capturedFilter.and.length, 3);
    assert.deepEqual(capturedFilter.and[2], { property: 'Item', title: { contains: '洗衣精' } });
});

test('shopping_search_history: 數量或金額缺一個時 unitPrice 是 null，不硬算', async (t) => {
    t.mock.method(notion, 'queryDb', async () => [fakeShoppingRow({
        id: 'h2', item: '牙膏', status: '已購', actualPrice: 50, purchasedDate: '2026-06-01'
    })]);
    const result = await router.handleIntent('shopping_search_history', {}, {});
    assert.equal(result.data.results[0].unitPrice, null);
});

test('todo_recurring_page_data: 回傳一次性待辦、週期性待辦、已完成歷史三份清單', async (t) => {
    let callCount = 0;
    t.mock.method(notion, 'queryDb', async () => {
        callCount += 1;
        if (callCount === 1) {
            return [{
                id: 'o1',
                properties: {
                    Title: { title: [{ plain_text: '交報告' }] },
                    Priority: { select: { name: '高' } },
                    Category: { select: { name: '工作' } },
                    'Due Date': { date: { start: '2026-07-10T04:00:00.000Z' } },
                    Notes: { rich_text: [] }
                }
            }];
        }
        if (callCount === 2) {
            return [{
                id: 't1',
                properties: {
                    Title: { title: [{ plain_text: '運動' }] },
                    Priority: { select: { name: '中' } },
                    Category: { select: { name: '興趣' } },
                    'Next Trigger': { date: { start: '2026-07-08T01:00:00.000Z' } }
                }
            }];
        }
        return [{
            id: 'c1',
            properties: {
                Title: { title: [{ plain_text: '倒垃圾' }] },
                Priority: { select: { name: '低' } },
                Category: { select: { name: '一般' } },
                'Completed Date': { date: { start: '2026-07-07T10:00:00.000Z' } },
                Notes: { rich_text: [] }
            }
        }];
    });

    const result = await router.handleIntent('todo_recurring_page_data', {}, {});
    assert.equal(result.data.oneTime.length, 1);
    assert.equal(result.data.oneTime[0].title, '交報告');
    assert.equal(result.data.oneTime[0].category, '工作');
    assert.equal(result.data.recurring.length, 1);
    assert.equal(result.data.recurring[0].title, '運動');
    assert.equal(result.data.recurring[0].category, '興趣');
    assert.equal(result.data.recurring[0].nextTrigger, '2026-07-08 09:00');
    assert.equal(result.data.completed.length, 1);
    assert.equal(result.data.completed[0].title, '倒垃圾');
    assert.equal(result.data.completed[0].completedDate, '2026-07-07T10:00:00.000Z');
});

test('task_search_history: 有給 keyword 時加上 Title contains 條件，查詢已完成待辦', async (t) => {
    let capturedFilter = null;
    t.mock.method(notion, 'queryDb', async (dbKey, filter) => {
        capturedFilter = filter;
        return [{
            id: 'c2',
            properties: {
                Title: { title: [{ plain_text: '交季報' }] },
                Priority: { select: { name: '高' } },
                Category: { select: null },
                'Completed Date': { date: { start: '2026-06-01T10:00:00.000Z' } },
                Notes: { rich_text: [] }
            }
        }];
    });

    const result = await router.handleIntent('task_search_history', { keyword: '季報', monthsBack: 3 }, {});
    assert.equal(capturedFilter.and.length, 3);
    assert.deepEqual(capturedFilter.and[2], { property: 'Title', title: { contains: '季報' } });
    assert.equal(result.data.results.length, 1);
    assert.equal(result.data.results[0].title, '交季報');
});

test('update_task_field: 只接受白名單欄位，Recurrence 等排程欄位被擋掉', async (t) => {
    let capturedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { capturedFields = fields; });

    await router.handleIntent('update_task_field', {
        pageId: 'task-1',
        changes: { title: '新標題', priority: '高', category: '工作', recurring: { icalString: 'FREQ=DAILY' }, next_trigger: '2026-01-01' }
    }, {});

    assert.equal(capturedFields.Title.title[0].text.content, '新標題');
    assert.equal(capturedFields.Priority.select.name, '高');
    assert.equal(capturedFields.Category.select.name, '工作');
    assert.equal(capturedFields.Recurrence, undefined);
    assert.equal(capturedFields['Next Trigger'], undefined);
});

test('update_task_field: status 可以用來標記完成/取消', async (t) => {
    let capturedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { capturedFields = fields; });

    await router.handleIntent('update_task_field', { pageId: 'task-2', changes: { status: '完成' } }, {});
    assert.equal(capturedFields.Status.select.name, '完成');
});

test('update_shopping_field: 只接受白名單欄位，可以改需要數量/預估價格', async (t) => {
    let capturedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { capturedFields = fields; });

    await router.handleIntent('update_shopping_field', {
        pageId: 'shop-1',
        changes: { quantityNeeded: 3, priceEstimate: 150, category: '日常用品', recurring: { icalString: 'FREQ=WEEKLY' } }
    }, {});

    assert.equal(capturedFields['Quantity Needed'].number, 3);
    assert.equal(capturedFields['Price Estimate'].number, 150);
    assert.equal(capturedFields.Category.select.name, '日常用品');
    assert.equal(capturedFields.Recurrence, undefined);
});

test('update_shopping_field: purchase 會標記已購並帶入購買明細', async (t) => {
    let capturedFields = null;
    t.mock.method(notion, 'updateRecord', async (pageId, fields) => { capturedFields = fields; });

    await router.handleIntent('update_shopping_field', {
        pageId: 'shop-2',
        changes: { purchase: { quantityPurchased: 2, actualPrice: 88, purchasedDate: '2026-07-07' } }
    }, {});

    assert.equal(capturedFields.Status.select.name, '已購');
    assert.equal(capturedFields['Quantity Purchased'].number, 2);
    assert.equal(capturedFields['Actual Price'].number, 88);
});
