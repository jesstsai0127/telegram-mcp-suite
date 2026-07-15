// 一般設定頁面的資料層：本機 JSON 檔案，不放 Notion——這些是「系統行為預設值」
// 不是使用者資料，跟 config/notion-dbs.json 一樣屬於本機設定檔（可以被 git 追蹤，
// 不含機密），比照 SKILL_REGISTRY_PATH 的做法用環境變數指定路徑，讓測試環境能指向
// 獨立檔案，不跟正式環境共用。

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = process.env.SETTINGS_PATH ||
    path.join(__dirname, '..', 'config', 'settings.json');

// 每個設定項目的預設值、允許值驗證、顯示用的說明文字都集中在這裡——
// 之後在一般設定頁面加新的可調整項目，只需要在這裡加一筆，不用改頁面邏輯。
const SETTINGS_SCHEMA = {
    defaultReminderTime: {
        default: '09:00',
        label: '預設提醒時間',
        description: '待辦事項只給日期、沒給時間時，用這個時間補上（有時間才會真的排提醒；完全沒給日期的不受影響，不會被加上提醒）',
        validate: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)
    }
};

function loadSettings() {
    let stored = {};
    if (fs.existsSync(SETTINGS_PATH)) {
        try {
            stored = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        } catch (e) {
            stored = {};
        }
    }
    const merged = {};
    for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
        merged[key] = spec.validate(stored[key]) ? stored[key] : spec.default;
    }
    return merged;
}

function getSetting(key) {
    return loadSettings()[key];
}

function updateSettings(patch) {
    const current = loadSettings();
    for (const [key, value] of Object.entries(patch)) {
        const spec = SETTINGS_SCHEMA[key];
        if (!spec) continue; // 不認得的欄位直接忽略，不寫進檔案
        if (!spec.validate(value)) continue; // 驗證失敗保留原值，不整批打回
        current[key] = value;
    }
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2) + '\n');
    return current;
}

function listSettingsWithMeta() {
    const current = loadSettings();
    return Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => ({
        key, value: current[key], label: spec.label, description: spec.description
    }));
}

module.exports = { getSetting, updateSettings, listSettingsWithMeta, SETTINGS_PATH };
