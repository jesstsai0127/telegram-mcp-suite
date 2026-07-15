// 在本機快取的資料上重現 Notion API 的 filter/sorts 語意，讓 cache-aside 對呼叫端完全透明——
// router.js 原本怎麼組 Notion filter 物件，快取命中時就用同一份物件在本機評估，不用改任何呼叫端。
// 只實作這個 repo 實際會用到的運算子組合（and/or 巢狀、title 的 contains/equals、select 的
// equals、date 的 equals/on_or_after/on_or_before/before/is_empty/is_not_empty、
// timestamp:last_edited_time 的 on_or_after/before），不是重現 Notion API 的完整規格。

function getPropertyValue(properties, name) {
    return properties[name];
}

function textOf(prop) {
    if (!prop) return '';
    const arr = prop.title || prop.rich_text || [];
    return arr.map(t => t.plain_text).join('');
}

function matchesCondition(row, condition) {
    if (condition.and) return condition.and.every(c => matchesCondition(row, c));
    if (condition.or) return condition.or.some(c => matchesCondition(row, c));

    if (condition.timestamp === 'last_edited_time') {
        const value = row.last_edited_time;
        return matchesDateOp(value, condition.last_edited_time);
    }
    if (condition.timestamp === 'created_time') {
        const value = row.created_time;
        return matchesDateOp(value, condition.created_time);
    }

    const prop = getPropertyValue(row.properties, condition.property);

    if (condition.title) return matchesTextOp(textOf(prop), condition.title);
    if (condition.rich_text) return matchesTextOp(textOf(prop), condition.rich_text);
    if (condition.select) return matchesSelectOp(prop?.select?.name ?? null, condition.select);
    if (condition.date) return matchesDateOp(prop?.date?.start ?? null, condition.date);

    throw new Error(`notion-filter: 不支援的條件類型 ${JSON.stringify(condition)}`);
}

function matchesTextOp(value, op) {
    if (op.equals !== undefined) return value === op.equals;
    if (op.contains !== undefined) return value.toLowerCase().includes(op.contains.toLowerCase());
    if (op.is_empty) return value === '';
    if (op.is_not_empty) return value !== '';
    throw new Error(`notion-filter: 不支援的文字運算子 ${JSON.stringify(op)}`);
}

function matchesSelectOp(value, op) {
    if (op.equals !== undefined) return value === op.equals;
    if (op.does_not_equal !== undefined) return value !== op.does_not_equal;
    throw new Error(`notion-filter: 不支援的 select 運算子 ${JSON.stringify(op)}`);
}

function matchesDateOp(value, op) {
    if (op.is_empty) return value === null || value === undefined;
    if (op.is_not_empty) return value !== null && value !== undefined;
    if (value === null || value === undefined) return false; // 沒有值時，其餘比較一律不成立
    if (op.equals !== undefined) return value.slice(0, 10) === op.equals.slice(0, 10);
    // on_or_after/on_or_before/before/after 一律轉成實際時間點比較，不能比字串——這個 repo
    // 裡 Due Date/Next Trigger 是用 +08:00 offset 字串寫入，但 last_edited_time 之類的
    // timestamp 或用 .toISOString() 算出來的邊界值是 UTC（Z 結尾），兩種格式混用時字典序
    // 跟實際時間先後會對不上（尤其台北當地 00:00-08:00 這段、UTC 日期還是前一天）
    const t = new Date(value).getTime();
    if (op.on_or_after !== undefined) return t >= new Date(op.on_or_after).getTime();
    if (op.on_or_before !== undefined) return t <= new Date(op.on_or_before).getTime();
    if (op.before !== undefined) return t < new Date(op.before).getTime();
    if (op.after !== undefined) return t > new Date(op.after).getTime();
    throw new Error(`notion-filter: 不支援的日期運算子 ${JSON.stringify(op)}`);
}

function matchesFilter(row, filter) {
    if (!filter || Object.keys(filter).length === 0) return true;
    return matchesCondition(row, filter);
}

function getSortValue(row, propertyName) {
    const prop = getPropertyValue(row.properties, propertyName);
    if (!prop) return null;
    if (prop.date) return prop.date.start;
    // findRecords 固定用 Created（created_time 型別）排序——這種型別的屬性值不是放在
    // prop.date，是 prop.created_time／prop.last_edited_time，沒有這兩行的話走快取路徑
    // 排序會靜默變成 no-op（不會報錯，但清單順序整個是錯的）
    if (prop.created_time) return prop.created_time;
    if (prop.last_edited_time) return prop.last_edited_time;
    if (prop.number !== undefined) return prop.number;
    if (prop.select) return prop.select.name;
    if (prop.title || prop.rich_text) return textOf(prop);
    return null;
}

function applySort(rows, sorts) {
    if (!sorts || sorts.length === 0) return rows;
    const sorted = [...rows];
    sorted.sort((a, b) => {
        for (const s of sorts) {
            const av = getSortValue(a, s.property);
            const bv = getSortValue(b, s.property);
            if (av === bv) continue;
            if (av === null) return 1; // 空值排最後，跟 Notion 的預設行為一致
            if (bv === null) return -1;
            const cmp = av < bv ? -1 : 1;
            return s.direction === 'descending' ? -cmp : cmp;
        }
        return 0;
    });
    return sorted;
}

function queryLocal(rows, filter, sorts) {
    return applySort(rows.filter(row => matchesFilter(row, filter)), sorts);
}

module.exports = { matchesFilter, applySort, queryLocal };
