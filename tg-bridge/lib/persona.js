const fs = require('fs');
const path = require('path');

const PERSONA_PATH = process.env.PERSONA_PATH ||
    path.join(__dirname, '..', '..', '..', 'assistant', 'persona.md');
const PERSONA_LOG_PATH = process.env.PERSONA_LOG_PATH ||
    path.join(__dirname, '..', '..', '..', 'assistant', 'persona-log.md');

const SECTIONS = ['語氣', '面對質疑', '準確性', '溝通方式', '決策支援'];
const DEFAULT_SECTION = '溝通方式';

function loadPersona() {
    return fs.readFileSync(PERSONA_PATH, 'utf8');
}

function backupPersona() {
    fs.copyFileSync(PERSONA_PATH, PERSONA_PATH + '.bak');
}

function appendPersonaLog(feedback, extractedRule, updateNote) {
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = `\n## ${timestamp} — 使用者反饋\n**使用者反饋**：${feedback}\n**提取的規則**：${extractedRule}\n**更新內容**：${updateNote}\n`;
    fs.appendFileSync(PERSONA_LOG_PATH, entry);
}

function insertRuleIntoSection(content, section, rule) {
    const lines = content.split('\n');
    const headerIdx = lines.findIndex(l => l.trim() === `**${section}**`);
    if (headerIdx === -1) return null;

    let insertIdx = headerIdx + 1;
    while (insertIdx < lines.length && lines[insertIdx].trim().startsWith('-')) {
        insertIdx++;
    }
    lines.splice(insertIdx, 0, `- ${rule}`);
    return lines.join('\n');
}

function bumpVersion(content, summary) {
    const lines = content.split('\n');
    const versionLineIdx = lines.reduce((last, l, i) => (/^- v\d+\.\d+：/.test(l.trim()) ? i : last), -1);
    if (versionLineIdx === -1) return content;

    const match = lines[versionLineIdx].match(/v(\d+)\.(\d+)/);
    const nextMinor = parseInt(match[2], 10) + 1;
    const nextVersion = `v${match[1]}.${nextMinor}`;
    lines.splice(versionLineIdx + 1, 0, `- ${nextVersion}：${summary}（反饋更新）`);

    const headerIdx = lines.findIndex(l => /^>\s*版本：v\d+\.\d+/.test(l.trim()));
    if (headerIdx !== -1) {
        lines[headerIdx] = lines[headerIdx].replace(/v\d+\.\d+/, nextVersion);
    }

    return lines.join('\n');
}

function applyFeedback(rule, section, summary) {
    const targetSection = SECTIONS.includes(section) ? section : DEFAULT_SECTION;
    backupPersona();

    const original = loadPersona();
    const withRule = insertRuleIntoSection(original, targetSection, rule);
    if (withRule === null) {
        return { section: targetSection, applied: false };
    }
    const updated = bumpVersion(withRule, summary);
    fs.writeFileSync(PERSONA_PATH, updated);
    return { section: targetSection, applied: true };
}

module.exports = {
    loadPersona, backupPersona, appendPersonaLog, applyFeedback,
    SECTIONS, PERSONA_PATH, PERSONA_LOG_PATH
};
