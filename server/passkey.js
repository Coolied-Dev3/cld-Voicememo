// パスキー（WebAuthn）: iPhone の Face ID / Touch ID、Windows Hello などで ID・パスワードなしにログインする。
// 前提: HTTPS（または localhost）で開いていること。RP ID は公開 URL のホスト名（RP_ID で固定可）。
import crypto from 'crypto'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { nowStr } from './db.js'
import { createSession, setSessionCookie, publicUser, requireAuth, isSecure } from './auth.js'

const RP_NAME = process.env.RP_NAME || 'cld-Voice Memo'

function rpInfo(req) {
  const host = req.get('host') || 'localhost'
  const rpID = process.env.RP_ID || host.replace(/:\d+$/, '')
  const origin = process.env.ORIGIN || `${isSecure(req) ? 'https' : 'http'}://${host}`
  return { rpID, origin }
}

// 一時チャレンジ（5 分）
const challenges = new Map()
const putChallenge = (key, challenge) => challenges.set(key, { challenge, exp: Date.now() + 5 * 60e3 })
const takeChallenge = (key) => {
  const c = challenges.get(key)
  challenges.delete(key)
  return c && c.exp > Date.now() ? c.challenge : null
}

const rowToCredential = (p) => ({
  id: p.credential_id,
  publicKey: new Uint8Array(Buffer.from(p.public_key, 'base64url')),
  counter: Number(p.counter || 0),
  transports: p.transports ? JSON.parse(p.transports) : undefined,
})

export function passkeyRoutes(app, db, h) {
  // 登録（ログイン済みユーザーが自分の端末を登録）
  app.post('/api/passkey/register/options', requireAuth, h(async (req, res) => {
    const { rpID } = rpInfo(req)
    const existing = await db.all('SELECT credential_id, transports FROM passkeys WHERE user_id=?', [req.user.id])
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.user.login_id,
      userDisplayName: req.user.name || req.user.login_id,
      userID: new Uint8Array(Buffer.from(`voicememo-user-${req.user.id}`)),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    })
    putChallenge(`reg:${req.user.id}`, options.challenge)
    res.json(options)
  }))

  app.post('/api/passkey/register/verify', requireAuth, h(async (req, res) => {
    const { rpID, origin } = rpInfo(req)
    const expectedChallenge = takeChallenge(`reg:${req.user.id}`)
    if (!expectedChallenge) return res.status(400).json({ error: '登録の有効期限が切れました。もう一度お試しください' })
    let v
    try {
      v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false })
    } catch (e) { return res.status(400).json({ error: '検証に失敗: ' + e.message }) }
    if (!v.verified) return res.status(400).json({ error: 'パスキーの検証に失敗しました' })
    const c = v.registrationInfo.credential
    await db.run('INSERT INTO passkeys (user_id,credential_id,public_key,counter,transports,device_name,created_at) VALUES (?,?,?,?,?,?,?)', [
      req.user.id, c.id, Buffer.from(c.publicKey).toString('base64url'), c.counter || 0,
      c.transports ? JSON.stringify(c.transports) : null, String(req.body.deviceName || '').slice(0, 64) || null, nowStr(),
    ])
    res.json({ ok: true })
  }))

  app.get('/api/passkey', requireAuth, h(async (req, res) => {
    res.json(await db.all('SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE user_id=? ORDER BY id', [req.user.id]))
  }))
  app.delete('/api/passkey/:id', requireAuth, h(async (req, res) => {
    await db.run('DELETE FROM passkeys WHERE id=? AND user_id=?', [req.params.id, req.user.id])
    res.json({ ok: true })
  }))

  // ログイン（ID 入力なし。端末に保存されたパスキーから本人を特定）
  app.post('/api/passkey/login/options', h(async (req, res) => {
    const { rpID } = rpInfo(req)
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] })
    const challengeId = crypto.randomBytes(16).toString('base64url')
    putChallenge(`auth:${challengeId}`, options.challenge)
    res.json({ challengeId, options })
  }))

  app.post('/api/passkey/login/verify', h(async (req, res) => {
    const { rpID, origin } = rpInfo(req)
    const expectedChallenge = takeChallenge(`auth:${req.body.challengeId}`)
    if (!expectedChallenge) return res.status(400).json({ error: 'ログインの有効期限が切れました。もう一度お試しください' })
    const response = req.body.response
    const p = await db.get('SELECT * FROM passkeys WHERE credential_id=?', [response?.id])
    if (!p) return res.status(400).json({ error: 'このパスキーは登録されていません。ID/パスワードでログインして登録してください' })
    let v
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential: rowToCredential(p), requireUserVerification: false })
    } catch (e) { return res.status(400).json({ error: '検証に失敗: ' + e.message }) }
    if (!v.verified) return res.status(401).json({ error: 'パスキーの検証に失敗しました' })
    await db.run('UPDATE passkeys SET counter=?, last_used_at=? WHERE id=?', [v.authenticationInfo.newCounter, nowStr(), p.id])
    const user = await db.get('SELECT id,login_id,name,role FROM users WHERE id=?', [p.user_id])
    if (!user) return res.status(401).json({ error: 'ユーザーが存在しません' })
    const token = await createSession(db, user.id, req.headers['user-agent'])
    setSessionCookie(req, res, token)
    res.json({ user: publicUser(user) })
  }))
}
