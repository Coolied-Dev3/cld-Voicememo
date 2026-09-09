// 期限のない「やること」に登録日を期限として設定する（DB と Microsoft To Do の両方）
//   node server/fix-due.js          → 対象を表示
//   node server/fix-due.js --apply  → 更新
import { initDb, nowStr } from './db.js'
import * as ms from './msgraph.js'

const apply = process.argv.includes('--apply')
const db = await initDb()
const rows = await db.all(`SELECT * FROM memos WHERE category='todo' AND due_at IS NULL ORDER BY id`)
if (!rows.length) { console.log('対象はありません'); await db.close(); process.exit(0) }
for (const m of rows) {
  const due = String(m.created_at).slice(0, 10) + ' 00:00:00'
  console.log(`#${m.id} ${m.title} (${m.status}) → 期限 ${due.slice(0, 10)}${m.outlook_id ? '  To Do も更新' : ''}`)
  if (!apply) continue
  await db.run('UPDATE memos SET due_at=?, updated_at=? WHERE id=?', [due, nowStr(), m.id])
  if (m.outlook_id && m.outlook_status === 'done' && ms.msEnabled && (await ms.isConnected(db, m.user_id))) {
    try { await ms.setTaskDue(db, m.user_id, { ...m, due_at: due }); console.log('   To Do の期限を設定') } catch (e) { console.log('   To Do 更新失敗:', e.message) }
  }
}
console.log(apply ? '完了' : '\n--apply を付けると更新します')
await db.close()
