const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeParams, looksLikeExampleEcho, sanitizeRecurrence, tryParse, INTENTS, isTitleHintValid, resolveWeekdayDate } = require('../lib/intent');

test('sanitizeParams: rejects malformed due_date, keeps valid one', () => {
    const p1 = sanitizeParams('create_record', { entity: 'task', due_date: 'YYYY-MM-DD 或 null' });
    assert.equal(p1.due_date, null);
    const p2 = sanitizeParams('create_record', { entity: 'task', due_date: '2026-07-05 15:00' });
    assert.equal(p2.due_date, '2026-07-05 15:00');
});

// 2026-07-08 真實案例：使用者說「週四晚上」，今天（星期三，2026-07-08）算出來應該是
// 隔天 2026-07-09，但 AI 自己算成了 2026-07-10（星期五）——同一句話重跑一次又算對了，
// 證實是 AI 做日曆算術本身不穩定。resolveWeekdayDate 改用程式碼決定，不信任 AI。
test('resolveWeekdayDate: 「週四」從星期三算起是隔天，不是 AI 錯算的星期五', () => {
    const result = resolveWeekdayDate('提醒我週四晚上要帶水母衣跟海灘褲(晚上9:00)', '2026-07-10 21:00', '2026-07-08');
    assert.equal(result, '2026-07-09 21:00');
});

test('resolveWeekdayDate: 今天當天就是那個星期幾時，維持算成今天（口語「週四」在星期四當天說通常指今天）', () => {
    // 2026-07-09 是星期四
    const result = resolveWeekdayDate('週四晚上要交報告', '2026-07-09', '2026-07-09');
    assert.equal(result, '2026-07-09');
});

test('resolveWeekdayDate: 「下週X」要多加7天，不是本週最近的那個X', () => {
    // 2026-07-08 是星期三，下週三應該是 7/15，不是本週已經過去的 7/8 或算錯的其他天
    const result = resolveWeekdayDate('下週三要交報告', '隨便', '2026-07-08');
    assert.equal(result, '2026-07-15');
});

test('resolveWeekdayDate: 「下下週X」要多加14天', () => {
    const result = resolveWeekdayDate('下下週三要交報告', '隨便', '2026-07-08');
    assert.equal(result, '2026-07-22');
});

test('resolveWeekdayDate: 沒提到星期幾字樣時，原樣放行 AI 的值（今天/明天這種不受影響）', () => {
    const result = resolveWeekdayDate('明天下午看牙醫', '2026-07-09 15:00', '2026-07-08');
    assert.equal(result, '2026-07-09 15:00');
});

test('sanitizeParams: modify_record changes.due_date also sanitized', () => {
    const p = sanitizeParams('modify_record', { changes: { due_date: 'not-a-date' } });
    assert.equal(p.changes.due_date, null);
});

test('looksLikeExampleEcho: catches a title that exactly matches the prompt example and is absent from the original text', () => {
    const isEcho = looksLikeExampleEcho('create_record', { entity: 'task', title: '明天下午開會' }, '提醒我明天下午一點看屋');
    assert.equal(isEcho, true);
});

test('looksLikeExampleEcho: does not flag when the example text genuinely appears in the user message', () => {
    const isEcho = looksLikeExampleEcho('create_record', { entity: 'task', title: '明天下午開會' }, '待辦：明天下午開會');
    assert.equal(isEcho, false);
});

test('looksLikeExampleEcho: only applies to create_record', () => {
    const isEcho = looksLikeExampleEcho('query_records', { entity: 'task', title: '明天下午開會' }, '隨便');
    assert.equal(isEcho, false);
});

test('sanitizeRecurrence: valid weekly recurrence passes through', () => {
    const r = sanitizeRecurrence({ freq: 'weekly', byweekday: ['MO', 'WE', 'FR'], time: '07:00' });
    assert.deepEqual(r, { freq: 'weekly', byweekday: ['MO', 'WE', 'FR'], time: '07:00' });
});

test('sanitizeRecurrence: invalid freq returns null', () => {
    assert.equal(sanitizeRecurrence({ freq: 'biweekly' }), null);
});

test('sanitizeRecurrence: filters out invalid weekday codes, defaults missing time to 09:00', () => {
    const r = sanitizeRecurrence({ freq: 'weekly', byweekday: ['MO', 'XX'] });
    assert.deepEqual(r.byweekday, ['MO']);
    assert.equal(r.time, '09:00');
});

