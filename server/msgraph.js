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
  const sync = row ? await db.get('SELECT last_sync_at, last_error FROM ms_sync WHERE user_id=?', [userId]) : null
  return { enabled: msEnabled, connected: !!row, account: row?.account || null, since: row?.updated_at || null, lastSync: sync?.last_sync_at || null, syncError: sync?.last_error || null }
}
export async function disconnect(db, userId) {
  cache.delete(userId)
  await db.run('DELETE FROM ms_tokens WHERE user_id=?', [userId])
  await db.run('DELETE FROM ms_sync WHERE user_id=?', [userId])
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
  const r = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(j.error?.message || `Graph HTTP ${r.status}`); e.status = r.status; e.code = j.error?.code; throw e }
  return j
}

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`

// Outlook / To Do に入れる本文: 原文＋備考＋管理用の注記。To Do から取り込んだものは備考＝To Do のメモ欄そのもの
function bodyOf(memo) {
  if (memo.source === 'todo') return memo.note || ''
  return [memo.text, memo.note].filter(Boolean).join('\n\n') + `\n\n(cld-Voice Memo #${memo.id})`
}

// 備考の変更を To Do / Outlook 予定の本文に反映
export async function setItemNote(db, userId, memo) {
  if (!memo.outlook_id || !/^[A-Za-z0-9_=-]{40,}$/.test(memo.outlook_id)) return false
  const token = await accessToken(db, userId)
  const body = { body: { contentType: 'text', content: bodyOf(memo) } }
  if (memo.category === 'todo') {
    const list = await defaultTaskList(token)
    await graphFetch(token, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(memo.outlook_id)}`, { method: 'PATCH', body })
  } else if (memo.category === 'schedule') {
    await graphFetch(token, `/me/events/${encodeURIComponent(memo.outlook_id)}`, { method: 'PATCH', body })
  } else return false
  return true
}

// 予定 → Outlook 予定表
export async function createEvent(db, userId, memo) {
  const token = await accessToken(db, userId)
  const { start, end, allDay } = eventWindow(memo)
  const ev = await graphFetch(token, '/me/events', {
    method: 'POST',
    body: {
      subject: subjectOf(memo),
      body: { contentType: 'text', content: bodyOf(memo) },
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

// ---------- To Do → 本システム の同期（差分取得） ----------
// Graph の dateTimeTimeZone → ローカル 'YYYY-MM-DD HH:MM:SS'
function fromGraphDT(dt) {
  if (!dt?.dateTime) return null
  const s = dt.dateTime.replace(/\.\d+$/, '')
  const d = dt.timeZone === 'UTC' || !dt.timeZone ? new Date(s + 'Z') : new Date(s) // それ以外は日本時間とみなす
  if (Number.isNaN(d.getTime())) return null
  return nowStr(d)
}
// 期限は日付だけを使う（終日）
const dueFromGraph = (dt) => { const s = fromGraphDT(dt); return s ? s.slice(0, 10) + ' 00:00:00' : null }

const graphBodyText = (body) => (body?.contentType === 'text' ? String(body.content || '') : String(body?.content || '').replace(/<[^>]+>/g, '')).trim()

// 1 ユーザー分の同期。戻り値 { added, updated, removed }
// 初回はデルタリンクが無いので全件を読み、未完了のものだけ取り込む。以降は変更分だけ。
export async function syncTasks(db, userId) {
  const token = await accessToken(db, userId)
  let st = await db.get('SELECT * FROM ms_sync WHERE user_id=?', [userId])
  if (!st) { await db.run('INSERT INTO ms_sync (user_id) VALUES (?)', [userId]); st = { user_id: userId } }
  let listId = st.list_id
  if (!listId) { listId = (await defaultTaskList(token)).id; await db.run('UPDATE ms_sync SET list_id=? WHERE user_id=?', [listId, userId]) }

  const initial = !st.delta_link
  let url = st.delta_link || `/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`
  const items = []
  let deltaLink = null
  // 初回は全件走査になるため 1 ページ 512 件（上限）で取得。最大 200 ページ（約 10 万件）まで
  for (let i = 0; i < 200 && url; i++) {
    let page
    try { page = await graphFetch(token, url, { headers: { Prefer: 'odata.maxpagesize=999' } }) } catch (e) {
      if (e.status === 410 || e.status === 404) { // デルタ期限切れ / リスト変更 → 初回からやり直し
        await db.run('UPDATE ms_sync SET delta_link=NULL, list_id=NULL WHERE user_id=?', [userId])
        throw new Error('差分リンクが無効になったため次回に全件再取得します')
      }
      throw e
    }
    items.push(...(page.value || []))
    url = page['@odata.nextLink'] || null
    if (page['@odata.deltaLink']) deltaLink = page['@odata.deltaLink']
  }

  const r = { added: 0, updated: 0, removed: 0 }
  for (const t of items) {
    const memo = await db.get('SELECT * FROM memos WHERE user_id=? AND outlook_id=?', [userId, t.id])
    if (t['@removed']) {
      if (memo) { await db.run('DELETE FROM memos WHERE id=?', [memo.id]); r.removed++ }
      continue
    }
    const done = t.status === 'completed'
    if (memo) {
      const f = {}
      if ((memo.status === 'done') !== done) f.status = done ? 'done' : 'open'
      if (t.title && t.title !== memo.title && memo.category === 'todo') f.title = t.title.slice(0, 255)
      const due = dueFromGraph(t.dueDateTime)
      if (memo.category === 'todo' && due && due !== memo.due_at) f.due_at = due
      // To Do 由来のタスクは、To Do のメモ欄を備考として取り込む
      if (memo.source === 'todo' && t.body) {
        const b = graphBodyText(t.body)
        if (!b.includes('cld-Voice Memo') && b !== (memo.note || '')) f.note = b.slice(0, 4000) || null
      }
      if (Object.keys(f).length) {
        f.updated_at = nowStr()
        await db.run(`UPDATE memos SET ${Object.keys(f).map((k) => k + '=?').join(',')} WHERE id=?`, [...Object.values(f), memo.id])
        r.updated++
      }
      continue
    }
    if (initial && done) continue // 初回は未完了のみ取り込む
    if (done && !memo) continue     // 取り込み前に完了したものは無視
    const title = String(t.title || '').trim().slice(0, 255)
    if (!title) continue
    const bodyText = graphBodyText(t.body)
    const text = title
    const note = bodyText && !bodyText.includes('cld-Voice Memo') ? bodyText.slice(0, 4000) : null
    const created = t.createdDateTime ? nowStr(new Date(t.createdDateTime)) : nowStr()
    const cols = ['user_id', 'text', 'category', 'title', 'status', 'due_at', 'all_day', 'search_status', 'outlook_status', 'outlook_id', 'outlook_url', 'note', 'source', 'ai_used', 'created_at', 'updated_at']
    const vals = [userId, text, 'todo', title, done ? 'done' : 'open', dueFromGraph(t.dueDateTime) || created.slice(0, 10) + ' 00:00:00', 0, 'none', 'done', t.id, 'https://to-do.office.com/tasks/', note, 'todo', 0, created, nowStr()]
    await db.run(`INSERT INTO memos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
    r.added++
  }
  if (!deltaLink && !st.delta_link) throw new Error('全件走査が上限に達しました（差分リンク未取得）')
  await db.run('UPDATE ms_sync SET delta_link=?, last_sync_at=?, last_error=NULL WHERE user_id=?', [deltaLink || st.delta_link || null, nowStr(), userId])
  return r
}

