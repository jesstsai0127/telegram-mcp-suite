const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 每個測試用獨立的暫存檔案，不動到真正的 config/settings.json，也不用擔心測試之間互相汙染
function freshSettingsModule() {
    const tmpPath = path.join(os.tmpdir(), `axis-settings-test-${Date.now()}-${Math.random()}.json`);
    process.env.SETTINGS_PATH = tmpPath;
    delete require.cache[require.resolve('../lib/settings')];
    return { settings: require('../lib/settings'), tmpPath };
}

test('settings: 檔案不存在時，回傳所有欄位的預設值', () => {
    const { settings, tmpPath } = freshSettingsModule();
    assert.equal(settings.getSetting('defaultReminderTime'), '09:00');
    fs.rmSync(tmpPath, { force: true });
});

test('settings: updateSettings 寫入有效值後，getSetting 讀得到新值', () => {
    const { settings, tmpPath } = freshSettingsModule();
    settings.updateSettings({ defaultReminderTime: '20:30' });
    assert.equal(settings.getSetting('defaultReminderTime'), '20:30');
    fs.rmSync(tmpPath, { force: true });
});

test('settings: updateSettings 給無效格式時，保留原值，不整批打回', () => {
    const { settings, tmpPath } = freshSettingsModule();
    settings.updateSettings({ defaultReminderTime: '20:30' });
    settings.updateSettings({ defaultReminderTime: '不是時間格式' });
    assert.equal(settings.getSetting('defaultReminderTime'), '20:30');
    fs.rmSync(tmpPath, { force: true });
});

test('settings: 不認得的欄位直接忽略，不會寫進檔案', () => {
    const { settings, tmpPath } = freshSettingsModule();
    settings.updateSettings({ notARealSetting: 'hello' });
    const raw = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    assert.equal('notARealSetting' in raw, false);
    fs.rmSync(tmpPath, { force: true });
});

test('listSettingsWithMeta: 回傳給設定頁面用的 label/description/value', () => {
    const { settings, tmpPath } = freshSettingsModule();
    const list = settings.listSettingsWithMeta();
    const item = list.find(s => s.key === 'defaultReminderTime');
    assert.equal(item.value, '09:00');
    assert.ok(item.label);
    assert.ok(item.description);
    fs.rmSync(tmpPath, { force: true });
});
