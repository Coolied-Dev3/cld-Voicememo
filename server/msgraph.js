// Microsoft Graph 連携: 各ユーザーが一度 Microsoft アカウントでサインイン（OAuth 2.0 認可コード + PKCE）すると、
// 予定は Outlook 予定表に、やることは Microsoft To Do に自動登録する。
// 必要な設定: Entra ID にアプリ登録し MS_CLIENT_ID を server/.env に設定（README 参照）。
import crypto from 'crypto'
import { encrypt, decrypt } from './auth.js'
import { nowStr } from './db.js'
import { eventWindow, subjectOf } from './outlook.js'

const CLIENT_ID = process.env.MS_CLIENT_ID || ''
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || ''
const TENANT = process.env.MS_TENANT || 'organizations' // 会社テナントIDを入れると自社アカウント限定になる
const SCOPES = 'offline_access openid profile User.Read Calendars.ReadWrite Tasks.ReadWrite'
const TZ = 'Tokyo Standard Time'
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`
const GRAPH = 'https://graph.microsoft.com/v1.0'

export const msEnabled = !!CLIENT_ID

// 認可フローの一時状態（state → {userId, verifier, redirectUri}）
const pending = new Map()
const b64u = (buf) => Buffer.from(buf).toString('base64url')

export function redirectUriFor(req) {
  if (process.env.MS_REDIRECT_URI) return process.env.MS_REDIRECT_URI
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim()
  return `${proto}://${req.get('host')}/api/ms/callback`
}

export function beginAuth(req, userId) {
  const state = b64u(crypto.randomBytes(24))
  const verifier = b64u(crypto.randomBytes(48))
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest())
  const redirectUri = redirectUriFor(req)
  pending.set(state, { userId, verifier, redirectUri, exp: Date.now() + 10 * 60e3 })
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  })
  return `${AUTH_BASE}/authorize?${p}`
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params })
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET)
  const r = await fetch(`${AUTH_BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error_description || j.error || `token HTTP ${r.status}`)
  return j
}

// コールバック: code → refresh_token を保存
export async function completeAuth(db, state, code) {
  const p = pending.get(state)
  pending.delete(state)
  if (!p || p.exp < Date.now()) throw new Error('認可の有効期限が切れました。もう一度やり直してください')
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier, scope: SCOPES })
  if (!t.refresh_token) throw new Error('refresh_token が取得できませんでした（offline_access の許可が必要です）')
  let account = ''
  try {
    const me = await graphFetch(t.access_token, '/me')
    account = me.mail || me.userPrincipalName || me.displayName || ''
  } catch {}
  await db.run('DELETE FROM ms_tokens WHERE user_id=?', [p.userId])
  await db.run('INSERT INTO ms_tokens (user_id,account,refresh_token,scope,updated_at) VALUES (?,?,?,?,?)',
    [p.userId, account, encrypt(t.refresh_token), t.scope || SCOPES, nowStr()])
  cache.set(p.userId, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 })
  return account
}

export async function status(db, userId) {
  const row = await db.get('SELECT account, updated_at FROM ms_tokens WHERE user_id=?', [userId])
  return { enabled: msEnabled, connected: !!row, account: row?.account || null, since: row?.updated_at || null }
}
export async function disconnect(db, userId) {
  cache.delete(userId)
  await db.run('DELETE FROM ms_tokens WHERE user_id=?', [userId])
}
export async function isConnected(db, userId) {
  return !!(await db.get('SELECT user_id FROM ms_tokens WHERE user_id=?', [userId]))
}

// アクセストークン（メモリキャッシュ、期限切れなら refresh）
const cache = new Map()
async function accessToken(db, userId) {
  const c = cache.get(userId)
  if (c && c.exp > Date.now()) return c.token
  const row = await db.get('SELECT refresh_token FROM ms_tokens WHERE user_id=?', [userId])
  if (!row) throw new Error('Microsoft アカウントが連携されていません')
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token), scope: SCOPES })
  if (t.refresh_token) await db.run('UPDATE ms_tokens SET refresh_token=?, updated_at=? WHERE user_id=?', [encrypt(t.refresh_token), nowStr(), userId])
  cache.set(userId, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 })
  return t.access_token
}

async function graphFetch(token, path, opts = {}) {
  const r = await fetch(GRAPH + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.message || `Graph HTTP ${r.status}`)
  return j
}

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`

// 予定 → Outlook 予定表
export async function createEvent(db, userId, memo) {
  const token = await accessToken(db, userId)
  const { start, end, allDay } = eventWindow(memo)
  const ev = await graphFetch(token, '/me/events', {
    method: 'POST',
    body: {
      subject: subjectOf(memo),
      body: { contentType: 'text', content: `${memo.text}\n\n(cld-Voice Memo #${memo.id})` },
      start: { dateTime: iso(start), timeZone: TZ },
      end: { dateTime: iso(end), timeZone: TZ },
      isAllDay: allDay,
      isReminderOn: true,
      reminderMinutesBeforeStart: allDay ? 0 : 15,
    },
  })
  return { id: ev.id, url: ev.webLink || null }
}

async function defaultTaskList(token) {
  const lists = await graphFetch(token, '/me/todo/lists')
  const list = (lists.value || []).find((l) => l.wellknownListName === 'defaultList') || (lists.value || [])[0]
  if (!list) throw new Error('To Do のリストが見つかりません')
  return list
}

// メモ削除時に、作成した予定 / To Do を削除（COM の EntryID は対象外）
export async function deleteItem(db, userId, memo) {
  if (!memo.outlook_id || !/^[A-Za-z0-9_=-]{40,}$/.test(memo.outlook_id)) return false
  const token = await accessToken(db, userId)
  if (memo.category === 'todo') {
    const list = await defaultTaskList(token)
    await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(memo.outlook_id)}`, { method: 'DELETE' })
  } else {
    await graphFetch(token, `/me/events/${encodeURIComponent(memo.outlook_id)}`, { method: 'DELETE' })
  }
  return true
}

// To Do タスクの期限を設定（memo.due_at が無ければ登録日）
export async function setTaskDue(db, userId, memo) {
  if (memo.category !== 'todo' || !memo.outlook_id || !/^[A-Za-z0-9_=-]{40,}$/.test(memo.outlook_id)) return false
  const due = memo.due_at || (String(memo.created_at).slice(0, 10) + ' 00:00:00')
  const { start } = eventWindow({ ...memo, start_at: due, all_day: 0 })
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(memo.outlook_id)}`, {
    method: 'PATCH',
    body: {
      dueDateTime: { dateTime: iso(start), timeZone: TZ },
      isReminderOn: true,
      reminderDateTime: { dateTime: iso(new Date(start.getTime() + (/00:00:00$/.test(due) ? 9 * 3600e3 : -3600e3))), timeZone: TZ },
    },
  })
  return true
}

