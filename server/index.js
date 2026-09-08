import express from 'express'
import fs from 'fs'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { initDb, nowStr, MEMO_COLS, DRIVER } from './db.js' // db.js が server/.env を読み込む
import { classifyText, CATEGORIES } from './classify.js'
import { webSearch } from './websearch.js'
import { aiEnabled, aiClassify, aiSearch } from './ai.js'
import { OUTLOOK_MODE, outlookDeepLink, buildIcs, comCreate } from './outlook.js'
import {
  authMiddleware, requireAuth, requireAdmin, hashPassword, verifyPassword,
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  loginLimiter, loginFailed, loginSucceeded, seedAdmin, publicUser,
} from './auth.js'
import { passkeyRoutes } from './passkey.js'
import * as ms from './msgraph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 3002)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443)

const db = await initDb()
await seedAdmin(db)

const app = express()
app.set('trust proxy', true) // リバースプロキシ配下（X-Forwarded-*）を信頼
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use('/api', authMiddleware(db))

const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e)
  res.status(500).json({ error: e.message })
})

// ---------- ヘルパ ----------
function decorate(m) {
  if (!m) return m
  let sources = []
  try { sources = m.search_sources ? JSON.parse(m.search_sources) : [] } catch { sources = [] }
  return { ...m, search_sources: sources, outlook_link: OUTLOOK_MODE === 'off' ? null : outlookDeepLink(m) }
}
const getMemo = async (id, userId) => db.get('SELECT * FROM memos WHERE id=? AND user_id=?', [id, userId])

async function updateMemo(id, fields) {
  const keys = Object.keys(fields).filter((k) => MEMO_COLS.includes(k) && k !== 'user_id')
  if (!keys.length) return
  fields.updated_at = nowStr(); keys.push('updated_at')
  const uniq = [...new Set(keys)]
  await db.run(`UPDATE memos SET ${uniq.map((k) => `${k}=?`).join(',')} WHERE id=?`, [...uniq.map((k) => fields[k] ?? null), id])
}

// 分類（AI があれば AI、失敗時はルール）
async function classify(text) {
  if (aiEnabled) {
    try { return { ...(await aiClassify(text)), ai_used: 1 } } catch (e) { console.warn('[ai] 分類失敗→ルールにフォールバック:', e.message) }
  }
  return { ...classifyText(text), ai_used: 0 }
}

// バックグラウンド処理: Web検索 / Outlook 自動登録
const running = new Set()
async function processMemo(id) {
  if (running.has(id)) return
  running.add(id)
  try {
    const m = await db.get('SELECT * FROM memos WHERE id=?', [id])
    if (!m) return
    if (m.category === 'search' && m.search_status === 'pending') {
      const q = m.search_query || m.title || m.text
      try {
        const r = aiEnabled ? await aiSearch(q).catch(async (e) => { console.warn('[ai] 検索失敗→DuckDuckGoへ:', e.message); return webSearch(q) }) : await webSearch(q)
        await updateMemo(id, { search_summary: r.summary, search_sources: JSON.stringify(r.sources), search_status: 'done' })
      } catch (e) {
        await updateMemo(id, { search_summary: e.message, search_status: 'error' })
      }
    }
    if (['schedule', 'todo'].includes(m.category) && m.outlook_status === 'pending') {
      if (OUTLOOK_MODE === 'off') { await updateMemo(id, { outlook_status: 'none' }); return }
      // 1) Microsoft Graph（ユーザーが Microsoft 連携済みなら本人の Outlook / To Do に直接登録）
      if (ms.msEnabled && m.user_id && (await ms.isConnected(db, m.user_id))) {
        try {
          const r = m.category === 'todo' ? await ms.createTask(db, m.user_id, m) : await ms.createEvent(db, m.user_id, m)
          await updateMemo(id, { outlook_status: 'done', outlook_id: r.id, outlook_url: r.url, outlook_error: null })
          return
        } catch (e) {
          console.warn('[graph] 登録失敗:', e.message)
          await updateMemo(id, { outlook_status: 'error', outlook_error: e.message })
          return
        }
      }
      // 2) この PC の従来 Outlook（COM）
      if (OUTLOOK_MODE === 'com') {
        try {
          const entryId = await comCreate(m)
          await updateMemo(id, { outlook_status: 'done', outlook_id: entryId, outlook_error: null })
        } catch (e) {
          await updateMemo(id, { outlook_status: 'error', outlook_error: e.message })
        }
        return
      }
      // 3) リンク方式
      await updateMemo(id, { outlook_status: 'link' })
    }
  } finally { running.delete(id) }
}

