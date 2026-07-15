// scripts/setup-notion-phase3.js — 建立 Phase 3 的 Health/Diet/Activity DB
// 跟 setup-notion.js 分開，是因為那支腳本會把「所有」DB 都重建一次；
// 這裡只新增這三個沒建過的 DB，避免把已存在的 Ideas/Tasks/... 重複建立一份。
// schema 照 project-assistant-spec.md 4.7/4.8/4.9 節既有定義，沒有自己發明欄位。
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '..', '.secrets', '.env.local') });
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const PARENT_PAGE_ID = process.argv[2];
if (!PARENT_PAGE_ID) {
    console.error('Usage: node setup-notion-phase3.js <parent_page_id>');
    process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const select = (options) => ({ select: { options: options.map(name => ({ name })) } });

const DB_DEFINITIONS = {
    Health: {
        title: '身體狀況',
        properties: {
            Date: { title: {} },
            Status: select(['良好', '普通', '不適']),
            Symptoms: { rich_text: {} },
            'Energy Level': select(['高', '中', '低']),
            'Sleep Hours': { number: { format: 'number' } },
            Notes: { rich_text: {} },
            Created: { created_time: {} }
        }
    },
    Diet: {
        title: '飲食紀錄',
        properties: {
            Title: { title: {} },
            'Meal Type': select(['早餐', '午餐', '晚餐', '點心']),
            Date: { date: {} },
            Time: { rich_text: {} },
            Calories: { number: { format: 'number' } },
            Notes: { rich_text: {} },
            Created: { created_time: {} }
        }
    },
    Activity: {
        title: '運動休息紀錄',
        properties: {
            Title: { title: {} },
            Type: select(['運動', '休息', '伸展']),
            Date: { date: {} },
            Duration: { number: { format: 'number' } },
            Intensity: select(['高', '中', '低']),
            Notes: { rich_text: {} },
            Created: { created_time: {} }
        }
    }
};

async function main() {
    const configPath = path.join(__dirname, '..', 'config', 'notion-dbs.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    for (const [key, def] of Object.entries(DB_DEFINITIONS)) {
        if (existing[key]) {
            console.log(`Skipping ${key}, already exists (database_id=${existing[key].database_id})`);
            continue;
        }
        console.log(`Creating DB: ${key}...`);
        const res = await notion.databases.create({
            parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
            title: [{ type: 'text', text: { content: def.title } }],
            initial_data_source: { properties: def.properties }
        });
        existing[key] = { database_id: res.id, data_source_id: res.data_sources[0].id };
        console.log(`  -> database_id=${res.id} data_source_id=${res.data_sources[0].id}`);
    }

    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
    console.log(`Saved DB IDs to ${configPath}`);
}

main().catch(err => {
    console.error(err.body || err.message);
    process.exit(1);
});