test('sanitizeRecurrence: null/non-object input returns null', () => {
    assert.equal(sanitizeRecurrence(null), null);
    assert.equal(sanitizeRecurrence(undefined), null);
});

test('sanitizeRecurrence: yearly with bymonth+bymonthday passes through', () => {
    const r = sanitizeRecurrence({ freq: 'yearly', bymonthday: 5, bymonth: 3, time: '09:00' });
    assert.deepEqual(r, { freq: 'yearly', bymonthday: 5, bymonth: 3, time: '09:00' });
});

test('sanitizeRecurrence: out-of-range bymonth is dropped', () => {
    const r = sanitizeRecurrence({ freq: 'yearly', bymonth: 13 });
    assert.equal(r.bymonth, undefined);
});

test('sanitizeRecurrence: interval > 1 kept, interval of 1 dropped (implicit default)', () => {
    const r1 = sanitizeRecurrence({ freq: 'weekly', interval: 2 });
    assert.equal(r1.interval, 2);
    const r2 = sanitizeRecurrence({ freq: 'weekly', interval: 1 });
    assert.equal(r2.interval, undefined);
});

test('sanitizeParams: health entity — invalid enum values dropped, valid ones kept', () => {
    const p1 = sanitizeParams('create_record', { entity: 'health', status: '不適', energy_level: '低', sleep_hours: 6, date: '2026-07-06' });
    assert.equal(p1.status, '不適');
    assert.equal(p1.energy_level, '低');
    assert.equal(p1.sleep_hours, 6);
    assert.equal(p1.date, '2026-07-06');

    const p2 = sanitizeParams('create_record', { entity: 'health', status: '亂填的值', sleep_hours: '六小時', date: '不是日期' });
    assert.equal(p2.status, null);
    assert.equal(p2.sleep_hours, null);
    assert.equal(p2.date, null);
});

test('sanitizeParams: diet entity — meal_type/calories validated', () => {
    const p1 = sanitizeParams('create_record', { entity: 'diet', meal_type: '午餐', calories: 650 });
    assert.equal(p1.meal_type, '午餐');
    assert.equal(p1.calories, 650);

    const p2 = sanitizeParams('create_record', { entity: 'diet', meal_type: '消夜', calories: '很多' });
    assert.equal(p2.meal_type, null);
    assert.equal(p2.calories, null);
});

test('sanitizeParams: activity entity — type/intensity/duration validated', () => {
    const p1 = sanitizeParams('create_record', { entity: 'activity', type: '運動', intensity: '中', duration: 30 });
    assert.equal(p1.type, '運動');
    assert.equal(p1.intensity, '中');
    assert.equal(p1.duration, 30);

    const p2 = sanitizeParams('create_record', { entity: 'activity', type: '打電動', duration: '半小時' });
    assert.equal(p2.type, null);
    assert.equal(p2.duration, null);
});

test('sanitizeParams: task/shopping entity — category 自由文字欄位，空白字串當沒填', () => {
    const t1 = sanitizeParams('create_record', { entity: 'task', title: '運動', category: '興趣' });
    assert.equal(t1.category, '興趣');
    const t2 = sanitizeParams('create_record', { entity: 'task', title: '開會', category: '  ' });
    assert.equal(t2.category, null);

    const s1 = sanitizeParams('create_record', { entity: 'shopping', title: '牙膏', category: '日常用品' });
    assert.equal(s1.category, '日常用品');
});

test('sanitizeParams: shopping entity — 2026-07-07 真實案例，金額/地點要轉成 toCreateFields 認得的 camelCase，不能被無聲丟棄進 notes', () => {
    const p1 = sanitizeParams('create_record', {
        entity: 'shopping', title: '牙膏', priority: null, buyer: null,
        location: '蝦皮', quantity_needed: null, price_estimate: 300
    });
    assert.equal(p1.location, '蝦皮');
    assert.equal(p1.priceEstimate, 300);
    assert.equal(p1.buyer, null);

    const p2 = sanitizeParams('create_record', {
        entity: 'shopping', title: '衛生紙', priority: '亂填的值', quantity_needed: '兩包'
    });
    assert.equal(p2.priority, null);
    assert.equal(p2.quantityNeeded, null);
});

