// 基礎 service 健康檢查，抽出來讓 /status 跟 /projects（維運狀況）共用同一份檢查結果，
// 不因為顯示位置不同就重複寫一份判斷邏輯。

const notion = require('./notion');
const financeTracker = require('./finance-tracker');
const { SCHEMAS } = require('./db-schemas');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

async function checkOpsHealth() {
    const checks = [];

    try {
        await notion.queryDb(SCHEMAS.project.dbKey);
        checks.push('✅ Notion');
    } catch (err) {
        checks.push(`❌ Notion（${err.message}）`);
    }

    try {
        const res = await fetch(`${OLLAMA_HOST}/api/tags`);
        checks.push(res.ok ? '✅ Ollama' : `❌ Ollama（HTTP ${res.status}）`);
    } catch (err) {
        checks.push(`❌ Ollama（${err.message}）`);
    }

    checks.push(process.env.N8N_MESSAGE_WEBHOOK ? '✅ n8n webhook 已設定' : '⚠️ n8n webhook 使用預設值（未在 .env 指定）');

    try {
        await financeTracker.checkHealth();
        checks.push('✅ finance-tracker');
    } catch (err) {
        checks.push(`❌ finance-tracker（${err.message}）`);
    }

    return checks;
}

module.exports = { checkOpsHealth };
