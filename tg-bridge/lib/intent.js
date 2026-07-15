const ai = require('./ai');
const { todayStr, TIMEZONE } = require('./format');

// 通用意圖：create/query/modify 三個動作各自跨 idea/task/shopping/project 這幾個 entity 共用，
// 不因為 entity 不同而多開一個意圖——新增一種資料類型的操作方式時，只需要多寫 entity 判斷邏輯，
// 不需要在這裡新增新的意圖名稱。
const INTENTS = [
    'create_record', 'query_records', 'modify_record',
    'web_search', 'persona_feedback', 'skill_route', 'unknown'
];

// 意圖解析先試本機 Ollama（Level 1，gemma4:12b），輸出經下面的防呆機制驗證通過才採用；
// 驗證不過（含呼叫失敗、JSON 解析失敗、echo 偵測）就 fallback 到 AI Gateway（Level 2）。
// 之前用 qwen2.5:3b 時曾經整層拿掉 Ollama，是因為那顆小模型會把提示詞裡的 few-shot 範例
// 當成答案直接抄回來；現在換更大的模型回來試，但防呆機制原封不動保留當保險。
function buildSystemPrompt() {
    return `你是意圖分類器。根據「使用者訊息」判斷意圖並抽取相關欄位，只輸出 JSON，不要任何其他文字或說明。

今天的實際日期是 ${todayStr()}（${TIMEZONE}）。所有相對日期（今天、明天、下週三等）都要以這個日期為基準換算成 YYYY-MM-DD；使用者只給月/日沒給年份時，年份也用這個日期推算，除非明顯是指未來或過去的其他年份。不知道確切日期時，寧可填 null，絕對不能自己編造一個日期。

以下每個意圖後面的「例」只是格式示範，絕對不能把示範內容當成答案抄回來——所有欄位值都必須來自「使用者訊息」本身。

意圖清單：
- create_record：新增一筆紀錄（點子/待辦/購物/身體狀況/飲食/運動休息），例「想到一個點子：用 AI 整理筆記」「待辦：明天下午開會」「要買衛生紙」「今天精神不好，拉肚子，睡了6小時」「午餐吃了牛肉麵」「剛跑步30分鐘」
  → params: {
      "entity": "idea" 或 "task" 或 "shopping" 或 "health" 或 "diet" 或 "activity",
      "title": "..."（health 不需要這個欄位，diet/activity 是活動描述，例如「牛肉麵」「跑步」）,
      "content": null 或補充內容（只有 idea 會用到）,
      "due_date": null 或 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"（單次 task 或單次 shopping 都可能用到，例如「出國前一週要買sim卡」這種有到期壓力的購物項目也要填；只是單純想買、沒有時間壓力的 shopping 就是 null，有提到具體時間就帶時間，不要照抄範例格式字串）,
      "reminder": null 或使用者原話描述的提醒時機，例如「半天前」「1小時前」（單次 task 或單次 shopping 只要有 due_date 且使用者有要求提醒時才填，不要自己換算成數字；沒有 due_date 的話這個也一定是 null）,
      "priority": null 或「急需/一般/想買」（只有 shopping 會用到，task 的優先度不是這個欄位，一般聊天分類器目前不抽 task 優先度，維持既有行為）,
      "buyer": null 或使用者提到的購買人（只有 shopping 會用到，沒提到就是 null，程式會補預設值「我自己」）,
      "location": null 或購買地點（只有 shopping 會用到）,
      "category": null 或使用者提到的分類（task/shopping 都會用到，例如「一般/日常用品/工作/興趣」，或使用者自己講的其他分類詞，沒提到就是 null，程式會補預設值「一般」）,
      "quantity_needed": null 或數字（只有 shopping 會用到，需要購買的數量）,
      "price_estimate": null 或數字（只有 shopping 會用到，預估金額）,
      "status": null 或「良好/普通/不適」（只有 health 會用到，使用者沒明說就依語氣判斷，例如「精神不好」「不舒服」判斷為不適）,
      "symptoms": null 或使用者描述的症狀（只有 health 會用到，例如「拉肚子」「頭痛」）,
      "energy_level": null 或「高/中/低」（只有 health 會用到，使用者有提到精神狀態才填）,
      "sleep_hours": null 或數字（只有 health 會用到，使用者提到睡眠時數才填，單位是小時）,
      "meal_type": null 或「早餐/午餐/晚餐/點心」（只有 diet 會用到，依使用者提到的時段判斷，沒提到就依現在時間概略判斷）,
      "calories": null 或數字（只有 diet 會用到，使用者明確提到卡路里才填，不要自己估算）,
      "type": null 或「運動/休息/伸展」（只有 activity 會用到）,
      "duration": null 或數字（只有 activity 會用到，單位是分鐘，使用者沒提到時長就填 null，不要自己猜）,
      "intensity": null 或「高/中/低」（只有 activity 會用到，使用者有提到強度才填）,
      "date": null 或 "YYYY-MM-DD"（health/diet/activity 會用到，使用者說「今天」或沒提到日期就填 null，程式會自動用今天，不要自己填今天的日期字串）,
      "notes": null 或補充說明（health/diet/activity 共用，不是每次都要填）,
      "recurrence": null 或（只有使用者描述「重複性」任務時才填，例如「每天」「每週一三五」「每月5號」「每月第二個星期二」「每兩週」「每年生日」，跟 due_date 互斥，只填一種）{
        "freq": "daily" 或 "weekly" 或 "monthly" 或 "yearly",
        "byweekday": null 或 ["MO","TU","WE","TH","FR","SA","SU"] 的子集（只填使用者實際提到的星期幾，兩碼代號，一週的第一天算星期一=MO；「每月N號」這種按日期算的不要填這個）,
        "bysetpos": null 或整數（只有「每月第N個星期X」這種說法才填，例如「第二個星期二」的 N=2；單純「每月N號」不要填這個，那個是 bymonthday）,
        "bymonthday": null 或整數 1-31（只有「每月N號」「每月第N天」「每年N月N號」這種按日期算的週期才填，例如「每月5號」的 N=5、「每年3月5號」的 N=5；跟 byweekday/bysetpos 互斥，只填一種）,
        "bymonth": null 或整數 1-12（只有 freq 是 yearly 且使用者提到具體月份才填，例如「每年3月5號」的 3；freq 是 yearly 且填了 bymonthday 就一定要一起填 bymonth，兩者必須成對出現，不能只給其中一個）,
        "interval": null 或整數（使用者明確說「每N天/週/月/年」這種間隔才填，例如「每兩週」的 freq=weekly、interval=2；沒特別說間隔就是 null，代表每 1 個單位觸發一次）,
        "count": null 或整數（使用者明確說「重複N次」「共N次」才填，沒說就是 null，代表無限重複到取消為止）,
        "until": null 或 "YYYY-MM-DD"（使用者明確說結束日期/月份才填）,
        "time": "HH:MM"（每次觸發的時間，使用者原話有提到就用原話，沒提到就填 "09:00"）
      }
    }
- query_records：查詢一份清單或整體狀況總覽，例「今天有什麼待辦？」「購物清單有什麼？」「我說過哪些點子？」「專案進度如何？」「最近身體狀況如何？」「這幾天吃了什麼？」「最近運動紀錄？」——判斷關鍵是使用者要「一份清單」或「整體進度」，不是句子裡剛好出現「專案」「待辦」這類字眼就算。如果句子其實是在描述一件具體的事（例如某個任務的完整內容，即使裡面提到「專案」兩個字），不要只因為出現這些關鍵字就判斷成 query_records，改考慮 create_record 或 modify_record。
  → params: { "entity": "task" 或 "shopping" 或 "idea" 或 "project" 或 "health" 或 "diet" 或 "activity" }
- modify_record：修改、取消、或完成某個既有紀錄，例「取消看屋那個待辦」「完成報告那件事」「把看屋改到晚上八點」「幫我把衛生紙改成想買」「刪除倒垃圾費那筆」「刪掉續約保險那個提醒」
  → params: {
      "entity": "task" 或 "shopping" 或 "idea",
      "title_hint": "必須是使用者原文中連續出現的子字串（可以只取一部分，但不能跳過中間的字、不能重組語序或改寫），不是完整標題",
      "action": "取消" 或 "完成" 或 "修改"（使用者說「刪除」「刪掉」「移除」也對應到「取消」——目前沒有真正永久刪除紀錄的能力，「取消」只是標記狀態，紀錄還在可回溯）,
      "changes": {}（只有 action 是「修改」才需要，欄位視 entity 而定：task 可以有 title/due_date/priority/category，shopping 可以有 title/priority/category，idea 可以有 title/content，其餘留空即可）,
      "scope": null 或使用者提到的時間範圍描述（例如「這個月」「7月」）
    }
- web_search：需要上網查資料，例「查一下台灣今年 GDP」→ params: { "search_query": "...", "force_refresh": true/false }
- persona_feedback：對 AXIS 回應風格的反饋，例「回應太長了」→ params: { "feedback": "..." }
- unknown：無法判斷意圖 → params: {}

輸出格式範例（僅示範 JSON 結構，內容值不可沿用）：{"intent": "create_record", "params": {"entity": "shopping", "title": "衛生紙", "priority": "急需"}}

使用者說「刪除倒垃圾費那筆」→ {"intent": "modify_record", "params": {"entity": "task", "title_hint": "倒垃圾費", "action": "取消", "changes": {}, "scope": null}}（「刪除/刪掉/移除」都對應 action:"取消"，不是不同的動作）
使用者說「牙膏 金額300 地點蝦皮」→ {"intent": "create_record", "params": {"entity": "shopping", "title": "牙膏", "priority": null, "buyer": null, "location": "蝦皮", "quantity_needed": null, "price_estimate": 300}}（金額/地點這類使用者明講的細節要拆進對應欄位，不能整句塞進 notes）
使用者說「下週三出國前要買好sim卡，提前一小時提醒我」→ {"intent": "create_record", "params": {"entity": "shopping", "title": "sim卡", "due_date": "2026-07-15", "reminder": "1小時前"}}（購物項目有時間壓力時也要填 due_date，不是只有 task 才能有到期日）

健康/飲食/運動範例（僅示範結構，內容值不可沿用）：
使用者說「今天精神不好，拉肚子，昨晚睡了6小時」→ {"intent": "create_record", "params": {"entity": "health", "status": "不適", "symptoms": "拉肚子", "energy_level": "低", "sleep_hours": 6, "date": null, "notes": null}}
使用者說「午餐吃了牛肉麵」→ {"intent": "create_record", "params": {"entity": "diet", "title": "牛肉麵", "meal_type": "午餐", "date": null, "calories": null, "notes": null}}
使用者說「剛跑步30分鐘，強度中等」→ {"intent": "create_record", "params": {"entity": "activity", "title": "跑步", "type": "運動", "duration": 30, "intensity": "中", "date": null, "notes": null}}

重複性任務範例（僅示範結構，內容值不可沿用）：
使用者說「每週一三五早上七點提醒我運動」→ {"intent": "create_record", "params": {"entity": "task", "title": "運動", "due_date": null, "recurrence": {"freq": "weekly", "byweekday": ["MO","WE","FR"], "bysetpos": null, "count": null, "until": null, "time": "07:00"}}}
使用者說「每月第二個星期二下午兩點開會，重複3次」→ {"intent": "create_record", "params": {"entity": "task", "title": "開會", "due_date": null, "recurrence": {"freq": "monthly", "byweekday": ["TU"], "bysetpos": 2, "bymonthday": null, "count": 3, "until": null, "time": "14:00"}}}
使用者說「每個月5號提醒我要檢查SUNO點數」→ {"intent": "create_record", "params": {"entity": "task", "title": "檢查 SUNO 點數", "due_date": null, "recurrence": {"freq": "monthly", "byweekday": null, "bysetpos": null, "bymonthday": 5, "interval": null, "count": null, "until": null, "time": "09:00"}}}
使用者說「每兩週提醒我倒垃圾費」→ {"intent": "create_record", "params": {"entity": "task", "title": "繳垃圾費", "due_date": null, "recurrence": {"freq": "weekly", "byweekday": null, "bysetpos": null, "bymonthday": null, "bymonth": null, "interval": 2, "count": null, "until": null, "time": "09:00"}}}
使用者說「每年3月5號提醒我續約保險」→ {"intent": "create_record", "params": {"entity": "task", "title": "續約保險", "due_date": null, "recurrence": {"freq": "yearly", "byweekday": null, "bysetpos": null, "bymonthday": 5, "bymonth": 3, "interval": null, "count": null, "until": null, "time": "09:00"}}}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

// 即使換了更可靠的模型，這兩層防護仍保留當作便宜的保險，不因為模型變好就拿掉。
const EXAMPLE_ECHOES = {
    idea: ['用 AI 整理筆記'],
    task: ['明天下午開會'],
    shopping: ['衛生紙'],
    diet: ['牛肉麵'],
    activity: ['跑步']
};
// health 沒有 title 欄位，抄範例的話最可能抄 symptoms（範例是「拉肚子」），另外檢查這個欄位
const HEALTH_EXAMPLE_ECHO_SYMPTOMS = ['拉肚子'];

// 2026-07-07 真實案例：即使 prompt 已經明講「title_hint 必須是原文連續子字串」，模型仍可能
// 跳字/改寫（例如把「Jaina 專案是否需要預訂 PVT 機器」抽成「Jaina 專案預訂 PVT 機器」，
// 跳過中間「是否需要」）。這種 hint 拿去給 Notion 的 contains 搜尋一定找不到，與其讓使用者
// 收到誤導性的「找不到符合的紀錄」，這裡用程式碼直接擋掉不可信的輸出，讓呼叫端 fallback
// 到下一層模型（Level1 不合格就試 Level2，兩層都不合格才真的視為 unknown/請使用者換講法）。
function isTitleHintValid(hint, text) {
    return typeof hint === 'string' && hint.length > 0 && text.includes(hint);
}

function looksLikeExampleEcho(intent, params, originalText) {
    if (intent !== 'create_record') return false;
    if (params.entity === 'health') {
        return HEALTH_EXAMPLE_ECHO_SYMPTOMS.includes(params.symptoms) && !originalText.includes(params.symptoms);
    }
    const examples = EXAMPLE_ECHOES[params.entity];
    if (!examples) return false;
    return examples.includes(params.title) && !originalText.includes(params.title);
}

// 2026-07-08 真實案例：使用者說「週四晚上」，今天（2026-07-08）是星期三，正確應該是
// 隔天 2026-07-09，但 AI 算成了 2026-07-10（星期五）——同一句話重跑一次又算對了，證實
// 這是 AI 自己做「今天星期幾、差幾天」這種日曆算術本身不穩定（機率性錯誤，不是寫死的
// 邏輯漏洞）。修法：不信任 AI 對「週X」這類相對星期幾用詞的日期換算，改用程式碼從
// 使用者原話直接偵測星期幾字樣、用 Date 物件算出正確日期，只保留 AI 抽出來的時間部分。
// 「下/下下」是修飾語前綴，跟後面的「週/星期/禮拜/拜」是分開的兩截，不能寫成
// 「下下週」當一個完整詞去匹配——那樣「下下週三」會因為「下下週」吃掉「週」之後，
// 還要求後面再出現一次週/星期/禮拜/拜才符合，但「下下週三」只有一個「週」字，
// 導致整條規則失配、正則引擎退回去只匹配到裸的「週三」，把「下下」直接漏掉不算
const WEEKDAY_WORD_RE = /(下下|下)?(?:週|星期|禮拜|拜)([一二三四五六日天])/;
const WEEKDAY_CN_TO_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

// todayOverride 只給測試用（固定「今天」才能斷言算出來的日期，不然測試結果每天跑都不一樣）；
// 正式流程一律用預設值（todayStr() 算出來的真正今天），呼叫端不用也不應該帶這個參數。
// 用 UTC 正午當錨點做日期加減——只關心日期本身，不靠系統預設時區跟 TIMEZONE 剛好一致這種
// 隱含假設（之前版本用 Date 物件在系統本地時區跟 TIMEZONE 之間來回轉換，兩者剛好都是
// Asia/Taipei 才恰好沒事，換一台系統時區不同的機器跑就會在日期邊界算錯）。
function resolveWeekdayDate(text, currentValue, todayOverride) {
    if (!text) return currentValue;
    const match = text.match(WEEKDAY_WORD_RE);
    if (!match) return currentValue;
    const targetDow = WEEKDAY_CN_TO_NUM[match[2]];
    if (targetDow === undefined) return currentValue;

    const todayIso = todayOverride || todayStr();
    const anchor = new Date(`${todayIso}T12:00:00Z`);
    const todayDow = anchor.getUTCDay();
    let diff = (targetDow - todayDow + 7) % 7;
    if (match[1] === '下') diff += 7;
    if (match[1] === '下下') diff += 14;

    anchor.setUTCDate(anchor.getUTCDate() + diff);
    const targetDateStr = anchor.toISOString().slice(0, 10);

    // 保留 AI 抽出來的時間部分（如果有的話），日期部分一律用程式碼算出來的結果覆蓋
    const timeMatch = typeof currentValue === 'string' && currentValue.match(/\d{2}:\d{2}$/);
    return timeMatch ? `${targetDateStr} ${timeMatch[0]}` : targetDateStr;
}

function sanitizeDueDate(value, text) {
    if (value === null || value === undefined) return value;
    if (!DATE_RE.test(value)) return null;
    return resolveWeekdayDate(text, value);
}

function sanitizeDateOnly(value) {
    if (value === null || value === undefined) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function sanitizeFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const WEEKDAY_RE = /^(MO|TU|WE|TH|FR|SA|SU)$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const FREQ_VALUES = ['daily', 'weekly', 'monthly', 'yearly'];
const HEALTH_STATUS_VALUES = ['良好', '普通', '不適'];
const ENERGY_LEVEL_VALUES = ['高', '中', '低'];
const MEAL_TYPE_VALUES = ['早餐', '午餐', '晚餐', '點心'];
const ACTIVITY_TYPE_VALUES = ['運動', '休息', '伸展'];
const TASK_PRIORITY_VALUES = ['高', '中', '低'];
const TASK_PRIORITY_DEFAULT = '中'; // 使用者說的「一般等級」對應到 高/中/低 的中間值
const INTENSITY_VALUES = ['高', '中', '低'];

// 只做「型別/格式對不對」這種便宜檢查，不判斷語意合不合理——真正的規則有效性
// （例如 until 早於 dtstart）交給 lib/recurrence.js 的 rrule 建構去判斷。
function sanitizeRecurrence(recurrence) {
    if (!recurrence || typeof recurrence !== 'object') return null;
    if (!FREQ_VALUES.includes(recurrence.freq)) return null;

    const clean = { freq: recurrence.freq };
    if (Array.isArray(recurrence.byweekday)) {
        const days = recurrence.byweekday.filter(d => WEEKDAY_RE.test(d));
        if (days.length > 0) clean.byweekday = days;
    }
    if (Number.isInteger(recurrence.bysetpos)) clean.bysetpos = recurrence.bysetpos;
    if (Number.isInteger(recurrence.bymonthday) && recurrence.bymonthday >= 1 && recurrence.bymonthday <= 31) {
        clean.bymonthday = recurrence.bymonthday;
    }
    if (Number.isInteger(recurrence.bymonth) && recurrence.bymonth >= 1 && recurrence.bymonth <= 12) {
        clean.bymonth = recurrence.bymonth;
    }
    if (Number.isInteger(recurrence.interval) && recurrence.interval > 1) clean.interval = recurrence.interval;
    if (Number.isInteger(recurrence.count) && recurrence.count > 0) clean.count = recurrence.count;
    if (typeof recurrence.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(recurrence.until)) clean.until = recurrence.until;
    clean.time = typeof recurrence.time === 'string' && TIME_RE.test(recurrence.time) ? recurrence.time : '09:00';
    return clean;
}

function sanitizeParams(intent, params, text) {
    if (intent === 'create_record' && params.entity === 'task') {
        params.due_date = sanitizeDueDate(params.due_date, text);
        params.recurrence = sanitizeRecurrence(params.recurrence);
        // 一般聊天分類器（非 /todo 窄流程）的 schema 只有單數 params.reminder（字串），
        // 但 router.js 的 create_record 只讀複數 params.reminders（陣列）——不轉換的話，
        // 使用者在一般對話裡明講的提醒時機會被無聲丟棄，永遠退回預設的 24小時前+1小時前
        params.reminders = sanitizeReminders(
            typeof params.reminder === 'string' && params.reminder.trim() ? [params.reminder] : null
        );
        params.category = typeof params.category === 'string' && params.category.trim() ? params.category : null;
    }
    if (intent === 'create_record' && params.entity === 'shopping') {
        // 這裡的 AI 輸出跟 classifyShoppingOnce 一樣是 snake_case（quantity_needed/price_estimate），
        // 但 db-schemas.js 的 shopping.toCreateFields 用 camelCase 解構——router.js 是直接
        // spread params 進 toCreateFields，不轉成 camelCase 的話這兩個欄位會被無聲丟棄，
        // 使用者講的金額/數量就會被 AI 塞進 notes（真實案例：2026-07-07 的「牙膏」那筆）
        params.priority = SHOPPING_PRIORITY_VALUES.includes(params.priority) ? params.priority : null;
        params.buyer = typeof params.buyer === 'string' && params.buyer.trim() ? params.buyer : null;
        params.location = typeof params.location === 'string' && params.location.trim() ? params.location : null;
        params.category = typeof params.category === 'string' && params.category.trim() ? params.category : null;
        params.quantityNeeded = sanitizeFiniteNumber(params.quantity_needed);
        params.priceEstimate = sanitizeFiniteNumber(params.price_estimate);
        // 2026-07-08 真實案例：一般聊天分類器說「下週三出國前要買sim卡」完全沒有把 due_date/
        // reminder 抽出來（prompt 原本寫死「只有 task 才有到期日」），跟 task 一樣要補上
        // due_date 清洗跟單數 reminder→複數 reminders 的轉換，不然這條路徑的購物到期提醒
        // 永遠不會被排上（只有走 /shopping 按鈕的 classifyShoppingOnce 才有效）
        params.due_date = sanitizeDueDate(params.due_date, text);
        params.reminders = sanitizeReminders(
            typeof params.reminder === 'string' && params.reminder.trim() ? [params.reminder] : null
        );
    }
    if (intent === 'create_record' && params.entity === 'health') {
        params.status = HEALTH_STATUS_VALUES.includes(params.status) ? params.status : null;
        params.energy_level = ENERGY_LEVEL_VALUES.includes(params.energy_level) ? params.energy_level : null;
        params.sleep_hours = sanitizeFiniteNumber(params.sleep_hours);
        params.date = sanitizeDateOnly(params.date);
    }
    if (intent === 'create_record' && params.entity === 'diet') {
        params.meal_type = MEAL_TYPE_VALUES.includes(params.meal_type) ? params.meal_type : null;
        params.calories = sanitizeFiniteNumber(params.calories);
        params.date = sanitizeDateOnly(params.date);
    }
    if (intent === 'create_record' && params.entity === 'activity') {
        params.type = ACTIVITY_TYPE_VALUES.includes(params.type) ? params.type : null;
        params.intensity = INTENSITY_VALUES.includes(params.intensity) ? params.intensity : null;
        params.duration = sanitizeFiniteNumber(params.duration);
        params.date = sanitizeDateOnly(params.date);
    }
    if (intent === 'modify_record' && params.changes && params.changes.due_date !== undefined) {
        params.changes.due_date = sanitizeDueDate(params.changes.due_date, text);
    }
    return params;
}

// 回傳 null 代表這次輸出不可信（JSON 解析失敗、intent 不在清單內、或被判定是 echo），
// 呼叫端要 fallback 到下一層模型，不是把 null 當成 unknown 直接回覆使用者。
function tryParse(raw, text) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        if (!INTENTS.includes(parsed.intent)) return null;
        const params = sanitizeParams(parsed.intent, parsed.params || {}, text);
        if (looksLikeExampleEcho(parsed.intent, params, text)) return null;
        if (parsed.intent === 'modify_record' && !isTitleHintValid(params.title_hint, text)) return null;
        return { intent: parsed.intent, params };
    } catch (e) {
        return null;
    }
}

async function classifyIntent(text) {
    const userPrompt = `使用者訊息：「${text}」`;

    try {
        const raw = await ai.callLevel1(buildSystemPrompt(), userPrompt);
        const result = tryParse(raw, text);
        if (result) return result;
    } catch (e) {
        // Ollama 沒開/逾時等，直接 fallback，不中斷整個分類流程
    }

    const raw = await ai.callLevel2(buildSystemPrompt(), userPrompt);
    return tryParse(raw, text) || { intent: 'unknown', params: {} };
}

// --- /todo 專屬的窄範圍分類函式 ---
// 使用者已經透過 /todo 的按鈕明確選了子流程，這裡不用再猜 entity/action，
// prompt 縮到只剩該子流程需要的欄位，比 classifyIntent 的 7-entity 分類器更可靠、更省 token。
// 三個函式共用同一套 Level1→Level2 fallback + 回傳 null 代表不可信的慣例。

async function runNarrowClassifier(systemPrompt, text, parseFn) {
    const userPrompt = `使用者訊息：「${text}」`;
    try {
        const raw = await ai.callLevel1(systemPrompt, userPrompt);
        const result = parseFn(raw, text);
        if (result) return result;
    } catch (e) {
        // Ollama 沒開/逾時等，直接 fallback
    }
    const raw = await ai.callLevel2(systemPrompt, userPrompt);
    return parseFn(raw, text); // null 交給呼叫端請使用者換個講法，不吞掉
}

function sanitizeReminders(value) {
    if (!Array.isArray(value)) return null;
    const valid = value.filter(r => typeof r === 'string' && r.trim());
    return valid.length > 0 ? valid : null;
}

// --- /shopping 專屬的窄範圍分類函式 ---
// 跟 /todo 系列同一套設計原則：使用者已經透過按鈕選好子流程，這裡只抽對應欄位。

const SHOPPING_PRIORITY_VALUES = ['急需', '一般', '想買'];

// 使用者原話只給月份時（例如「7月」），這裡不強求补天數，直接請 AI 用該月第一天代表——
// 校驗只看格式對不對（YYYY-MM-DD），語意上「只知道月份」這件事由呼叫端的 prompt 說明負責，
// 不在這裡另外處理「只有月份」這種輸入格式。
function sanitizePurchasedDate(value) {
    if (value === null || value === undefined) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function buildShoppingOnceSystemPrompt() {
    return `你是待買清單的欄位抽取器。使用者已經明確選擇「新增一次性待買」，只要抽取欄位，不用判斷意圖或種類。只輸出 JSON，不要任何其他文字。

今天的實際日期是 ${todayStr()}（${TIMEZONE}）。所有相對日期都要以這個日期為基準換算成 YYYY-MM-DD，不知道確切日期時填 null，絕對不能自己編造。

輸出格式：{"title": "...", "priority": null 或「急需」或「一般」或「想買」（沒提到就填 null，呼叫端會補預設值）, "buyer": null 或使用者提到的購買人（沒提到就是 null，呼叫端會補「我自己」）, "location": null 或購買地點, "category": null 或使用者提到的分類（例如「一般/日常用品/工作/興趣」，或使用者自己講的其他分類詞，沒提到就是 null，呼叫端會補預設值「一般」）, "quantity_needed": null 或數字, "price_estimate": null 或數字（預估金額）, "due_date": null 或 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"（使用者提到「幾號前」「出國前一週」這種需要在特定日期前買齊的才填，只是單純想買、沒有時間壓力就是 null）, "reminders": null 或使用者原話描述的提醒時機陣列（例如「提前一天跟一小時提醒我」→ ["1天前", "1小時前"]，不要自己換算成數字，沒提到就是 null，呼叫端會補預設值；沒有 due_date 的話這個也一定是 null）, "notes": null 或其他補充說明}

範例（僅示範結構，內容值不可沿用）：
使用者說「要買衛生紙」→ {"title": "衛生紙", "priority": null, "buyer": null, "location": null, "category": null, "quantity_needed": null, "price_estimate": null, "due_date": null, "reminders": null, "notes": null}
使用者說「急需買洗衣精，2瓶，全聯，大概150元，請室友幫忙買，日常用品」→ {"title": "洗衣精", "priority": "急需", "buyer": "室友", "location": "全聯", "category": "日常用品", "quantity_needed": 2, "price_estimate": 150, "due_date": null, "reminders": null, "notes": null}
使用者說「下週三出國前要買好sim卡，提前一天提醒我」→ {"title": "sim卡", "priority": null, "buyer": null, "location": null, "category": null, "quantity_needed": null, "price_estimate": null, "due_date": "2026-07-15", "reminders": ["1天前"], "notes": null}`;
}

function tryParseShoppingOnce(raw, text) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        if (!parsed.title || typeof parsed.title !== 'string') return null;
        if (EXAMPLE_ECHOES.shopping.includes(parsed.title) && !text.includes(parsed.title)) return null;
        return {
            title: parsed.title,
            priority: SHOPPING_PRIORITY_VALUES.includes(parsed.priority) ? parsed.priority : null,
            buyer: typeof parsed.buyer === 'string' ? parsed.buyer : null,
            location: typeof parsed.location === 'string' ? parsed.location : null,
            category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category : null,
            quantityNeeded: sanitizeFiniteNumber(parsed.quantity_needed),
            priceEstimate: sanitizeFiniteNumber(parsed.price_estimate),
            due_date: sanitizeDueDate(parsed.due_date ?? null, text),
            reminders: sanitizeReminders(parsed.reminders),
            notes: typeof parsed.notes === 'string' ? parsed.notes : null
        };
    } catch (e) {
        return null;
    }
}

async function classifyShoppingOnce(text) {
    return runNarrowClassifier(buildShoppingOnceSystemPrompt(), text, tryParseShoppingOnce);
}

function buildShoppingRecurringSystemPrompt() {
    return `你是待買清單的欄位抽取器。使用者已經明確選擇「新增週期性待買」（例如「每個月要買衛生紙」），只要抽取欄位，不用判斷意圖或種類。只輸出 JSON，不要任何其他文字。

輸出格式：{"title": "...", "priority": null 或「急需」或「一般」或「想買」, "buyer": null 或使用者提到的購買人, "location": null 或購買地點, "category": null 或使用者提到的分類（沒提到就是 null，呼叫端會補預設值「一般」）, "quantity_needed": null 或數字, "price_estimate": null 或數字, "notes": null 或其他補充說明, "reminders": null 或提前通知的時機陣列（例如「提前一天跟一小時通知我」→ ["1天前", "1小時前"]，沒提到就是 null，呼叫端會補預設值）, "recurrence": {
  "freq": "daily" 或 "weekly" 或 "monthly" 或 "yearly",
  "byweekday": null 或 ["MO","TU","WE","TH","FR","SA","SU"] 的子集,
  "bysetpos": null 或整數，"bymonthday": null 或整數 1-31，"bymonth": null 或整數 1-12（yearly 搭配 bymonthday 才需要），
  "interval": null 或整數，"count": null 或整數，"until": null 或 "YYYY-MM-DD"，"time": "HH:MM"（沒提到就填 "09:00"）
}}

範例（僅示範結構，內容值不可沿用）：
使用者說「每個月要買衛生紙」→ {"title": "衛生紙", "priority": null, "buyer": null, "location": null, "category": null, "quantity_needed": null, "price_estimate": null, "notes": null, "reminders": null, "recurrence": {"freq": "monthly", "byweekday": null, "bysetpos": null, "bymonthday": 1, "bymonth": null, "interval": null, "count": null, "until": null, "time": "09:00"}}`;
}

function tryParseShoppingRecurring(raw, text) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        if (!parsed.title || typeof parsed.title !== 'string') return null;
        if (EXAMPLE_ECHOES.shopping.includes(parsed.title) && !text.includes(parsed.title)) return null;
        const recurrence = sanitizeRecurrence(parsed.recurrence);
        if (!recurrence) return null;
        return {
            title: parsed.title,
            priority: SHOPPING_PRIORITY_VALUES.includes(parsed.priority) ? parsed.priority : null,
            buyer: typeof parsed.buyer === 'string' ? parsed.buyer : null,
            location: typeof parsed.location === 'string' ? parsed.location : null,
            category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category : null,
            quantityNeeded: sanitizeFiniteNumber(parsed.quantity_needed),
            priceEstimate: sanitizeFiniteNumber(parsed.price_estimate),
            notes: typeof parsed.notes === 'string' ? parsed.notes : null,
            reminders: sanitizeReminders(parsed.reminders),
            recurrence
        };
    } catch (e) {
        return null;
    }
}

async function classifyShoppingRecurring(text) {
    return runNarrowClassifier(buildShoppingRecurringSystemPrompt(), text, tryParseShoppingRecurring);
}

function buildShoppingPurchaseSystemPrompt() {
    return `你是待買清單的欄位抽取器。使用者要標記一個待買項目已經買了，同一句話裡會描述「買了哪個」跟「買的明細」。只輸出 JSON，不要任何其他文字。

今天的實際日期是 ${todayStr()}（${TIMEZONE}）。

輸出格式：{"title_hint": "必須是使用者原文中連續出現的子字串（可以只取一部分，但不能跳過中間的字、不能重組語序或改寫），不是完整品項名稱", "quantity_purchased": null 或數字, "actual_price": null 或數字, "purchased_date": "YYYY-MM-DD"（**月份是必填的**，使用者只說月份沒說確切日期時，日期部分固定填 01，例如「7月」→ 今年的 "2026-07-01"；使用者完全沒提到任何日期資訊時，用今天的日期；絕對不能省略這個欄位）}

範例（僅示範結構，內容值不可沿用）：
使用者說「衛生紙買了，2包，花了120」→ {"title_hint": "衛生紙", "quantity_purchased": 2, "actual_price": 120, "purchased_date": "${todayStr()}"}
使用者說「洗衣精上個月買的，大概7月買的」→ {"title_hint": "洗衣精", "quantity_purchased": null, "actual_price": null, "purchased_date": "2026-07-01"}`;
}

function tryParseShoppingPurchase(raw, text) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        if (!isTitleHintValid(parsed.title_hint, text)) return null;
        const purchasedDate = sanitizePurchasedDate(parsed.purchased_date);
        if (!purchasedDate) return null; // 月份必填，抽不到視為失敗，請使用者換個講法
        return {
            title_hint: parsed.title_hint,
            quantity_purchased: sanitizeFiniteNumber(parsed.quantity_purchased),
            actual_price: sanitizeFiniteNumber(parsed.actual_price),
            purchased_date: purchasedDate
        };
    } catch (e) {
        return null;
    }
}

async function classifyShoppingPurchase(text) {
    return runNarrowClassifier(buildShoppingPurchaseSystemPrompt(), text, tryParseShoppingPurchase);
}


// 週期性模板觸發推播後的回覆解析：先判斷是不是「跳過這次」或「以後都不用了」，
// 兩種都不用叫 AI，省一次呼叫；「取消」類的詞要先判斷（比對更明確），不然「不用」
// 這種同時可能出現在兩種講法裡的詞，會被 SKIP_WORDS 搶先誤判成只是跳過這次。
// 兩者都不是才當成購買明細解析（沿用 classifyShoppingPurchase 同一套 prompt，
// 只是不需要 title_hint——呼叫端已經知道是哪個模板觸發的）。
const CANCEL_SERIES_WORDS = ['取消', '不用再提醒', '不用再買', '以後都不用', '以後不用', '停止提醒', '不要再提醒', '不要再買'];
const SKIP_WORDS = ['跳過', '不用', '不需要', 'skip', '略過', '這次不用', '這次不買'];

function isCancelSeriesReply(text) {
    return CANCEL_SERIES_WORDS.some(w => text.includes(w));
}

function isSkipReply(text) {
    return SKIP_WORDS.some(w => text.includes(w));
}

function buildShoppingRecurringConfirmSystemPrompt() {
    return `你是待買清單的欄位抽取器。使用者剛收到「週期性待買提醒」，回覆的內容是這次實際買的明細（不是「跳過」或「取消」，那兩種情況呼叫端已經另外處理，不會到這裡）。只輸出 JSON，不要任何其他文字。

今天的實際日期是 ${todayStr()}（${TIMEZONE}）。

輸出格式：{"quantity_purchased": null 或數字, "actual_price": null 或數字, "purchased_date": "YYYY-MM-DD"（使用者沒提到日期就用今天，**這個欄位不能省略**）, "buyer": null 或使用者提到「這次是誰買的」（沒提到就是 null，呼叫端會用預設的購買人）, "notes": null 或這次額外補充的說明（沒提到就是 null）}

範例（僅示範結構，內容值不可沿用）：
使用者說「買了，3包，100元」→ {"quantity_purchased": 3, "actual_price": 100, "purchased_date": "${todayStr()}", "buyer": null, "notes": null}
使用者說「室友買的，2包80元」→ {"quantity_purchased": 2, "actual_price": 80, "purchased_date": "${todayStr()}", "buyer": "室友", "notes": null}`;
}

function tryParseShoppingRecurringConfirm(raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        const purchasedDate = sanitizePurchasedDate(parsed.purchased_date);
        if (!purchasedDate) return null;
        return {
            quantity_purchased: sanitizeFiniteNumber(parsed.quantity_purchased),
            actual_price: sanitizeFiniteNumber(parsed.actual_price),
            purchased_date: purchasedDate,
            buyer: typeof parsed.buyer === 'string' ? parsed.buyer : null,
            notes: typeof parsed.notes === 'string' ? parsed.notes : null
        };
    } catch (e) {
        return null;
    }
}

async function classifyShoppingRecurringConfirm(text) {
    if (isCancelSeriesReply(text)) return { skip: true, cancelSeries: true };
    if (isSkipReply(text)) return { skip: true, cancelSeries: false };
    const result = await runNarrowClassifier(buildShoppingRecurringConfirmSystemPrompt(), text, tryParseShoppingRecurringConfirm);
    return result ? { skip: false, cancelSeries: false, ...result } : null;
}

module.exports = {
    classifyIntent, INTENTS,
    classifyShoppingOnce, classifyShoppingRecurring, classifyShoppingPurchase,
    classifyShoppingRecurringConfirm, isSkipReply, isCancelSeriesReply,
    // 以下是內部輔助函式，額外 export 只是為了讓自動化測試能直接單元測試，
    // 不改變任何行為，classifyIntent/classifyShopping* 仍是外部唯一該用的入口
    sanitizeParams, looksLikeExampleEcho, sanitizeRecurrence, tryParse, sanitizeReminders, isTitleHintValid,
    sanitizeDueDate, resolveWeekdayDate,
    tryParseShoppingOnce, tryParseShoppingRecurring, tryParseShoppingPurchase,
    tryParseShoppingRecurringConfirm
};
