// 本地 skill-registry.json → Notion Skill Registry DB 單向同步（JSON 是唯一真實來源）。
// 新增 Skill 是罕見、人工的動作（改完程式碼本來就要重啟 tg-bridge），
// 不需要檔案監聽或排程輪詢，開機時同步一次就夠，跟 global-spec.md §4.3 的手動流程對得上。

const fs = require('fs');
const path = require('path');
const notion = require('./notion');

const REGISTRY_PATH = process.env.SKILL_REGISTRY_PATH ||
    path.join(__dirname, '..', '..', '..', 'global', 'skill-registry.json');

async function syncSkillRegistry() {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const existing = await notion.queryDb('Skill Registry');
    const byId = new Map(existing.map(r => [
        (r.properties['Skill ID'].title || []).map(t => t.plain_text).join(''), r
    ]));

    for (const skill of registry.skills) {
        const fields = {
            'Skill ID': { title: [{ text: { content: skill.id } }] },
            Name: { rich_text: [{ text: { content: skill.name } }] },
            Endpoint: { url: skill.endpoint },
            Status: { select: { name: skill.status } },
            Version: { rich_text: [{ text: { content: skill.version } }] },
            'Last Updated': { date: { start: registry.updated_at } }
        };
        const existingRow = byId.get(skill.id);
        if (existingRow) {
            await notion.updateRecord(existingRow.id, fields);
        } else {
            await notion.createRecord('Skill Registry', fields);
        }
    }
}

module.exports = { syncSkillRegistry };