function initialStatus(category) {
  return {
    search_status: category === 'search' ? 'pending' : 'none',
    outlook_status: ['schedule', 'todo'].includes(category) ? 'pending' : 'none',
  }
}

// ---------- 公開 API ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: DRIVER, ai: aiEnabled, outlook: OUTLOOK_MODE, ms: ms.msEnabled, time: nowStr(), host: os.hostname() })
})

// ---------- 認証 ----------
app.get('/api/auth/me', h(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' })
  const pk = await db.get('SELECT COUNT(*) AS c FROM passkeys WHERE user_id=?', [req.user.id])
  res.json({ user: publicUser(req.user), passkeys: Number(pk.c), ms: await ms.status(db, req.user.id) })
}))

app.post('/api/auth/login', h(async (req, res) => {
  const loginId = String(req.body.loginId || '').trim()
  const password = String(req.body.password || '')
  const key = `${req.ip}|${loginId}`
  if (!loginLimiter(key)) return res.status(429).json({ error: '失敗が続いたため 15 分間ロックされています' })
  const u = await db.get('SELECT * FROM users WHERE login_id=?', [loginId])
  if (!u || !verifyPassword(password, u.password_hash)) { loginFailed(key); return res.status(401).json({ error: 'ID またはパスワードが違います' }) }
  loginSucceeded(key)
  const token = await createSession(db, u.id, req.headers['user-agent'])
  setSessionCookie(req, res, token)
  res.json({ user: publicUser(u) })
}))

app.post('/api/auth/logout', h(async (req, res) => {
  await destroySession(db, req.sessionToken)
  clearSessionCookie(req, res)
  res.json({ ok: true })
}))

app.post('/api/auth/password', requireAuth, h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', [req.user.id])
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return res.status(400).json({ error: '現在のパスワードが違います' })
  const next = String(req.body.next || '')
  if (next.length < 8) return res.status(400).json({ error: '新しいパスワードは 8 文字以上にしてください' })
  await db.run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hashPassword(next), nowStr(), u.id])
  res.json({ ok: true })
}))

// パスキー（Face ID / Touch ID）
passkeyRoutes(app, db, h)

// ---------- Microsoft 連携 ----------
app.get('/api/ms/connect', h(async (req, res) => {
  if (!req.user) return res.redirect('/?ms=login')
  if (!ms.msEnabled) return res.status(400).send('MS_CLIENT_ID が設定されていません')
  res.redirect(ms.beginAuth(req, req.user.id))
}))
app.get('/api/ms/callback', h(async (req, res) => {
  const { code, state, error, error_description } = req.query
  if (error) return res.redirect('/?ms=error&msg=' + encodeURIComponent(error_description || error))
  try {
    const account = await ms.completeAuth(db, String(state), String(code))
    res.redirect('/?ms=ok&account=' + encodeURIComponent(account))
  } catch (e) {
    res.redirect('/?ms=error&msg=' + encodeURIComponent(e.message))
  }
}))
app.get('/api/ms/status', requireAuth, h(async (req, res) => res.json(await ms.status(db, req.user.id))))
app.post('/api/ms/disconnect', requireAuth, h(async (req, res) => { await ms.disconnect(db, req.user.id); res.json({ ok: true }) }))