// 診断用: デルタ取得の各ページのキーと件数
export async function debugDelta(db, userId, { query = '', prefer = '', maxPages = 3 } = {}) {
  const token = await accessToken(db, userId)
  const list = await defaultTaskList(token)
  const out = []
  let url = `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/delta${query}`
  const t0 = Date.now()
  for (let i = 0; i < maxPages && url; i++) {
    let page
    try { page = await graphFetch(token, url, prefer ? { headers: { Prefer: prefer } } : {}) } catch (e) { out.push({ page: i, error: e.message }); break }
    out.push({ page: i, count: (page.value || []).length, next: !!page['@odata.nextLink'], delta: !!page['@odata.deltaLink'], ms: Date.now() - t0 })
    url = page['@odata.nextLink'] || null
  }
  return out
}

// 連携済み全ユーザーを同期（ポーラーから呼ぶ）
export async function syncAll(db, log = console) {
  const users = await db.all('SELECT user_id FROM ms_tokens')
  for (const { user_id } of users) {
    try {
      const r = await syncTasks(db, user_id)
      if (r.added || r.updated || r.removed) log.log(`[todo-sync] user=${user_id} 追加${r.added} 更新${r.updated} 削除${r.removed}`)
    } catch (e) {
      log.warn(`[todo-sync] user=${user_id} 失敗: ${e.message}`)
      await db.run('UPDATE ms_sync SET last_error=? WHERE user_id=?', [String(e.message).slice(0, 500), user_id]).catch(() => {})
    }
  }
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
    body: { contentType: 'text', content: bodyOf(memo) },
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
