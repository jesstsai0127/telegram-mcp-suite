// 依 response-templates.md 把 Notion 查詢結果轉成固定格式文字。
// 查詢型意圖是結構化列表，不需要 Level 2 AI 生成，直接照模板渲染更穩定、也不受 AI provider 可用性影響。

function relativeTime(isoDate) {
    if (!isoDate) return '';
    const diffDays = Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
    if (diffDays <= 0) return '今天';
    if (diffDays === 1) return '昨天';
    return `${diffDays}天前`;
}

function plain(richTextArr) {
    return (richTextArr || []).map(t => t.plain_text).join('');
}

function formatTasks(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const pending = rows.filter(r => r.properties.Status.select?.name === '待辦');
    const inProgress = rows.filter(r => r.properties.Status.select?.name === '進行中');

    const lines = [`📋 今日待辦（共 ${pending.length} 筆）`, ''];
    for (const r of pending) {
        const p = r.properties;
        lines.push(`📌 ${plain(p.Title.title)}（${p.Priority.select?.name || '未設定'}）`);
        lines.push(`   截止：${formatDateTimeShort(p['Due Date'].date?.start) || '未設定'}`);
        const notes = plain(p.Notes.rich_text);
        if (notes) lines.push(`   ${notes}`);
    }
    for (const r of inProgress) {
        lines.push(`⏳ ${plain(r.properties.Title.title)}`);
    }
    return lines.join('\n');
}

function formatShopping(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const byPriority = { 急需: [], 一般: [], 想買: [] };
    for (const r of rows) {
        const p = r.properties;
        const priority = p.Priority.select?.name || '一般';
        byPriority[priority].push(p);
    }

    const lines = [`🛒 購買清單（共 ${rows.length} 筆）`, ''];
    if (byPriority['急需'].length) {
        lines.push('急需：');
        for (const p of byPriority['急需']) {
            const price = p['Price Estimate'].number ? `NT$${p['Price Estimate'].number}` : '未估價';
            const notes = plain(p.Notes.rich_text);
            lines.push(`• ${plain(p.Item.title)}｜${price}｜${notes}`);
        }
        lines.push('');
    }
    if (byPriority['一般'].length) {
        lines.push('一般：');
        for (const p of byPriority['一般']) {
            lines.push(`• ${plain(p.Item.title)}｜${p.Category.select?.name || ''}`);
        }
        lines.push('');
    }
    if (byPriority['想買'].length) {
        lines.push('想買：');
        for (const p of byPriority['想買']) {
            lines.push(`• ${plain(p.Item.title)}`);
        }
    }
    return lines.join('\n').trim();
}

function formatIdeas(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const lines = [`💡 點子庫（共 ${rows.length} 筆）`, ''];
    rows.forEach((r, i) => {
        const p = r.properties;
        const content = plain(p.Content.rich_text).slice(0, 50);
        lines.push(`${i + 1}. ${plain(p.Title.title)}`);
        lines.push(`   ${content}...`);
        lines.push(`   狀態：${p.Status.select?.name || ''} ｜ ${relativeTime(p.Created.created_time)}`);
        lines.push('');
    });
    return lines.join('\n').trim();
}

function formatProjects(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const lines = ['🗂 個人專案進度', ''];
    for (const r of rows) {
        const p = r.properties;
        lines.push(plain(p.Name.title));
        lines.push(`   狀態：${p.Status.select?.name || ''} ｜ 階段：${p['Current Phase'].select?.name || ''}`);
        lines.push(`   摘要：${plain(p.Summary.rich_text)}`);
        const issues = plain(p.Issues.rich_text);
        if (issues) lines.push(`   待解決：${issues}`);
        lines.push(`   更新：${relativeTime(p['Last Updated'].date?.start)}`);
        lines.push('');
    }
    return lines.join('\n').trim();
}

function formatHealth(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const lines = ['🩺 身體狀況紀錄', ''];
    for (const r of rows) {
        const p = r.properties;
        lines.push(`${plain(p.Date.title)}｜${p.Status.select?.name || ''}`);
        const symptoms = plain(p.Symptoms.rich_text);
        if (symptoms) lines.push(`   症狀：${symptoms}`);
        if (p['Energy Level'].select?.name) lines.push(`   精神：${p['Energy Level'].select.name}`);
        if (p['Sleep Hours'].number != null) lines.push(`   睡眠：${p['Sleep Hours'].number} 小時`);
        const notes = plain(p.Notes.rich_text);
        if (notes) lines.push(`   ${notes}`);
        lines.push('');
    }
    return lines.join('\n').trim();
}

