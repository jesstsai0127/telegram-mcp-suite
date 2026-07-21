// mentor-tracker（~/mentor-tracker，獨立 repo）API 的薄 client。
// 這個服務沒有自己的 Telegram bot——實際的每日推播跟 WebApp 按鈕由 tg-bridge 自己的
// bot 送出，這裡只負責呼叫它的 action-route 拿組好的推播文字，跟 finance-tracker 的
// 整合方式一致（獨立後端服務 + tg-bridge 新指令去呼叫）。

const MENTOR_TRACKER_URL = process.env.MENTOR_TRACKER_URL || 'http://127.0.0.1:3009';
const UI_HTTPS_URL = process.env.MENTOR_TRACKER_UI_HTTPS_URL ||
    `https://yyds.tailbc46d2.ts.net:${process.env.MENTOR_TRACKER_HTTPS_PORT || 3010}/digest.html`;

async function checkContentFeed() {
    const res = await fetch(`${MENTOR_TRACKER_URL}/actions/check-content-feed`, { method: 'POST' });
    if (!res.ok) throw new Error(`mentor-tracker HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(`mentor-tracker 回報失敗：${data.error}`);
    return data; // { digestText, needsReview }
}

module.exports = { UI_HTTPS_URL, checkContentFeed };
