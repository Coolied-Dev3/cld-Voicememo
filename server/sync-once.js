// To Do 同期を 1 回だけ実行して結果を表示する（サーバーを止めずに動作確認できる）
//   node server/sync-once.js
import { initDb } from './db.js'
import * as ms from './msgraph.js'

const db = await initDb()
if (!ms.msEnabled) { console.log('MS_CLIENT_ID が未設定です'); process.exit(1) }
for (const { user_id, account } of await db.all('SELECT user_id, account FROM ms_tokens')) {
  try {
    const r = await ms.syncTasks(db, user_id)
    console.log(`user=${user_id} (${account}) 追加 ${r.added} / 更新 ${r.updated} / 削除 ${r.removed}`)
  } catch (e) { console.log(`user=${user_id} (${account}) 失敗: ${e.message}`) }
}
const rows = await db.all(`SELECT id,user_id,title,status,due_at,source,created_at FROM memos WHERE source='todo' ORDER BY id DESC LIMIT 30`)
console.log(`\nTo Do 由来のメモ ${rows.length} 件:`)
for (const m of rows) console.log(`  #${m.id} u${m.user_id} [${m.status}] ${m.title}  期限 ${String(m.due_at || '').slice(0, 10)}  作成 ${String(m.created_at).slice(0, 16)}`)
await db.close()
