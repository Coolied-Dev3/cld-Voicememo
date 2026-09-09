// 既存メモを現在の振り分けルールで再分類する（やること⇔予定のみ。調べもの・買い物は変更しない）
//   node server/reclassify.js          → 変更対象を表示するだけ
//   node server/reclassify.js --apply  → 実際に更新（Microsoft 連携済みなら To Do / 予定表も付け替える）
import { initDb, nowStr } from './db.js'
import { classifyText } from './classify.js'
import * as ms from './msgraph.js'

const apply = process.argv.includes('--apply')
const db = await initDb()
const rows = await db.all(`SELECT * FROM memos WHERE category IN ('todo','schedule','idea') ORDER BY id`)
let changed = 0
for (const m of rows) {
  const c = classifyText(m.text, new Date(m.created_at))
  if (!['todo', 'schedule'].includes(c.category) || c.category === m.category) continue
  changed++
  const when = c.category === 'schedule' ? `${c.start_at}${c.all_day ? '（終日）' : ''}` : '日時なし'
  console.log(`#${m.id} ${m.category} → ${c.category}  「${m.text}」  ${when}`)
  if (!apply) continue

  const connected = m.user_id && ms.msEnabled && (await ms.isConnected(db, m.user_id))
  // 旧カテゴリで作った To Do / 予定を削除
  if (connected && m.outlook_id && m.outlook_status === 'done') {
    try { await ms.deleteItem(db, m.user_id, m); console.log('   旧 Outlook 項目を削除') } catch (e) { console.log('   旧 Outlook 項目の削除失敗:', e.message) }
  }
  const f = {
    category: c.category, title: c.title || m.title,
    start_at: c.category === 'schedule' ? c.start_at : null,
    end_at: c.category === 'schedule' ? c.end_at : null,
    all_day: c.category === 'schedule' ? c.all_day : 0,
    due_at: null,
    outlook_status: 'pending', outlook_id: null, outlook_url: null, outlook_error: null,
    updated_at: nowStr(),
  }
  await db.run(`UPDATE memos SET ${Object.keys(f).map((k) => k + '=?').join(',')} WHERE id=?`, [...Object.values(f), m.id])
  const nm = await db.get('SELECT * FROM memos WHERE id=?', [m.id])
  if (connected && nm.status !== 'done') {
    try {
      const r = nm.category === 'todo' ? await ms.createTask(db, nm.user_id, nm) : await ms.createEvent(db, nm.user_id, nm)
      await db.run('UPDATE memos SET outlook_status=?, outlook_id=?, outlook_url=? WHERE id=?', ['done', r.id, r.url, nm.id])
      console.log(`   ${nm.category === 'todo' ? 'To Do' : '予定表'} に登録し直し`)
    } catch (e) {
      await db.run('UPDATE memos SET outlook_status=?, outlook_error=? WHERE id=?', ['error', e.message, nm.id])
      console.log('   Outlook 登録失敗:', e.message)
    }
  } else {
    await db.run('UPDATE memos SET outlook_status=? WHERE id=?', [nm.status === 'done' ? 'none' : 'link', nm.id])
  }
}
console.log(changed ? (apply ? `${changed} 件を更新しました` : `\n${changed} 件が対象です。--apply を付けると更新します`) : '変更対象はありません')
await db.close()
