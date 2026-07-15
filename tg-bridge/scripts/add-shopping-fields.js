// 一次性腳本：幫「已存在」的 Shopping data source 加上 /shopping 獨立技能需要的新欄位。
// 跟 setup-notion.js 不同——那支是建全新 DB，這支是幫既有 DB 加欄位，不影響既有資料。
// Price Estimate / Notes / Purchased Date 如果已經存在就不會被覆蓋（Notion API 對已存在
// 且未變更的屬性定義是 no-op）。

require('dotenv').config({ path: process.env.ENV_PATH || (__dirname + '/../../../../.secrets/.env.local') });
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const configPath = process.env.NOTION_DBS_CONFIG_PATH || path.join(__dirname, '..', 'config', 'notion-dbs.json');
const dbIds = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dataSourceId = dbIds.Shopping?.data_source_id;
if (!dataSourceId) {
    console.error(`找不到 Shopping 的 data_source_id，檢查 ${configPath}`);
    process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
        'Type': { select: { options: [{ name: '單次' }, { name: '週期性' }] } },
        'Recurrence': { rich_text: {} },
        'Next Trigger': { date: {} },
        'Buyer': { rich_text: {} },
        'Location': { rich_text: {} },
        'Quantity Needed': { number: {} },
        'Quantity Purchased': { number: {} },
        'Actual Price': { number: {} },
        'Price Estimate': { number: {} },
        'Notes': { rich_text: {} },
        'Purchased Date': { date: {} }
    }
}).then(() => {
    console.log(`已幫 Shopping data source (${dataSourceId}) 加上 /shopping 需要的欄位`);
}).catch(e => {
    console.error('ERROR', e.message);
    process.exit(1);
});