function formatDiet(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const lines = ['🍽 飲食紀錄', ''];
    for (const r of rows) {
        const p = r.properties;
        lines.push(`${p.Date.date?.start || ''}｜${p['Meal Type'].select?.name || ''}｜${plain(p.Title.title)}`);
        if (p.Calories.number != null) lines.push(`   ${p.Calories.number} 大卡`);
        lines.push('');
    }
    return lines.join('\n').trim();
}

function formatActivity(rows) {
    if (rows.length === 0) return '目前沒有相關紀錄';
    const lines = ['🏃 運動休息紀錄', ''];
    for (const r of rows) {
        const p = r.properties;
        lines.push(`${p.Date.date?.start || ''}｜${p.Type.select?.name || ''}｜${plain(p.Title.title)}（${p.Duration.number || 0} 分鐘）`);
        if (p.Intensity.select?.name) lines.push(`   強度：${p.Intensity.select.name}`);
        lines.push('');
    }
    return lines.join('\n').trim();
}

// 預設 Asia/Taipei，換裝到別的時區只需要設 TIMEZONE，不用改程式碼
const TIMEZONE = process.env.TIMEZONE || 'Asia/Taipei';

function todayStr(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(d);
}

// 顯示用：把日期/時間字串統一收斂到分鐘精度，不顯示秒/毫秒/時區位移這些使用者用不到的東西。
// 純日期（"YYYY-MM-DD"，沒有時間資訊）原樣回傳，不做時區轉換——不然會被誤判成 UTC 午夜，
// 換算成本地時間後日期會跑掉（2026-07-06 的重複詢問就是在提醒這個真實 bug）。
// 有時間資訊的字串（不管原本是 "YYYY-MM-DD HH:MM"、UTC 的 "...Z"、還是帶 +08:00 offset）
// 一律轉成 TIMEZONE 當地時間再顯示，New Date() 本身就會正確處理不同輸入格式的時區換算。
function formatDateTimeShort(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    const d = new Date(value);
    if (isNaN(d.getTime())) return value;

    const datePart = new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(d);
    const timeParts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const hour = timeParts.find(p => p.type === 'hour').value;
    const minute = timeParts.find(p => p.type === 'minute').value;
    return `${datePart} ${hour}:${minute}`;
}

// 每日排程推播（自動，晚間觸發一次）：合併原本早報+晚結，不重複維護兩套模板；
// 加一段「已逾期」，標註逾期天數呈現輕重，用既有的取消/修改語句處理，不另造回覆機制。
function formatDailyPush({ completed, unfinished, overdue, upcoming }) {
    const lines = [`📆 每日回顧 ${todayStr()}`, ''];
    lines.push(`今天完成（${completed.length} 筆）：`);
    if (completed.length === 0) {
        lines.push('（無）');
    } else {
        for (const r of completed) lines.push(`✅ ${plain(r.properties.Title.title)}`);
    }
    lines.push('', `未完成（${unfinished.length} 筆）：`);
    if (unfinished.length === 0) {
        lines.push('目前沒有待辦事項');
    } else {
        for (const r of unfinished) lines.push(`⏳ ${plain(r.properties.Title.title)}`);
    }
    if (overdue.length > 0) {
        lines.push('', `⚠️ 已逾期（${overdue.length} 筆，需要你決定）：`);
        for (const r of overdue) {
            const due = r.properties['Due Date'].date?.start;
            const days = Math.floor((Date.now() - new Date(due).getTime()) / 86400000);
            lines.push(`❗ ${plain(r.properties.Title.title)}（已逾期 ${days} 天）`);
        }
    }
    lines.push('', '明天預計：');
    if (upcoming.length === 0) {
        lines.push('目前沒有排定的任務');
    } else {
        for (const r of upcoming) lines.push(`📌 ${plain(r.properties.Title.title)}`);
    }
    return lines.join('\n');
}

// Today（手動觸發：/today 指令）：滾動 24 小時視窗（過去 24 小時完成＋未來 24 小時待辦），
// 用「當下」當基準，不用「今天」這個日曆日概念——跟 formatDailyPush 內容形狀類似但範圍不同。
function formatTodayReport({ completed, unfinished }) {
    const lines = ['🔜 Today', ''];
    lines.push(`已完成（過去 24 小時，${completed.length} 筆）：`);
    if (completed.length === 0) {
        lines.push('（無）');
    } else {
        for (const r of completed) lines.push(`✅ ${r.title}`);
    }
    lines.push('', `未完成（未來 24 小時內，${unfinished.length} 筆）：`);
    if (unfinished.length === 0) {
        lines.push('目前沒有待辦事項');
    } else {
        for (const r of unfinished) {
            const dueText = r.dueDate ? `（截止：${r.dueDate}）` : '（無截止時間）';
            const tag = r.status === '進行中' ? '⏳' : '📌';
            lines.push(`${tag} ${r.title}${dueText}`);
        }
    }
    return lines.join('\n');
}

