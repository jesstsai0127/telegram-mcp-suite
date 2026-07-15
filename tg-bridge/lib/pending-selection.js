// 「取消/完成待辦」流程用：列出候選清單後，記住每個聊天視窗正在等待回覆哪一個編號。
// 純記憶體狀態，process 重啟會清空——這是可接受的，重啟後使用者重新講一次就好。

const pending = new Map();

function setPending(chatId, data) {
    pending.set(chatId, data);
}

function getPending(chatId) {
    return pending.get(chatId);
}

function clearPending(chatId) {
    pending.delete(chatId);
}

module.exports = { setPending, getPending, clearPending };
