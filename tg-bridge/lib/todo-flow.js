// /todo 獨立技能：跳過 intent.js 的 7-entity 分類器，靠 Reply Keyboard 按鈕明確選子流程。
// 2026-07-08 簡化：拿掉「取消/刪除」「修改一次性」「修改週期性」——這些全部要靠 AI 猜
// 使用者要改哪一筆、改什麼，但 todo-recurring.html 網頁上每張卡片本來就有「編輯/標記完成/
// 取消」按鈕，功能完全重疊；查過 UX 研究，「修改一個看得到的項目」屬於 options are clear、
// visible objects 的情境，direct manipulation（網頁表單）比 conversational UI 更快、更少出錯，
// AI 解析只多一層猜錯風險，沒有對應的好處。
//
// 2026-07-09：「新增一次性」「新增週期性」合併成一個「新增待辦」按鈕。之前拒絕合併
// 是因為當時唯一的合併方式是靠「每」這個字去猜使用者是要一次性還是週期性，那是文字
// 猜測、跟上面拿掉 AI 猜測是同一個問題。現在改成 Telegram WebApp 表單，「重複」是表單
// 上明確的開關（開了才顯示頻率/星期幾這些欄位），使用者自己勾選、不是猜測，所以這次
// 合併不違反同一個原則。「待辦清單」也一起改成 WebApp 開啟（todo-recurring.html），
// 跟新增用同一種體驗，不再是「先回一則連結訊息、使用者自己點開」。

const TODO_RECURRING_UI_URL = process.env.TODO_RECURRING_UI_URL ||
    `http://100.104.146.38:${process.env.TODAY_PORT || 3005}/todo-recurring`;
// HTTPS port 預設用 TODAY_PORT+1（衍生不新增，跟 server.js 同一個推算邏輯，
// 測試環境不需要為此另外設定任何環境變數）
const HTTPS_PORT = process.env.TODAY_HTTPS_PORT || (Number(process.env.TODAY_PORT || 3005) + 1);
const TODO_ADD_UI_URL = process.env.TODO_ADD_UI_URL ||
    `https://yyds.tailbc46d2.ts.net:${HTTPS_PORT}/todo-add`;
// web_app 按鈕強制要求 HTTPS，todo-recurring.html 原本是 HTTP 唯讀連結，這裡改指到
// 跟 todo-add 同一個 HTTPS listener（同一個 todayApp，路由本來就都有掛）
const TODO_RECURRING_WEBAPP_URL = process.env.TODO_RECURRING_WEBAPP_URL ||
    `https://yyds.tailbc46d2.ts.net:${HTTPS_PORT}/todo-recurring`;

const KEYBOARD_OPTIONS = {
    reply_markup: {
        keyboard: [
            [
                { text: '新增待辦', web_app: { url: TODO_ADD_UI_URL } },
                { text: '待辦清單', web_app: { url: TODO_RECURRING_WEBAPP_URL } }
            ]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

function menuMessage() {
    return { text: '📋 待辦事項，請選擇：', options: KEYBOARD_OPTIONS };
}

// 回傳 { text } 或 null（null 代表這則訊息不是 /todo 流程的一部分，交給其他 handler 處理）
// 2026-07-09：兩個按鈕都改成 web_app，點了是開表單/開清單頁，不會送出文字訊息，
// 所以這裡不再需要任何 pending 狀態機——保留這個函式簽名只是為了 server.js 呼叫端
// 介面不變，內容單純變成「不是 /todo 流程的一部分」永遠回 null，交給其他 handler。
async function resolveTodoFlow() {
    return null;
}

module.exports = { menuMessage, resolveTodoFlow };
