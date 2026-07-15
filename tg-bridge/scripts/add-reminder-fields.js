// 一次性腳本：幫「已存在」的 Tasks/Shopping data source 加上多筆提醒排程需要的新欄位。
// Tasks 只需要 Reminder Offsets（一次性到期提醒清單，逗號分隔分鐘數）；
// Shopping 除了 Reminder Offsets 之外，還需要 Occurrence At（週期性模板「這一輪真正該買」
// 的時刻，跟可能指向提前通知時間點的 Next Trigger 分開）。

require('dotenv').config({ path: process.env.ENV_PATH || (__dirname + '/../../../../.secrets/.env.local') });
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const configPath = process.env.NOTION_DBS_CONFIG_PATH || path.join(__dirname, '..', 'config', 'notion-dbs.json');
const dbIds = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function addFields(dbKey, properties) {
    const dataSourceId = dbIds[dbKey]?.data_source_id;
    if (!dataSourceId) {
        console.error(`找不到 ${dbKey} 的 data_source_id，檢查 ${configPath}`);
        process.exit(1);
    }
    await notion.dataSources.update({ data_source_id: dataSourceId, properties });
    console.log(`已幫 ${dbKey} data source (${dataSourceId}) 加上提醒排程需要的欄位`);
}

(async () => {
    try {
        await addFields('Tasks', { 'Reminder Offsets': { rich_text: {} } });
        await addFields('Shopping', {
            'Reminder Offsets': { rich_text: {} },
            'Occurrence At': { date: {} }
        });
    } catch (e) {
        console.error('ERROR', e.message);
        process.exit(1);
    }
})();
