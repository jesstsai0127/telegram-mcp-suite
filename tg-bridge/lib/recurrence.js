// 規則性任務的週期運算——包一層 rrule（RFC 5545，github.com/jkbrzt/rrule，BSD-3-Clause）。
// AI 只負責把自然語言抽成結構化欄位（freq/byweekday/bysetpos/count/until/time），
// 實際日期推算（下一次觸發、COUNT/UNTIL 邊界）全部交給 rrule 函式庫算，不是叫 AI 做數學。

const { RRule } = require('rrule');

const WEEKDAY_MAP = { MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH, FR: RRule.FR, SA: RRule.SA, SU: RRule.SU };
const FREQ_MAP = { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY, yearly: RRule.YEARLY };

// fields: { freq: 'daily'|'weekly'|'monthly'|'yearly', byweekday: ['MO','WE',...] 或 null,
//           bysetpos: 整數（第幾週，用於「每月第N個星期X」）或 null,
//           bymonthday: 整數 1-31（用於「每月N號」，或搭配 bymonth 用於「每年N月N號」）或 null,
//           bymonth: 整數 1-12（只有 yearly 才用，例如「每年3月5號」的 3）或 null,
//           interval: 整數（每 N 個單位觸發一次，例如「每兩週」的 2）或 null（等同 1）,
//           count: 整數或 null, until: 'YYYY-MM-DD' 或 null,
//           dtstart: Date（第一次觸發的完整日期時間） }
// bymonthday 跟 byweekday+bysetpos 是兩種不同的「每月」講法（每月5號 vs 每月第二個星期二），
// 互斥，同時給就是輸入有問題，不猜哪個優先，直接判定無效
function buildRule(fields) {
    const freq = FREQ_MAP[fields.freq];
    if (freq === undefined) return null;
    if (fields.byweekday && fields.byweekday.length > 0 && fields.bymonthday) return null;
    // yearly + bymonthday 沒有 bymonth 就是不完整的輸入：RRule 對 FREQ=YEARLY + BYMONTHDAY
    // （沒有 BYMONTH）會展開成「每個月的第N天」而不是「每年一次」，實測驗證過這個地雷，
    // 兩者必須成對出現，不猜哪個月，直接判定無效請使用者講清楚。
    if (fields.freq === 'yearly' && fields.bymonthday && !fields.bymonth) return null;

    const opts = { freq, dtstart: fields.dtstart };

    if (fields.byweekday && fields.byweekday.length > 0) {
        const days = fields.byweekday.map(d => WEEKDAY_MAP[d]).filter(Boolean);
        if (days.length !== fields.byweekday.length) return null; // 有無法辨識的星期代碼
        opts.byweekday = fields.bysetpos
            ? days.map(d => d.nth(fields.bysetpos))
            : days;
    }
    if (fields.bymonthday) opts.bymonthday = [fields.bymonthday];
    if (fields.freq === 'yearly' && fields.bymonth) opts.bymonth = [fields.bymonth];
    if (fields.interval && fields.interval > 1) opts.interval = fields.interval;
    if (fields.count) opts.count = fields.count;
    if (fields.until) opts.until = new Date(`${fields.until}T23:59:59Z`);

    try {
        return new RRule(opts);
    } catch (e) {
        return null;
    }
}

// 驗證用：能不能組出一個有效規則，並且至少算得出下一次時間
function parseRecurrence(fields) {
    const rule = buildRule(fields);
    if (!rule) return null;
    const next = rule.after(fields.dtstart, true);
    if (!next) return null; // 組出來的規則一次都不會觸發（例如 until 早於 dtstart）
    return rule;
}

// icalString 是存在 Notion Recurrence 欄位裡的 rule.toString() 結果
function computeNextOccurrence(icalString, afterDate) {
    const rule = RRule.fromString(icalString);
    return rule.after(afterDate, false); // 不含 afterDate 本身，找下一次
}

// 把 AI 抽出的 recurrence 物件（freq/byweekday/.../time）轉成可以直接存進 Notion 的
// { icalString, firstTrigger }，組不出有效規則就回傳 null（呼叫端請使用者換個講法）。
// dtstart 由呼叫端算好傳入（涉及時區換算，交給呼叫端決定用哪個 TIMEZONE_OFFSET）。
function toStoredFields(r, dtstart) {
    const rule = parseRecurrence({
        freq: r.freq, byweekday: r.byweekday, bysetpos: r.bysetpos, bymonthday: r.bymonthday,
        bymonth: r.bymonth, interval: r.interval, count: r.count, until: r.until, dtstart
    });
    if (!rule) return null;
    return { icalString: rule.toString(), firstTrigger: rule.after(dtstart, true).toISOString() };
}

module.exports = { buildRule, parseRecurrence, computeNextOccurrence, toStoredFields };
