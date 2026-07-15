// 每個「實體」(entity) 對應到 Notion 的哪個 DB、標題欄位叫什麼、
// 建立/查詢/修改需要哪些欄位轉換——這是唯一需要因為 DB 不同而寫的客製化部分。
// 查詢/建立/修改的「動作」本身在 notion.js 是通用函式，不因為 entity 不同而重寫。

const format = require('./format');

// 規則性任務不寫 Due Date，只靠 Next Trigger 驅動——跟 daily_report_push 查「明天有哪些
// 規則性任務」的邏輯一致。toCreateFields（新建）跟 toUpdateFields（修改整條規則）共用
// 同一段轉換，規則本身的解析（自然語言 → rrule → icalString/firstTrigger）在呼叫端
// （router.js／todo-flow.js，已經 require 了 lib/recurrence.js）做完才傳進來。
function recurringToFields(recurring) {
    return {
        Recurrence: { rich_text: [{ text: { content: recurring.icalString } }] },
        'Next Trigger': { date: { start: recurring.firstTrigger } }
    };
}

const SCHEMAS = {
    task: {
        dbKey: 'Tasks',
        titleProperty: 'Title',
        hasDueDate: true,
        pendingStatuses: ['待辦', '進行中'],
        queryFilter: {
            or: [
                { property: 'Status', select: { equals: '待辦' } },
                { property: 'Status', select: { equals: '進行中' } }
            ]
        },
        formatter: format.formatTasks,
        toCreateFields({ title, due_date, next_trigger, recurring, priority, category, notes, reminderOffsets }) {
            const fields = {
                Title: { title: [{ text: { content: title } }] },
                Type: { select: { name: recurring ? '規則性' : '單次' } },
                Status: { select: { name: '待辦' } },
                Category: { select: { name: category || '一般' } }
            };
            if (priority) fields.Priority = { select: { name: priority } };
            if (notes) fields.Notes = { rich_text: [{ text: { content: notes } }] };
            if (recurring) return { ...fields, ...recurringToFields(recurring) };
            if (due_date) fields['Due Date'] = { date: { start: due_date } };
            if (next_trigger) fields['Next Trigger'] = { date: { start: next_trigger } };
            // 只有一次性且有到期提醒排程時才需要記這份清單——規則性任務靠 rrule 自己驅動，
            // 不是「到期前 N 分鐘提醒」這種語意，不用寫這個欄位
            if (reminderOffsets) fields['Reminder Offsets'] = { rich_text: [{ text: { content: reminderOffsets } }] };
            return fields;
        },
        toUpdateFields(changes) {
            const fields = {};
            if (changes.title !== undefined) fields.Title = { title: [{ text: { content: changes.title } }] };
            if (changes.due_date !== undefined) {
                fields['Due Date'] = { date: changes.due_date ? { start: changes.due_date } : null };
                // 日期改了，舊的提醒時間點基準已經失效，先清空，避免用舊日期算出的提醒時間誤發
                fields['Next Trigger'] = { date: null };
            }
            if (changes.reminderOffsets !== undefined) {
                fields['Reminder Offsets'] = { rich_text: [{ text: { content: changes.reminderOffsets } }] };
            }
            if (changes.next_trigger !== undefined) {
                fields['Next Trigger'] = { date: changes.next_trigger ? { start: changes.next_trigger } : null };
            }
            if (changes.priority !== undefined) fields.Priority = { select: { name: changes.priority } };
            if (changes.category !== undefined) fields.Category = { select: { name: changes.category || '一般' } };
            if (changes.notes !== undefined) fields.Notes = { rich_text: [{ text: { content: changes.notes || '' } }] };
            // 純狀態切換（待辦/進行中/完成/取消）——網頁清單頁的「標記完成/取消」快速動作用這個，
            // 跟 chat 路徑的 resolveRecordSelection 直接寫 Status 是同一種操作，這裡補一個進入點
            // 讓網頁表單也能透過同一個 toUpdateFields 走
            if (changes.status !== undefined) {
                fields.Status = { select: { name: changes.status } };
                // 取消掉的項目（不管一次性還是規則性模板）不該再觸發任何提醒——沒清空的話
                // 規則性模板會繼續被 daily_report_push／check_reminders 撿到，一次性任務
                // 也不該死掉了還響鬧鐘
                if (changes.status === '取消') fields['Next Trigger'] = { date: null };
                // 完成當下順便記錄時間點，才能像 Shopping 的 Purchased Date 一樣依時間分組/
                // 篩選歷史——查過 Google Tasks/Todoist 的官方 API，兩者都把「完成時間」跟
                // 「到期時間」當成獨立欄位，不是同一個時間點
                if (changes.status === '完成') fields['Completed Date'] = { date: { start: new Date().toISOString() } };
            }
            // 修改整條週期規則本身（例如「每週一」改成「每週一三五」）——changes.recurring
            // 是呼叫端已經解析好的 { icalString, firstTrigger }，這裡跟新建任務共用同一段轉換
            if (changes.recurring !== undefined) {
                fields.Type = { select: { name: '規則性' } };
                Object.assign(fields, recurringToFields(changes.recurring));
            }
            return fields;
        }
    },
    shopping: {
        dbKey: 'Shopping',
        titleProperty: 'Item',
        // 2026-07-08 起一次性項目也有到期日（例如出國前一週要買 sim 卡），modify_record
        // 跨 DB 搜尋才需要顯示/篩選 Due Date——週期性模板沒有這個屬性，findRecords 加的
        // 篩選只有帶 scope 才生效，不影響現有查全部候選的行為
        hasDueDate: true,
        pendingStatuses: ['待購'],
        queryFilter: { property: 'Status', select: { equals: '待購' } },
        formatter: format.formatShopping,
        // 週期性項目是「模板」：本身永遠 Status=待購，只有 Next Trigger 會推進（跟 task 的
        // 規則性任務同一套 recurringToFields 轉換）。買了才另外建一筆獨立的購買紀錄
        // （Type=單次, Status=已購），不是把模板本身標記已購——這樣消費紀錄才能一筆一筆累積。
        toCreateFields({ title, priority, buyer, location, category, quantityNeeded, priceEstimate, notes, recurring, reminderOffsets, due_date, next_trigger }) {
            const fields = {
                Item: { title: [{ text: { content: title } }] },
                Type: { select: { name: recurring ? '週期性' : '單次' } },
                Priority: { select: { name: priority || '一般' } },
                Status: { select: { name: '待購' } },
                Buyer: { rich_text: [{ text: { content: buyer || '我自己' } }] },
                Category: { select: { name: category || '一般' } }
            };
            if (location) fields.Location = { rich_text: [{ text: { content: location } }] };
            if (Number.isFinite(quantityNeeded)) fields['Quantity Needed'] = { number: quantityNeeded };
            if (Number.isFinite(priceEstimate)) fields['Price Estimate'] = { number: priceEstimate };
            if (notes) fields.Notes = { rich_text: [{ text: { content: notes } }] };
            if (recurring) {
                // recurring.firstTrigger 是這一輪「真正該買」的時刻（Occurrence At）；
                // Next Trigger 由呼叫端決定——可能是提前通知的時間點，也可能沒有提前通知
                // 可排（例如兩個 offset 都已經過期）時就直接等於 firstTrigger 本身
                Object.assign(fields, {
                    Recurrence: { rich_text: [{ text: { content: recurring.icalString } }] },
                    'Next Trigger': { date: { start: recurring.nextTrigger || recurring.firstTrigger } },
                    'Occurrence At': { date: { start: recurring.firstTrigger } }
                });
                if (reminderOffsets) fields['Reminder Offsets'] = { rich_text: [{ text: { content: reminderOffsets } }] };
                return fields;
            }
            // 一次性項目也可能有到期日（例如出國前一週要買 SIM 卡）——跟 task 的一次性到期
            // 提醒同一套語意，due_date 有值才代表需要提醒，沒給就是「還沒排時間的待買」
            if (due_date) fields['Due Date'] = { date: { start: due_date } };
            if (next_trigger) fields['Next Trigger'] = { date: { start: next_trigger } };
            if (reminderOffsets) fields['Reminder Offsets'] = { rich_text: [{ text: { content: reminderOffsets } }] };
            return fields;
        },
        toUpdateFields(changes) {
            const fields = {};
            if (changes.title !== undefined) fields.Item = { title: [{ text: { content: changes.title } }] };
            if (changes.priority !== undefined) fields.Priority = { select: { name: changes.priority } };
            if (changes.buyer !== undefined) fields.Buyer = { rich_text: [{ text: { content: changes.buyer } }] };
            if (changes.location !== undefined) fields.Location = { rich_text: [{ text: { content: changes.location || '' } }] };
            if (changes.category !== undefined) fields.Category = { select: { name: changes.category || '一般' } };
            if (changes.notes !== undefined) fields.Notes = { rich_text: [{ text: { content: changes.notes || '' } }] };
            if (changes.quantityNeeded !== undefined) fields['Quantity Needed'] = { number: changes.quantityNeeded };
            if (changes.priceEstimate !== undefined) fields['Price Estimate'] = { number: changes.priceEstimate };
            if (changes.due_date !== undefined) {
                fields['Due Date'] = { date: changes.due_date ? { start: changes.due_date } : null };
                // 跟 task 的 due_date 修改同一個理由：日期改了，舊的提醒時間點基準已經失效
                fields['Next Trigger'] = { date: null };
            }
            // 純狀態切換（待購/取消）——「已購」有專屬的 changes.purchase 分支（要順便填購買明細），
            // 這裡只處理不需要額外明細的狀態，例如網頁清單頁的「取消」快速動作
            if (changes.status !== undefined) {
                fields.Status = { select: { name: changes.status } };
                // check_shopping_reminders 只看 Type+Next Trigger，不看 Status——取消掉的
                // 週期性模板如果沒清空 Next Trigger，會被繼續撿到、一直推播購買提醒
                if (changes.status === '取消') fields['Next Trigger'] = { date: null };
            }
            // 標記已購買：一次寫入這筆紀錄的購買明細（這筆本身就是一次性的購買紀錄，
            // 不管是原本就是一次性項目、還是週期性模板觸發後新建的購買紀錄）
            if (changes.purchase !== undefined) {
                fields.Status = { select: { name: '已購' } };
                if (Number.isFinite(changes.purchase.quantityPurchased)) {
                    fields['Quantity Purchased'] = { number: changes.purchase.quantityPurchased };
                }
                if (Number.isFinite(changes.purchase.actualPrice)) {
                    fields['Actual Price'] = { number: changes.purchase.actualPrice };
                }
                if (changes.purchase.purchasedDate) {
                    fields['Purchased Date'] = { date: { start: changes.purchase.purchasedDate } };
                }
            }
            // 修改週期性模板本身的重複規則——跟 toCreateFields 的 recurring 分支同一套邏輯
            // （Occurrence At 是真正到期時刻，Next Trigger 可能是提前通知或就是到期時刻本身）
            if (changes.recurring !== undefined) {
                fields.Type = { select: { name: '週期性' } };
                Object.assign(fields, {
                    Recurrence: { rich_text: [{ text: { content: changes.recurring.icalString } }] },
                    'Next Trigger': { date: { start: changes.recurring.nextTrigger || changes.recurring.firstTrigger } },
                    'Occurrence At': { date: { start: changes.recurring.firstTrigger } }
                });
            }
            if (changes.reminderOffsets !== undefined) {
                fields['Reminder Offsets'] = { rich_text: [{ text: { content: changes.reminderOffsets } }] };
            }
            // check_shopping_reminders/shopping-flow.js 推進到下一個提醒點或下一輪 occurrence 時，
            // 只需要單獨改這兩個時間欄位，不需要透過完整的 recurring 物件走一次
            if (changes.nextTrigger !== undefined) {
                fields['Next Trigger'] = { date: changes.nextTrigger ? { start: changes.nextTrigger } : null };
            }
            if (changes.occurrenceAt !== undefined) {
                fields['Occurrence At'] = { date: changes.occurrenceAt ? { start: changes.occurrenceAt } : null };
            }
            return fields;
        }
    },
    idea: {
        dbKey: 'Ideas',
        titleProperty: 'Title',
        pendingStatuses: ['新增', '評估中'],
        queryFilter: undefined,
        querySorts: [{ property: 'Created', direction: 'descending' }],
        formatter: format.formatIdeas,
        toCreateFields({ title, content }) {
            return {
                Title: { title: [{ text: { content: title } }] },
                Content: { rich_text: [{ text: { content: content || '' } }] },
                Status: { select: { name: '新增' } },
                Source: { select: { name: 'Telegram' } }
            };
        },
        toUpdateFields(changes) {
            const fields = {};
            if (changes.title !== undefined) fields.Title = { title: [{ text: { content: changes.title } }] };
            if (changes.content !== undefined) fields.Content = { rich_text: [{ text: { content: changes.content } }] };
            // resolveRecordSelection 的「完成/取消」共用這個函式寫入純狀態切換
            if (changes.status !== undefined) fields.Status = { select: { name: changes.status } };
            return fields;
        }
    },
    project: {
        dbKey: 'Projects',
        titleProperty: 'Name',
        pendingStatuses: [],
        queryFilter: undefined,
        formatter: format.formatProjects
        // 沒有 toCreateFields/toUpdateFields：Projects 由 setup script 建立，不透過聊天新增/修改
    },
    health: {
        dbKey: 'Health',
        titleProperty: 'Date',
        pendingStatuses: [],
        queryFilter: undefined,
        querySorts: [{ property: 'Created', direction: 'descending' }],
        formatter: format.formatHealth,
        // Health 的 Title 欄位本身就是日期（YYYY-MM-DD），不是使用者自由輸入的標題，
        // 這裡固定用 date（沒給就用今天），跟 task/shopping/idea 的 title 語意不同
        toCreateFields({ date, status, symptoms, energy_level, sleep_hours, notes }) {
            const fields = {
                Date: { title: [{ text: { content: date || format.todayStr() } }] },
                Status: { select: { name: status || '普通' } }
            };
            if (symptoms) fields.Symptoms = { rich_text: [{ text: { content: symptoms } }] };
            if (energy_level) fields['Energy Level'] = { select: { name: energy_level } };
            if (Number.isFinite(sleep_hours)) fields['Sleep Hours'] = { number: sleep_hours };
            if (notes) fields.Notes = { rich_text: [{ text: { content: notes } }] };
            return fields;
        }
    },
    diet: {
        dbKey: 'Diet',
        titleProperty: 'Title',
        pendingStatuses: [],
        queryFilter: undefined,
        querySorts: [{ property: 'Created', direction: 'descending' }],
        formatter: format.formatDiet,
        toCreateFields({ title, meal_type, date, time, calories, notes }) {
            const fields = {
                Title: { title: [{ text: { content: title } }] },
                'Meal Type': { select: { name: meal_type || '點心' } },
                Date: { date: { start: date || format.todayStr() } }
            };
            if (time) fields.Time = { rich_text: [{ text: { content: time } }] };
            if (Number.isFinite(calories)) fields.Calories = { number: calories };
            if (notes) fields.Notes = { rich_text: [{ text: { content: notes } }] };
            return fields;
        }
    },
    activity: {
        dbKey: 'Activity',
        titleProperty: 'Title',
        pendingStatuses: [],
        queryFilter: undefined,
        querySorts: [{ property: 'Created', direction: 'descending' }],
        formatter: format.formatActivity,
        toCreateFields({ title, type, date, duration, intensity, notes }) {
            const fields = {
                Title: { title: [{ text: { content: title } }] },
                Type: { select: { name: type || '運動' } },
                Date: { date: { start: date || format.todayStr() } },
                Duration: { number: duration || 0 }
            };
            if (intensity) fields.Intensity = { select: { name: intensity } };
            if (notes) fields.Notes = { rich_text: [{ text: { content: notes } }] };
            return fields;
        }
    }
};

module.exports = { SCHEMAS };
