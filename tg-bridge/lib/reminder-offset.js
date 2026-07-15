// 提醒時機换算成「提前幾分鐘」——刻意用規則解析，不透過 AI 判斷數字換算，
// 避免把「3小時前該等於幾分鐘」這種純算術問題交給模型去猜。

const PRESETS = {
    '半天前': 12 * 60,
    '半天': 12 * 60,
    '一天前': 24 * 60,
    '一天': 24 * 60,
    '24小時前': 24 * 60,
    '24小時': 24 * 60,
    '一小時前': 60,
    '一小時': 60,
    '1小時前': 60,
    '1小時': 60
};

const CUSTOM_RE = /^(\d+)\s*(分鐘|小時|天)前?$/;

function parseReminderOffsetMinutes(phrase) {
    if (!phrase) return null;
    const trimmed = phrase.trim();
    if (PRESETS[trimmed] !== undefined) return PRESETS[trimmed];

    const match = trimmed.match(CUSTOM_RE);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === '分鐘') return amount;
    if (unit === '小時') return amount * 60;
    if (unit === '天') return amount * 24 * 60;
    return null;
}

// 多筆提醒（Task 到期提醒／Shopping 週期觸發提前通知共用）：跟 Outlook「自動捨棄已過期的
// 提醒」（2025 年起新版 Outlook 預設行為）同一個原則——offsets 裡任何一個算出來的提醒時間點，
// 如果比 now 還早，代表已經沒有意義，直接濾掉，不會補發。剩下的挑最快到的當下一個觸發點。
const DEFAULT_REMINDER_OFFSETS_MINUTES = [24 * 60, 60]; // 預設 24 小時前 + 1 小時前

function computeNextReminderTrigger(anchorMoment, offsetsMinutes, now) {
    const candidates = offsetsMinutes
        .map(offsetMin => ({ offsetMin, trigger: new Date(anchorMoment.getTime() - offsetMin * 60000) }))
        .filter(c => c.trigger > now)
        .sort((a, b) => a.trigger - b.trigger);

    if (candidates.length === 0) return null;
    return { trigger: candidates[0].trigger, offsetMin: candidates[0].offsetMin };
}

function offsetsToStoredString(offsetsMinutes) {
    return offsetsMinutes.join(',');
}

function offsetsFromStoredString(stored) {
    if (!stored) return [...DEFAULT_REMINDER_OFFSETS_MINUTES];
    const parsed = stored.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);
    return parsed.length > 0 ? parsed : [...DEFAULT_REMINDER_OFFSETS_MINUTES];
}

// 純粹給確認訊息顯示用，跟 parseReminderOffsetMinutes 反過來——不用求精確互逆，
// 只要使用者看得懂「這筆任務設了哪些提醒」即可
function formatOffsetMinutes(minutes) {
    if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}天前`;
    if (minutes % 60 === 0) return `${minutes / 60}小時前`;
    return `${minutes}分鐘前`;
}

module.exports = {
    parseReminderOffsetMinutes, computeNextReminderTrigger, formatOffsetMinutes,
    offsetsToStoredString, offsetsFromStoredString, DEFAULT_REMINDER_OFFSETS_MINUTES
};
