// API の動作確認（サーバー起動中に実行）: node server/test-api.js [--clean]
// 管理者でログイン → ユーザー作成 → 2 ユーザーでメモ登録し、分離・分類・検索・Outlook リンクを確認する
const BASE = process.env.API_BASE || 'http://localhost:3002'
const ADMIN = { loginId: process.env.ADMIN_LOGIN_ID || 'admin', password: process.env.ADMIN_PASSWORD || 'voicememo' }

function client() {
  let cookie = ''
  const j = async (path, opts = {}) => {
    const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json', cookie }, redirect: 'manual', ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined })
    const sc = r.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
    const body = await r.json().catch(() => ({}))
    return { status: r.status, ...body, _raw: body }
  }
  return { j, get cookie() { return cookie } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (cond, msg) => { if (!cond) { console.error('NG:', msg); process.exitCode = 1 } else console.log('ok:', msg) }

const admin = client()
assert((await admin.j('/api/memos')).status === 401, '未ログインは 401')
const login = await admin.j('/api/auth/login', { method: 'POST', body: ADMIN })
assert(login.status === 200 && login.user?.role === 'admin', `管理者ログイン (${login.error || login.user?.login_id})`)
const bad = await admin.j('/api/auth/login', { method: 'POST', body: { loginId: ADMIN.loginId, password: 'wrong' } })
assert(bad.status === 401, 'パスワード誤り → 401')
const me = await admin.j('/api/auth/me')
assert(me.status === 200 && me.user && 'passkeys' in me, 'me')

// パスキーのオプション生成（登録・ログイン）
const regOpt = await admin.j('/api/passkey/register/options', { method: 'POST' })
assert(regOpt.status === 200 && regOpt.challenge && regOpt.rp?.id, `パスキー登録オプション rpId=${regOpt.rp?.id}`)
const loginOpt = await admin.j('/api/passkey/login/options', { method: 'POST' })
assert(loginOpt.status === 200 && loginOpt.challengeId && loginOpt.options?.challenge, 'パスキーログインオプション')

// ユーザー作成
if (process.argv.includes('--clean')) {
  for (const u of (await admin.j('/api/users'))._raw) if (u.login_id !== ADMIN.loginId) await admin.j(`/api/users/${u.id}`, { method: 'DELETE' })
  for (const m of (await admin.j('/api/memos'))._raw) await admin.j(`/api/memos/${m.id}`, { method: 'DELETE' })
  console.log('cleaned')
}
const mk = await admin.j('/api/users', { method: 'POST', body: { login_id: 'staff1', name: 'スタッフ1', password: 'staffpass1' } })
assert(mk.status === 200 || /既に/.test(mk.error || ''), `ユーザー作成 (${mk.error || mk.login_id})`)
const users = await admin.j('/api/users')
assert(users.status === 200 && users._raw.some((u) => u.login_id === 'staff1'), `ユーザー一覧 ${users._raw.length} 人`)

// 一般ユーザーでログイン
const staff = client()
const sl = await staff.j('/api/auth/login', { method: 'POST', body: { loginId: 'staff1', password: 'staffpass1' } })
assert(sl.status === 200 && sl.user?.role === 'user', '一般ユーザーログイン')
assert((await staff.j('/api/users')).status === 403, '一般ユーザーは /api/users 不可')

const samples = ['明日15時に山田さんと打ち合わせ', '牛乳と卵を買う', 'インボイス制度について調べて', 'アイデア、週報を音声で自動作成するツール']
const created = []
for (const text of samples) {
  const m = await staff.j('/api/memos', { method: 'POST', body: { text, source: 'voice' } })
  created.push(m)
  console.log(`  #${m.id} [${m.category}] ${m.title} | ${m.start_at || ''} outlook=${m.outlook_status} search=${m.search_status}`)
}
const adminMemos = await admin.j('/api/memos')
assert(!adminMemos._raw.some((m) => created.some((c) => c.id === m.id)), '管理者には一般ユーザーのメモが見えない')
assert((await admin.j(`/api/memos/${created[0].id}`)).status === 404, '他人のメモは 404')

for (let i = 0; i < 15; i++) {
  await sleep(2000)
  const list = (await staff.j('/api/memos?category=search'))._raw
  if (list.every((m) => m.search_status !== 'pending')) {
    for (const m of list) console.log(`  search #${m.id} ${m.search_status}: ${(m.search_summary || '').slice(0, 80).replace(/\n/g, ' ')}…`)
    assert(list.every((m) => m.search_status === 'done'), '検索完了')
    break
  }
}
const ev = await staff.j(`/api/memos/${created[0].id}`)
assert(ev.outlook_status === 'link' && ev.outlook_link?.includes('outlook.office.com'), 'Outlook リンク')
const ics = await fetch(`${BASE}/api/memos/${created[0].id}/ics`, { headers: { cookie: staff.cookie } })
assert(ics.status === 200 && (await ics.text()).includes('BEGIN:VEVENT'), '.ics')
assert((await fetch(`${BASE}/api/memos/${created[0].id}/ics`)).status === 401, '.ics は未ログイン不可')

// パスワード変更 → 旧パスワードで失敗
const pw = await staff.j('/api/auth/password', { method: 'POST', body: { current: 'staffpass1', next: 'staffpass2' } })
assert(pw.status === 200, 'パスワード変更')
assert((await client().j('/api/auth/login', { method: 'POST', body: { loginId: 'staff1', password: 'staffpass1' } })).status === 401, '旧パスワードは不可')
await admin.j(`/api/users/${users._raw.find((u) => u.login_id === 'staff1').id}`, { method: 'PATCH', body: { password: 'staffpass1' } })
assert((await staff.j('/api/auth/me')).status === 401, '管理者のPW再設定でセッション無効化')
const lo = await admin.j('/api/auth/logout', { method: 'POST' })
assert(lo.status === 200 && (await admin.j('/api/auth/me')).status === 401, 'ログアウト')
console.log(process.exitCode ? '\n== FAILED ==' : '\n== ALL OK ==')