// ---------- ユーザー管理（管理者）----------
app.get('/api/users', requireAuth, requireAdmin, h(async (_req, res) => {
  const rows = await db.all(`SELECT u.id,u.login_id,u.name,u.role,u.created_at,
      (SELECT COUNT(*) FROM passkeys p WHERE p.user_id=u.id) AS passkeys,
      (SELECT COUNT(*) FROM ms_tokens t WHERE t.user_id=u.id) AS ms,
      (SELECT COUNT(*) FROM memos m WHERE m.user_id=u.id) AS memos
     FROM users u ORDER BY u.id`)
  res.json(rows.map((r) => ({ ...r, passkeys: Number(r.passkeys), ms: Number(r.ms) > 0, memos: Number(r.memos) })))
}))
app.post('/api/users', requireAuth, requireAdmin, h(async (req, res) => {
  const loginId = String(req.body.login_id || '').trim()
  const name = String(req.body.name || '').trim()
  const password = String(req.body.password || '')
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(loginId)) return res.status(400).json({ error: 'ID は英数字 3〜64 文字で入力してください' })
  if (password.length < 8) return res.status(400).json({ error: 'パスワードは 8 文字以上にしてください' })
  if (await db.get('SELECT id FROM users WHERE login_id=?', [loginId])) return res.status(400).json({ error: 'この ID は既に使われています' })
  const now = nowStr()
  const { id } = await db.run('INSERT INTO users (login_id,name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)', [loginId, name || loginId, hashPassword(password), role, now, now])
  res.json({ id, login_id: loginId, name: name || loginId, role })
}))
app.patch('/api/users/:id', requireAuth, requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id)
  const u = await db.get('SELECT * FROM users WHERE id=?', [id])
  if (!u) return res.status(404).json({ error: 'not found' })
  const f = []
  const v = []
  if (typeof req.body.name === 'string') { f.push('name=?'); v.push(req.body.name.trim() || u.login_id) }
  if (req.body.role && req.body.role !== u.role) {
    if (u.id === req.user.id) return res.status(400).json({ error: '自分自身の権限は変更できません' })
    f.push('role=?'); v.push(req.body.role === 'admin' ? 'admin' : 'user')
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'パスワードは 8 文字以上にしてください' })
    f.push('password_hash=?'); v.push(hashPassword(req.body.password))
    await db.run('DELETE FROM sessions WHERE user_id=?', [id]) // 他端末のセッションを無効化
  }
  if (f.length) { f.push('updated_at=?'); v.push(nowStr()); await db.run(`UPDATE users SET ${f.join(',')} WHERE id=?`, [...v, id]) }
  res.json({ ok: true })
}))
app.delete('/api/users/:id', requireAuth, requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id)
  if (id === req.user.id) return res.status(400).json({ error: '自分自身は削除できません' })
  for (const t of ['sessions', 'passkeys', 'ms_tokens', 'memos']) await db.run(`DELETE FROM ${t} WHERE user_id=?`, [id])
  await db.run('DELETE FROM users WHERE id=?', [id])
  res.json({ ok: true })
}))

// ---------- メモ API（ログイン必須・本人のメモのみ）----------
app.use('/api/memos', requireAuth)
app.use('/api/classify', requireAuth)

