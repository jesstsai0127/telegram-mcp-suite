// Level 1：本機 Ollama。意圖解析原本走這裡，因為 qwen2.5:3b 常會 echo 範例/幻覺日期而移除；
// 現在換成參數量大很多的 gemma4:12b，加回來當第一層嘗試，呼叫端仍需搭配防呆機制驗證輸出。
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_INTENT_MODEL = process.env.OLLAMA_INTENT_MODEL || 'gemma4:12b';

// 本機 CPU 跑推論，速度會隨機器負載大幅波動——只在「真的報錯」時 fallback 不夠，
// 「很慢但最後還是成功」也要有上限，不然使用者可能無限期等下去。
// 2026-07-07 調整：原本設 2 分鐘，實測意圖分類（小型任務）真的卡到接近上限，
// 使用者體感就是「打字後快 2 分鐘沒回應」，本身就是一種可靠度問題。縮短到 20 秒——
// 正常情況下這種小任務遠遠不需要這麼久，卡超過 20 秒已經是機器負載異常的訊號，
// 早點放棄改走 Gateway 反而更快拿到結果，不等它「很慢但最後還是成功」。
const OLLAMA_TIMEOUT_MS = 20000;

async function callLevel1(systemPrompt, userPrompt) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        body: JSON.stringify({
            model: OLLAMA_INTENT_MODEL,
            stream: false,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        })
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.message.content;
}

// Level 2 AI 呼叫，透過共用的 AI Gateway（FreeLLMAPI，github.com/tashfeenahmed/freellmapi）。
// Gateway 是機器層級的共用服務（不屬於 AXIS 專案本身），負責 Gemini/Groq 等多 provider、
// 多帳號 key 的健康檢查與 fallback，這裡只需要呼叫它的 OpenAI 相容 endpoint。
//
// GATEWAY_KEY 是機器層級共用金鑰，不是 AXIS 專屬機密，不該每個專案/環境（正式/測試）
// 各自在自己的 .env 裡複製一份明碼。預設放在 ~/.secrets/ai-gateway.env（repo 外，比照
// notion.js 的 loadDbIds() 同一套 lazy-load 模式），process.env 有設就優先用（方便手動覆寫），
// 沒設才去讀這個共用檔案。
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const AI_GATEWAY_SECRETS_PATH = process.env.AI_GATEWAY_SECRETS_PATH ||
    path.join(require('os').homedir(), '.secrets', 'ai-gateway.env');

let _gatewayConfig = null;
function loadGatewayConfig() {
    if (_gatewayConfig) return _gatewayConfig;
    _gatewayConfig = fs.existsSync(AI_GATEWAY_SECRETS_PATH)
        ? dotenv.parse(fs.readFileSync(AI_GATEWAY_SECRETS_PATH))
        : {};
    return _gatewayConfig;
}

function gatewayUrl() {
    return process.env.AI_GATEWAY_URL || loadGatewayConfig().AI_GATEWAY_URL || 'http://localhost:3002/v1/chat/completions';
}
function gatewayKey() {
    return process.env.AI_GATEWAY_KEY || loadGatewayConfig().AI_GATEWAY_KEY;
}

async function callLevel2(systemPrompt, userPrompt) {
    const res = await fetch(gatewayUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${gatewayKey()}`
        },
        body: JSON.stringify({
            model: 'auto',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        })
    });
    if (!res.ok) throw new Error(`AI Gateway HTTP ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
}

module.exports = { callLevel1, callLevel2 };
