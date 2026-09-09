// MySQL モードの動作確認: 一時ユーザーを作り、API でログイン→登録→更新→削除→ユーザー削除まで行う
//   前提: DB_DRIVER=mysql で別ポート（既定 3012）のサーバーが起動していること
process.env.DB_DRIVER = 'mysql' // db.js を読み込む前に設定する（静的 import だと先に読まれてしまう）
const { initDb, nowStr } = await import('./db.js')
const { hashPassword } = await import('./auth.js')
const BASE = process.env.API_BASE || 'http://localhost:3012'
const db = await initDb()
const assert = (c, m) => { if (!c) { console.error('NG:', m); process.exitCode = 1 } else console.log('ok:', m) }

const loginId = 'smoke_' + Date.now()
const now = nowStr()
const { id: uid } = await db.run('INSERT INTO users (login_id,name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)', [loginId, 'smoke', hashPassword('smokepass1'), 'user', now, now])
assert(uid > 0, `一時ユーザー作成 id=${uid}`)

let cookie = ''
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json', cookie }, ...o, body: o.body ? JSON.stringify(o.body) : undefined })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
try {
  const h = await j('/api/health'); assert(h.db === 'mysql', `health db=${h.db}`)
  const l = await j('/api/auth/login', { method: 'POST', body: { loginId, password: 'smokepass1' } }); assert(l.status === 200, 'ログイン')
  const m1 = await j('/api/memos', { method: 'POST', body: { text: '明日15時に山田さんと打ち合わせ' } }); assert(m1.category === 'schedule' && m1.start_at, `予定登録 ${m1.start_at}`)
  const m2 = await j('/api/memos', { method: 'POST', body: { text: '見積書を送る' } }); assert(m2.category === 'todo' && m2.due_at, `やること登録 期限=${m2.due_at}`)
  const m3 = await j('/api/memos', { method: 'POST', body: { text: 'インボイス制度について調べて' } }); assert(m3.category === 'search', '調べもの登録')
  const list = await fetch(BASE + '/api/memos?q=' + encodeURIComponent('山田'), { headers: { cookie } }).then((r) => r.json()); assert(list.length === 1, 'LIKE 検索')
  const up = await j(`/api/memos/${m2.id}`, { method: 'PATCH', body: { status: 'done' } }); assert(up.status === 'done', '完了更新')
  const ch = await j(`/api/memos/${m1.id}`, { method: 'PATCH', body: { category: 'todo' } }); assert(ch.category === 'todo' && ch.due_at, 'カテゴリ変更')
  for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 2000)); const s = await j(`/api/memos/${m3.id}`); if (s.search_status !== 'pending') { assert(s.search_status === 'done', `検索完了 (${s.search_status})`); break } }
  const ics = await fetch(`${BASE}/api/memos/${m1.id}/ics`, { headers: { cookie } }); assert(ics.status === 200, '.ics')
  for (const m of [m1, m2, m3]) await j(`/api/memos/${m.id}`, { method: 'DELETE' })
  const left = await j('/api/memos'); assert(Array.isArray(left) ? left.length === 0 : left.length === undefined, '削除')
  const me = await j('/api/auth/me'); assert(me.status === 200 && me.user.login_id === loginId, 'セッション（MySQL）')
  await j('/api/auth/logout', { method: 'POST' })
} finally {
  for (const t of ['sessions', 'memos']) await db.run(`DELETE FROM ${t} WHERE user_id=?`, [uid])
  await db.run('DELETE FROM users WHERE id=?', [uid])
  console.log('一時ユーザーを削除')
  await db.close()
}
console.log(process.exitCode ? '== FAILED ==' : '== ALL OK (MySQL) ==')
