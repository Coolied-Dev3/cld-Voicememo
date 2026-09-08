// 認証: ID/パスワード（scrypt ハッシュ）＋ Cookie セッション。管理者がユーザーを登録する社内利用向け。
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { nowStr } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const COOKIE = 'vm_sid'
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30)

// ---- 秘密鍵（トークン暗号化用）: SESSION_SECRET が無ければ data/secret.key に自動生成 ----
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  const f = path.resolve(__dirname, '..', 'data', 'secret.key')
  try { return fs.readFileSync(f, 'utf8').trim() } catch {}
  const s = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, s)
  return s
}
const SECRET = loadSecret()
const ENC_KEY = crypto.createHash('sha256').update(SECRET).digest()

export function encrypt(text) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv)
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.')
}
export function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.')
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8')
}

// ---- パスワード ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')
  return `scrypt$${salt}$${hash}`
}
export function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = String(stored).split('$')
    const a = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 })
    const b = Buffer.from(hash, 'base64url')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch { return false }
}

// ---- Cookie ----
export function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
export function isSecure(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
}
export function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`]
  if (isSecure(req)) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}
export function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecure(req)) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

// ---- セッション ----
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
export async function createSession(db, userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url')
  const exp = new Date(Date.now() + SESSION_DAYS * 86400e3)
  await db.run('INSERT INTO sessions (token_hash,user_id,user_agent,expires_at,created_at) VALUES (?,?,?,?,?)',
    [sha(token), userId, String(userAgent || '').slice(0, 255), nowStr(exp), nowStr()])
  return token
}
export async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash=?', [sha(token)])
}
export async function userFromToken(db, token) {
  if (!token) return null
  const s = await db.get('SELECT * FROM sessions WHERE token_hash=?', [sha(token)])
  if (!s) return null
  if (String(s.expires_at) < nowStr()) { await db.run('DELETE FROM sessions WHERE id=?', [s.id]); return null }
  return db.get('SELECT id,login_id,name,role,created_at FROM users WHERE id=?', [s.user_id])
}

// ---- ミドルウェア ----
export function authMiddleware(db) {
  return async (req, _res, next) => {
    try {
      req.sessionToken = parseCookies(req)[COOKIE] || null
      req.user = await userFromToken(db, req.sessionToken)
    } catch (e) { console.error(e); req.user = null }
    next()
  }
}
export const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'ログインが必要です' }))
export const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: '管理者のみ操作できます' }))

// ---- ログイン試行の制限（IP＋ID ごとに 10 回失敗で 15 分ロック）----
const attempts = new Map()
export function loginLimiter(key) {
  const a = attempts.get(key)
  if (a && a.count >= 10 && Date.now() - a.last < 15 * 60e3) return false
  return true
}
export function loginFailed(key) {
  const a = attempts.get(key) || { count: 0, last: 0 }
  if (Date.now() - a.last > 15 * 60e3) a.count = 0
  a.count++; a.last = Date.now()
  attempts.set(key, a)
}
export function loginSucceeded(key) { attempts.delete(key) }

// ---- 初期管理者（ユーザーが 1 人もいなければ作成）----
export async function seedAdmin(db) {
  const n = await db.get('SELECT COUNT(*) AS c FROM users')
  if (Number(n.c) > 0) return
  const loginId = process.env.ADMIN_LOGIN_ID || 'admin'
  const pw = process.env.ADMIN_PASSWORD || 'voicememo'
  const now = nowStr()
  await db.run('INSERT INTO users (login_id,name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [loginId, '管理者', hashPassword(pw), 'admin', now, now])
  console.log(`[auth] 初期管理者を作成しました: ${loginId} / ${pw}  ※ログイン後に必ずパスワードを変更してください`)
}

export const publicUser = (u) => (u ? { id: u.id, login_id: u.login_id, name: u.name, role: u.role } : null)