// 診断用: To Do タスクの現在の状態を取得
export async function getTask(db, userId, memo) {
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  const t = await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(memo.outlook_id)}`)
  return { list: list.displayName, id: t.id, title: t.title, status: t.status, due: t.dueDateTime?.dateTime || null, completed: t.completedDateTime?.dateTime || null, modified: t.lastModifiedDateTime }
}

// 診断用: 既定リストのタスク一覧（直近 50 件）
export async function listTasks(db, userId) {
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  const r = await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks?$top=50`)
  return r.value || []
}

// やることの完了 / 未完了を To Do 側にも反映
export async function setTaskCompleted(db, userId, memo, done) {
  if (memo.category !== 'todo' || !memo.outlook_id || !/^[A-Za-z0-9_=-]{40,}$/.test(memo.outlook_id)) return false
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(memo.outlook_id)}`, {
    method: 'PATCH',
    body: { status: done ? 'completed' : 'notStarted' },
  })
  return true
}

// やること → Microsoft To Do（既定のリスト）。期限があれば dueDateTime を設定
export async function createTask(db, userId, memo) {
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  const body = {
    title: (memo.title || memo.text).slice(0, 255),
    body: { contentType: 'text', content: `${memo.text}\n\n(cld-Voice Memo #${memo.id})` },
  }
  if (memo.due_at) {
    const { start } = eventWindow({ ...memo, start_at: memo.due_at })
    body.dueDateTime = { dateTime: iso(start), timeZone: TZ }
    body.isReminderOn = true
    body.reminderDateTime = { dateTime: iso(new Date(start.getTime() - (/00:00:00$/.test(memo.due_at) ? -9 * 3600e3 : 3600e3))), timeZone: TZ }
  }
  const t = await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`, { method: 'POST', body })
  return { id: t.id, url: 'https://to-do.office.com/tasks/' }
}
