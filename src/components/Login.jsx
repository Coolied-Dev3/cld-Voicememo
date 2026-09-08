import { useEffect, useState } from 'react'
import { startAuthentication, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser'
import * as api from '../api'

export default function Login({ onLogin }) {
  const [loginId, setLoginId] = useState(() => { try { return localStorage.getItem('vm.loginId') || '' } catch { return '' } })
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [canPasskey, setCanPasskey] = useState(false)

  useEffect(() => {
    if (!browserSupportsWebAuthn()) return
    platformAuthenticatorIsAvailable().then(setCanPasskey).catch(() => {})
  }, [])

  const submit = async (e) => {
    e?.preventDefault()
    setErr(''); setBusy(true)
    try {
      const r = await api.login(loginId.trim(), password)
      try { localStorage.setItem('vm.loginId', loginId.trim()) } catch {}
      onLogin(r.user)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const passkey = async () => {
    setErr(''); setBusy(true)
    try {
      const { challengeId, options } = await api.passkeyLoginOptions()
      const response = await startAuthentication({ optionsJSON: options })
      const r = await api.passkeyLoginVerify(challengeId, response)
      onLogin(r.user)
    } catch (e) {
      if (e?.name === 'NotAllowedError') setErr('Face ID / パスキーの認証がキャンセルされました')
      else setErr(e.message || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <div className="login-logo">
        <i className="ti ti-microphone" />
        <h2>cld-Voice Memo</h2>
        <p>話すだけで、アイデア・やること・予定・買い物・調べものを整理</p>
      </div>
      {canPasskey && (
        <button className="btn-passkey" onClick={passkey} disabled={busy}>
          <i className="ti ti-face-id" /> Face ID / Touch ID でログイン
        </button>
      )}
      <form onSubmit={submit} className="login-form">
        <div className="form-group">
          <label>ログイン ID</label>
          <input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoCapitalize="none" required />
        </div>
        <div className="form-group">
          <label>パスワード</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        <button className="btn-primary wide" type="submit" disabled={busy}>ログイン</button>
      </form>
      <p className="login-note">
        初回は ID/パスワードでログインし、設定から「Face ID を登録」すると次回から Face ID だけでログインできます。
        ID は管理者から受け取ってください。
      </p>
    </div>
  )
}