test('sanitizeParams: shopping entity — 2026-07-08 真實案例，一般聊天分類器（非 /shopping 窄流程）也要把 due_date 洗過、單數 reminder 轉成複數 reminders，不然出國前買 sim 卡這種到期提醒永遠不會被排上', () => {
    const p1 = sanitizeParams('create_record', {
        entity: 'shopping', title: 'sim卡', due_date: '2026-07-15', reminder: '1小時前'
    });
    assert.equal(p1.due_date, '2026-07-15');
    assert.deepEqual(p1.reminders, ['1小時前']);

    const p2 = sanitizeParams('create_record', { entity: 'shopping', title: '衛生紙', due_date: null, reminder: null });
    assert.equal(p2.due_date, null);
    assert.equal(p2.reminders, null);

    const p3 = sanitizeParams('create_record', { entity: 'shopping', title: '牙膏', due_date: '不是日期格式' });
    assert.equal(p3.due_date, null);
});

test('looksLikeExampleEcho: health entity echoes example symptoms via the symptoms field, not title', () => {
    const isEcho = looksLikeExampleEcho('create_record', { entity: 'health', symptoms: '拉肚子' }, '我今天心情不錯');
    assert.equal(isEcho, true);
    const notEcho = looksLikeExampleEcho('create_record', { entity: 'health', symptoms: '拉肚子' }, '今天拉肚子好幾次');
    assert.equal(notEcho, false);
});

test('looksLikeExampleEcho: diet/activity entities still checked via title field', () => {
    assert.equal(looksLikeExampleEcho('create_record', { entity: 'diet', title: '牛肉麵' }, '隨便打的訊息'), true);
    assert.equal(looksLikeExampleEcho('create_record', { entity: 'activity', title: '跑步' }, '隨便打的訊息'), true);
    assert.equal(looksLikeExampleEcho('create_record', { entity: 'diet', title: '牛肉麵' }, '午餐吃牛肉麵'), false);
});

test('tryParse: valid JSON with a known intent parses successfully', () => {
    const result = tryParse('{"intent":"query_records","params":{"entity":"task"}}', '今天有什麼待辦');
    assert.deepEqual(result, { intent: 'query_records', params: { entity: 'task' } });
});

test('tryParse: unknown intent name is rejected (triggers fallback, not "unknown")', () => {
    const result = tryParse('{"intent":"delete_everything","params":{}}', '隨便');
    assert.equal(result, null);
});

test('tryParse: unparseable text returns null', () => {
    assert.equal(tryParse('這不是 JSON', '隨便'), null);
});

test('isTitleHintValid: 真的是原文子字串才算合格', () => {
    assert.equal(isTitleHintValid('倒垃圾費', '倒垃圾費那筆不用了'), true);
    assert.equal(isTitleHintValid('', '隨便'), false);
    assert.equal(isTitleHintValid(null, '隨便'), false);
});

test('isTitleHintValid: 跳字/改寫過的 hint 不是連續子字串，判定不合格（真實案例：AI 把「Jaina 專案是否需要預訂 PVT 機器」抽成「Jaina 專案預訂 PVT 機器」，跳過中間「是否需要」）', () => {
    const original = '確認這次 Jaina 專案是否需要預訂 PVT 機器';
    const brokenHint = 'Jaina 專案預訂 PVT 機器';
    assert.equal(isTitleHintValid(brokenHint, original), false);
});

test('tryParse: modify_record 的 title_hint 不是原文子字串時視為不可信輸出（回 null 讓呼叫端 fallback）', () => {
    const raw = '{"intent":"modify_record","params":{"entity":"task","title_hint":"Jaina 專案預訂 PVT 機器","action":"修改","changes":{},"scope":null}}';
    const result = tryParse(raw, '確認這次 Jaina 專案是否需要預訂 PVT 機器');
    assert.equal(result, null);
});

test('tryParse: modify_record 的 title_hint 真的是原文子字串時正常通過', () => {
    const raw = '{"intent":"modify_record","params":{"entity":"task","title_hint":"倒垃圾費","action":"取消","changes":{},"scope":null}}';
    const result = tryParse(raw, '倒垃圾費那筆不用了');
    assert.equal(result.intent, 'modify_record');
    assert.equal(result.params.title_hint, '倒垃圾費');
});

test('INTENTS is the expected fixed set', () => {
    assert.deepEqual(INTENTS, [
        'create_record', 'query_records', 'modify_record',
        'web_search', 'persona_feedback', 'skill_route', 'unknown'
    ]);
});
