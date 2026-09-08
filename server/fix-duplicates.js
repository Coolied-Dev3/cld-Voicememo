// 重複メモの整理: 同じユーザー・同じ本文で 60 秒以内に作られたメモのうち、後から作られた方を削除する。
// Microsoft 連携で作られた予定 / To Do も一緒に削除する。
//   node server/fix-duplicates.js          → 対象を表示するだけ
//   node server/fix-duplicates.js --apply  → 実際に削除
import { initDb } from './db.js'
import * as ms from './msgraph.js'

const apply = process.argv.includes('--apply')
const db = await initDb()
const rows = await db.all('SELECT * FROM memos ORDER BY id')
const dups = []
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j]
    if (a.user_id === b.user_id && a.text === b.text && Math.abs(new Date(b.created_at) - new Date(a.created_at)) <= 60000 && !dups.includes(b)) dups.push(b)
  }
}
if (!dups.length) { console.log('重複はありません'); await db.close(); process.exit(0) }
for (const m of dups) {
  console.log(`#${m.id} [${m.category}] ${m.title} (${m.created_at}) outlook=${m.outlook_status}${m.outlook_id ? ' graph-id あり' : ''}`)
  if (!apply) continue
  if (m.outlook_id && m.outlook_status === 'done' && ms.msEnabled && (await ms.isConnected(db, m.user_id))) {
    try { const ok = await ms.deleteItem(db, m.user_id, m); console.log(`   Outlook 側を削除: ${ok ? 'OK' : 'スキップ'}`) } catch (e) { console.log('   Outlook 側の削除失敗:', e.message) }
  }
  await db.run('DELETE FROM memos WHERE id=?', [m.id])
  console.log('   メモを削除')
}
console.log(apply ? '完了' : '\n--apply を付けると削除します')
await db.close()