// 每週回顧（自動，週日 21:00）：抓每日推播看不到的東西——本週完成量、真的被晾了一週以上的停滯項目、
// 不需要每天看但需要定期看一次的 Projects 進度。不是每日推播內容的簡單週期複製。
function formatWeeklyReview({ completedCount, stale, projectRows }) {
    const lines = ['🗓 每週回顧', ''];
    lines.push(`本週完成：${completedCount} 筆`);
    lines.push('', `⚠️ 停滯超過一週（${stale.length} 筆）：`);
    if (stale.length === 0) {
        lines.push('（無，本週沒有東西被晾著）');
    } else {
        for (const r of stale) {
            const due = r.properties['Due Date'].date?.start;
            const days = Math.floor((Date.now() - new Date(due).getTime()) / 86400000);
            lines.push(`❗ ${plain(r.properties.Title.title)}（已逾期 ${days} 天）`);
        }
    }
    lines.push('', formatProjects(projectRows));
    return lines.join('\n');
}

// modify_record 現在跨 task/shopping/idea 搜尋，候選可能來自不同 entity，
// 標註類型讓使用者選的時候分得清楚是哪一筆（例如「洗衣精」同時是購物項目跟點子時）
const ENTITY_LABELS = { task: '待辦', shopping: '購物', idea: '點子' };

// 2026-07-07 真實案例：使用者回覆數字選完候選之後，系統直接執行「一開始分類器猜的 action」，
// 過程中從沒讓使用者確認過「要做什麼」，只確認了「哪一筆」——選 1 之後才發現被標記完成，
// 但使用者以為只是在選紀錄。這裡把 action/changes 也塞進提示文字，讓使用者在回數字之前
// 就能看到即將發生的動作，覺得不對可以不回或換句話講，不是選完才知道。
function formatActionSummary(action, changes) {
    if (action === '完成') return '標記完成';
    if (action === '取消') return '取消';
    if (action === '修改') {
        const parts = [];
        if (changes.title) parts.push(`標題改成「${changes.title}」`);
        if (changes.due_date) parts.push(`時間改成 ${formatDateTimeShort(changes.due_date) || changes.due_date}`);
        if (changes.priority) parts.push(`優先度改成「${changes.priority}」`);
        if (changes.content) parts.push('內容更新');
        if (changes.buyer) parts.push(`購買人改成「${changes.buyer}」`);
        if (changes.location) parts.push(`地點改成「${changes.location}」`);
        return parts.length > 0 ? parts.join('、') : '修改';
    }
    return action || '修改';
}

function formatCandidates(candidates, action, changes) {
    const actionSummary = formatActionSummary(action, changes || {});
    const lines = [`找到符合的紀錄，回覆數字確認要「${actionSummary}」：`, ''];
    candidates.forEach((c, i) => {
        const dueText = c.due ? `（截止：${formatDateTimeShort(c.due)}）` : '';
        lines.push(`${i + 1}. [${ENTITY_LABELS[c.entity] || c.entity}] ${c.title}${dueText}`);
    });
    return lines.join('\n');
}

function formatReminderPush(rows) {
    const lines = ['⏰ 提醒', ''];
    for (const r of rows) {
        const p = r.properties;
        const due = formatDateTimeShort(p['Due Date'].date?.start) || '未設定';
        lines.push(`📌 ${plain(p.Title.title)}（截止：${due}）`);
    }
    return lines.join('\n');
}

function formatSearchResult({ query, summary, sourceUrls, cached, createdAt, expiresAt }) {
    if (cached) {
        return `🔍 ${query}\n\n${summary}\n\n（快取資料，來源日期：${createdAt}。如需最新結果，請說「重新查」）`;
    }
    return `🔍 ${query}\n\n${summary}\n\n來源：${sourceUrls}\n資料時間：${createdAt}｜快取有效至：${expiresAt}`;
}

function formatPersonaSummary(personaMarkdown) {
    const match = personaMarkdown.match(/## 回應規則([\s\S]*?)## 語言/);
    const rules = match ? match[1].trim() : personaMarkdown.trim();
    return `📋 AXIS 本月生效回應規則\n\n${rules}\n\n如需調整，請直接告訴我。`;
}

module.exports = {
    formatTasks, formatShopping, formatIdeas, formatProjects,
    formatHealth, formatDiet, formatActivity,
    formatDailyPush, formatTodayReport, formatWeeklyReview, formatPersonaSummary, formatSearchResult,
    formatCandidates, formatActionSummary, formatReminderPush, todayStr, plain, relativeTime, TIMEZONE, formatDateTimeShort
};
