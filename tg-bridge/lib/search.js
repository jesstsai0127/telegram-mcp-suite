// DuckDuckGo 搜尋本身在 n8n 端執行（n8n-nodes-duckduckgo-search 社群節點，有呼叫才跑，
// 不佔用 tg-bridge 這個常駐服務的資源）。這裡只負責 Search Cache 命中判斷、Level 2 AI 摘要、寫回快取。

const notion = require('./notion');
const ai = require('./ai');

const CACHE_DAYS = 7;
const SUMMARY_SYSTEM_PROMPT = '你是摘要助手。只根據使用者提供的搜尋結果作答，不要加入未提及的資訊。用繁體中文寫一段 3-5 句的精簡摘要。';

function plainText(richTextArr) {
    return (richTextArr || []).map(t => t.plain_text).join('');
}

function buildSummaryPrompt(query, results) {
    const list = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}\n${r.url}`).join('\n\n');
    return `搜尋問題：「${query}」\n\n搜尋結果：\n${list}`;
}

async function webSearch(query, { forceRefresh = false, results = [] } = {}) {
    if (!forceRefresh) {
        const cached = await notion.findSearchCache(query);
        const expiresAt = cached?.properties['Expires At'].date?.start;
        if (cached && expiresAt && new Date(expiresAt) >= new Date()) {
            const p = cached.properties;
            return {
                query,
                cached: true,
                summary: plainText(p.Summary.rich_text),
                sourceUrls: plainText(p['Source URLs'].rich_text),
                createdAt: p.Created.created_time.slice(0, 10)
            };
        }
    }

    if (results.length === 0) {
        throw new Error('web_search 缺少搜尋結果，需由 n8n DuckDuckGo 節點提供 results 參數');
    }

    const summary = await ai.callLevel2(SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt(query, results));
    const sourceUrls = results.map(r => r.url).join('\n');
    const createdAt = new Date().toISOString().slice(0, 10);
    const expiresAt = new Date(Date.now() + CACHE_DAYS * 86400000).toISOString().slice(0, 10);

    await notion.createSearchCache({ query, searchKeywords: query, summary, sourceUrls, expiresAt, forceRefresh });

    return { query, cached: false, summary, sourceUrls, createdAt, expiresAt };
}

module.exports = { webSearch };
