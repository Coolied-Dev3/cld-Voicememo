// 診断: メモに紐づく To Do タスクの状態を表示する。  node server/check-task.js <memoId> [--complete|--reopen]
import { initDb } from './db.js'
import * as ms from './msgraph.js'

const id = Number(process.argv[2])
const db = await initDb()
const m = await db.get('SELECT * FROM memos WHERE id=?', [id])
if (!m) { console.log('メモが見つかりません'); process.exit(1) }
console.log(`memo #${m.id} [${m.category}] ${m.title} status=${m.status} outlook_status=${m.outlook_status}`)
console.log('outlook_id:', m.outlook_id)
try {
  const before = await ms.getTask(db, m.user_id, m)
  console.log('To Do (before):', before)
  if (process.argv.includes('--complete')) { await ms.setTaskCompleted(db, m.user_id, m, true); console.log('→ 完了にしました') }
  if (process.argv.includes('--reopen')) { await ms.setTaskCompleted(db, m.user_id, m, false); console.log('→ 未完了に戻しました') }
  if (process.argv.length > 3) console.log('To Do (after):', await ms.getTask(db, m.user_id, m))
} catch (e) { console.log('Graph エラー:', e.message) }
if (process.argv.includes('--list')) {
  try {
    const tasks = await ms.listTasks(db, m.user_id)
    for (const t of tasks) console.log(`  ${t.status.padEnd(11)} ${t.title}  id=${t.id.slice(-12)}`)
  } catch (e) { console.log('一覧エラー:', e.message) }
}
await db.close()
