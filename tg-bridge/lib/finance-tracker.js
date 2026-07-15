// finance-tracker（~/finance-tracker，獨立 repo）Phase 1 API 的薄 client。
// 只負責呼叫與格式化，資料本身以 finance-tracker 回傳的原始 JSON 為準，這裡不重算任何數字。
// 帳戶/持股的新增、修改、刪除、清單瀏覽都在網頁 UI 做，這裡只保留 /wealth 查詢需要的部分。

const FINANCE_TRACKER_URL = process.env.FINANCE_TRACKER_URL || 'http://127.0.0.1:3004';
const UI_URL = process.env.FINANCE_TRACKER_UI_URL || 'http://100.104.146.38:3004/net_worth';
// 2026-07-10 起 /net_worth 改成 Telegram WebApp 按鈕（需要 HTTPS）——finance-tracker
// 自己的容器現在同時起 HTTP(3004，不變) + HTTPS(3007，新增，同一份 Tailscale 憑證)，
// 這裡另外指到 HTTPS 那個 port/網址，UI_URL（HTTP）繼續保留給非 Telegram 情境
// （例如直接用瀏覽器打開）當備援參考，不刪掉。
const UI_HTTPS_URL = process.env.FINANCE_TRACKER_UI_HTTPS_URL ||
    `https://yyds.tailbc46d2.ts.net:${process.env.FINANCE_TRACKER_HTTPS_PORT || 3007}/net_worth`;
const LOCALE = process.env.LOCALE || 'zh-TW';

async function checkHealth() {
    const res = await fetch(`${FINANCE_TRACKER_URL}/health`);
    if (!res.ok) throw new Error(`finance-tracker HTTP ${res.status}`);
}

async function getNetworth() {
    const res = await fetch(`${FINANCE_TRACKER_URL}/v1/networth`);
    if (!res.ok) throw new Error(`finance-tracker HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.total_by_currency !== 'object') {
        // API 合約對不上（欄位改了但這裡沒跟著改），不要吞掉繼續顯示殘缺資料
        throw new Error('finance-tracker /v1/networth 回傳格式不符預期（total_by_currency 缺失）');
    }
    return data;
}

function formatNetworth(networth) {
    const lines = Object.entries(networth.total_by_currency).map(
        ([currency, amount]) => `${currency}  ${amount.toLocaleString(LOCALE)}`
    );
    return `目前淨值\n\n${lines.join('\n')}`;
}

module.exports = {
    UI_URL,
    UI_HTTPS_URL,
    checkHealth,
    getNetworth,
    formatNetworth
};