app.get('/api/memos', h(async (req, res) => {
  const { category, status, q } = req.query
  const where = ['user_id=?'], params = [req.user.id]
  if (category && CATEGORIES.includes(category)) { where.push('category=?'); params.push(category) }
  if (status) { where.push('status=?'); params.push(status) }
  if (q) { where.push('(text LIKE ? OR title LIKE ? OR search_summary LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const rows = await db.all(`SELECT * FROM memos WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`, params)
  res.json(rows.map(decorate))
}))

app.get('/api/memos/:id', h(async (req, res) => {
  const m = await getMemo(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  res.json(decorate(m))
}))

app.post('/api/classify', h(async (req, res) => {
  const text = String(req.body.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text が空です' })
  res.json(await classify(text))
}))

app.post('/api/memos', h(async (req, res) => {
  const text = String(req.body.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text が空です' })
  const forced = CATEGORIES.includes(req.body.category) ? req.body.category : null
  // 二重登録防止: 同じユーザーが同じ内容を 15 秒以内に送ってきたら既存のメモを返す
  const dup = await db.get('SELECT * FROM memos WHERE user_id=? AND text=? AND created_at>=? ORDER BY id DESC LIMIT 1',
    [req.user.id, text, nowStr(new Date(Date.now() - 15000))])
  if (dup) return res.json(decorate(dup))
  let c = await classify(text)
  if (forced && forced !== c.category) {
    const rule = classifyText(text)
    c = { ...c, category: forced }
    if (forced === 'search') { c.search_query = c.search_query || rule.search_query || text; c.title = c.search_query }
    else {
      c.title = rule.title
      if (forced === 'todo' && !c.due_at) c.due_at = c.start_at || rule.start_at || null
      if (forced === 'schedule' && !c.start_at) { c.start_at = c.due_at || rule.start_at; c.end_at = rule.end_at; c.all_day = rule.all_day }
    }
  }
  const now = nowStr()
  const row = {
    user_id: req.user.id,
    text, category: c.category, title: c.title || text.slice(0, 40), status: 'open',
    start_at: c.start_at, end_at: c.end_at, all_day: c.all_day ? 1 : 0, due_at: c.due_at,
    search_query: c.search_query, search_summary: null, search_sources: null,
    ...initialStatus(c.category),
    outlook_id: null, outlook_url: null, outlook_error: null,
    source: req.body.source === 'voice' ? 'voice' : 'text', ai_used: c.ai_used ? 1 : 0,
    created_at: now, updated_at: now,
  }
  const { id } = await db.run(`INSERT INTO memos (${MEMO_COLS.join(',')}) VALUES (${MEMO_COLS.map(() => '?').join(',')})`, MEMO_COLS.map((k) => row[k] ?? null))
  res.json(decorate(await getMemo(id, req.user.id)))
  setImmediate(() => processMemo(id).catch(console.error))
}))

app.patch('/api/memos/:id', h(async (req, res) => {
  const id = Number(req.params.id)
  const m = await getMemo(id, req.user.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  const b = req.body || {}
  const f = {}
  for (const k of ['title', 'text', 'status', 'start_at', 'end_at', 'due_at', 'search_query']) if (k in b) f[k] = b[k]
  if ('all_day' in b) f.all_day = b.all_day ? 1 : 0
  let reprocess = false
  if (b.category && CATEGORIES.includes(b.category) && b.category !== m.category) {
    f.category = b.category
    const rule = classifyText(m.text)
    if (b.category === 'search') { f.search_query = f.search_query || m.search_query || rule.search_query || m.text; f.title = f.search_query }
    else if (!f.title) f.title = rule.category === b.category ? rule.title : (m.title || rule.title)
    if (b.category === 'schedule' && !m.start_at) { f.start_at = rule.start_at || m.due_at; f.end_at = rule.end_at; f.all_day = rule.all_day }
    if (b.category === 'todo' && !m.due_at) f.due_at = m.start_at || rule.start_at
    Object.assign(f, initialStatus(b.category))
    f.search_summary = null; f.search_sources = null; f.outlook_id = null; f.outlook_url = null; f.outlook_error = null
    reprocess = true
  }
  if (b.reprocess) { Object.assign(f, initialStatus(f.category || m.category)); reprocess = true }
  await updateMemo(id, f)
  res.json(decorate(await getMemo(id, req.user.id)))
  if (reprocess) setImmediate(() => processMemo(id).catch(console.error))
}))

app.delete('/api/memos/:id', h(async (req, res) => {
  const m = await getMemo(req.params.id, req.user.id)
  if (m) {
    // Microsoft 連携で作った予定 / To Do も一緒に削除（失敗しても続行）
    if (m.outlook_id && m.outlook_status === 'done' && ms.msEnabled && (await ms.isConnected(db, m.user_id))) {
      try { await ms.deleteItem(db, m.user_id, m) } catch (e) { console.warn('[graph] 削除失敗:', e.message) }
    }
    await db.run('DELETE FROM memos WHERE id=?', [m.id])
  }
  res.json({ ok: true })
}))

app.post('/api/memos/:id/process', h(async (req, res) => {
  const m = await getMemo(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  await updateMemo(m.id, { ...initialStatus(m.category), outlook_error: null })
  await processMemo(m.id)
  res.json(decorate(await getMemo(m.id, req.user.id)))
}))

app.post('/api/memos/:id/outlook', h(async (req, res) => {
  const m = await getMemo(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  await updateMemo(m.id, { outlook_status: 'pending', outlook_error: null })
  await processMemo(m.id)
  res.json(decorate(await getMemo(m.id, req.user.id)))
}))

app.get('/api/memos/:id/ics', h(async (req, res) => {
  const m = await getMemo(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="voicememo-${m.id}.ics"`)
  res.send(buildIcs(m))
}))

// ---------- フロント本番ビルド配信 ----------
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
} else {
  app.get('/', (_req, res) => res.type('text').send('cld-Voice Memo API は動作中です。画面は npm run build で dist を作るか、開発時は http://localhost:5173 を開いてください。'))
}

// 起動時に未処理のものを再開・期限切れセッションの掃除
const pending = await db.all(`SELECT id FROM memos WHERE search_status='pending' OR outlook_status='pending'`)
for (const p of pending) setImmediate(() => processMemo(p.id).catch(console.error))
await db.run('DELETE FROM sessions WHERE expires_at < ?', [nowStr()])

const lanIps = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`[voicememo] HTTP  http://localhost:${PORT}  ${lanIps.map((ip) => `http://${ip}:${PORT}`).join(' ')}`)
  console.log(`[voicememo] db=${DRIVER} ai=${aiEnabled ? 'on' : 'off'} outlook=${OUTLOOK_MODE} ms-graph=${ms.msEnabled ? 'on' : 'off'} rpId=${process.env.RP_ID || '(ホスト名から自動)'}`)
})
const keyFile = path.join(ROOT, 'certs', 'server.key'), crtFile = path.join(ROOT, 'certs', 'server.crt')
if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
  https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[voicememo] HTTPS https://localhost:${HTTPS_PORT}  ${lanIps.map((ip) => `https://${ip}:${HTTPS_PORT}`).join(' ')}`)
  })
} else {
  console.log('[voicememo] HTTPS 無効（npm run make-cert で証明書を作ると有効になります）')
}
