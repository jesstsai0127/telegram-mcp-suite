require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '..', '.secrets', '.env.local') });
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const PARENT_PAGE_ID = process.argv[2];
if (!PARENT_PAGE_ID) {
    console.error('Usage: node setup-notion.js <parent_page_id>');
    process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const select = (options) => ({ select: { options: options.map(name => ({ name })) } });

const DB_DEFINITIONS = {
    Ideas: {
        title: '點子庫',
        properties: {
            Title: { title: {} },
            Content: { rich_text: {} },
            Category: select(['生活', '工作', '技術', '其他']),
            Status: select(['新增', '評估中', '採用', '封存']),
            Source: select(['Telegram', '手動']),
            Created: { created_time: {} }
        }
    },
    Tasks: {
        title: '任務庫',
        properties: {
            Title: { title: {} },
            Type: select(['單次', '規則性']),
            Status: select(['待辦', '進行中', '完成', '取消']),
            Priority: select(['高', '中', '低']),
            'Due Date': { date: {} },
            Recurrence: { rich_text: {} },
            'Next Trigger': { date: {} },
            Notes: { rich_text: {} },
            Created: { created_time: {} }
        }
    },
    Shopping: {
        title: '購買清單',
        properties: {
            Item: { title: {} },
            Category: select(['食品', '電子', '生活用品', '其他']),
            Priority: select(['急需', '一般', '想買']),
            Status: select(['待購', '已購']),
            'Price Estimate': { number: { format: 'number' } },
            Notes: { rich_text: {} },
            'Purchased Date': { date: {} },
            Created: { created_time: {} }
        }
    },
    Projects: {
        title: '個人專案狀態',
        properties: {
            Name: { title: {} },
            Status: select(['規劃中', '開發中', 'Phase1完成', '維護中', '暫停']),
            'Current Phase': select(['Phase 1', 'Phase 2', 'Phase 3']),
            'Last Updated': { date: {} },
            Summary: { rich_text: {} },
            Issues: { rich_text: {} },
            'Skill ID': { rich_text: {} },
            'Repo URL': { url: {} }
        }
    },
    'Search Cache': {
        title: '搜尋快取',
        properties: {
            Query: { title: {} },
            'Search Keywords': { rich_text: {} },
            Summary: { rich_text: {} },
            'Source URLs': { rich_text: {} },
            Created: { created_time: {} },
            'Expires At': { date: {} },
            'Force Refresh': { checkbox: {} }
        }
    }
};

async function main() {
    const dbIds = {};

    for (const [key, def] of Object.entries(DB_DEFINITIONS)) {
        console.log(`Creating DB: ${key}...`);
        const res = await notion.databases.create({
            parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
            title: [{ type: 'text', text: { content: def.title } }],
            initial_data_source: { properties: def.properties }
        });
        dbIds[key] = { database_id: res.id, data_source_id: res.data_sources[0].id };
        console.log(`  -> database_id=${res.id} data_source_id=${res.data_sources[0].id}`);
    }

    const configPath = path.join(__dirname, '..', 'config', 'notion-dbs.json');
    fs.writeFileSync(configPath, JSON.stringify(dbIds, null, 2) + '\n');
    console.log(`Saved DB IDs to ${configPath}`);

    console.log('Seeding initial Projects row...');
    await notion.pages.create({
        parent: { database_id: dbIds.Projects.database_id },
        properties: {
            Name: { title: [{ text: { content: 'AXIS 個人助理' } }] },
            Status: { select: { name: '開發中' } },
            'Current Phase': { select: { name: 'Phase 1' } },
            'Last Updated': { date: { start: new Date().toISOString().slice(0, 10) } },
            Summary: { rich_text: [{ text: { content: 'Phase 1 骨架 MVP 開發中' } }] },
            'Repo URL': { url: 'https://github.com/jesstsai0127/opencode-agent' }
        }
    });
    console.log('Done.');
}

main().catch(err => {
    console.error(err.body || err.message);
    process.exit(1);
});
