// API クライアント。VITE_API_BASE が空なら同一オリジン（本番: Express が dist を配信）
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, j.error || `HTTP ${r.status}`)
  return j
}

export const health = () => req('/api/health')

// 認証
export const me = () => req('/api/auth/me')
export const login = (loginId, password) => req('/api/auth/login', { method: 'POST', body: { loginId, password } })
export const logout = () => req('/api/auth/logout', { method: 'POST' })
export const changePassword = (current, next) => req('/api/auth/password', { method: 'POST', body: { current, next } })

// パスキー（Face ID）
export const passkeyRegisterOptions = () => req('/api/passkey/register/options', { method: 'POST' })
export const passkeyRegisterVerify = (response, deviceName) => req('/api/passkey/register/verify', { method: 'POST', body: { response, deviceName } })
export const passkeyLoginOptions = () => req('/api/passkey/login/options', { method: 'POST' })
export const passkeyLoginVerify = (challengeId, response) => req('/api/passkey/login/verify', { method: 'POST', body: { challengeId, response } })
export const listPasskeys = () => req('/api/passkey')
export const deletePasskey = (id) => req(`/api/passkey/${id}`, { method: 'DELETE' })

// Microsoft 連携
export const msStatus = () => req('/api/ms/status')
export const msDisconnect = () => req('/api/ms/disconnect', { method: 'POST' })
export const msConnectUrl = () => `${BASE}/api/ms/connect`

// ユーザー管理（管理者）
export const listUsers = () => req('/api/users')
export const createUser = (u) => req('/api/users', { method: 'POST', body: u })
export const updateUser = (id, u) => req(`/api/users/${id}`, { method: 'PATCH', body: u })
export const deleteUser = (id) => req(`/api/users/${id}`, { method: 'DELETE' })

// メモ
export const listMemos = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
  return req('/api/memos' + (q ? '?' + q : ''))
}
export const createMemo = (text, category, source) => req('/api/memos', { method: 'POST', body: { text, category, source } })
export const updateMemo = (id, fields) => req(`/api/memos/${id}`, { method: 'PATCH', body: fields })
export const deleteMemo = (id) => req(`/api/memos/${id}`, { method: 'DELETE' })
export const reprocessMemo = (id) => req(`/api/memos/${id}/process`, { method: 'POST' })
export const outlookRegister = (id) => req(`/api/memos/${id}/outlook`, { method: 'POST' })
export const icsUrl = (id) => `${BASE}/api/memos/${id}/ics`
