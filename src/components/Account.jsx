import { useEffect, useState } from 'react'
import { startRegistration, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser'
import * as api from '../api'

// 設定パネル: Face ID 登録 / Microsoft 連携 / パスワード変更 / ログアウト
export default function Account({ user, health, onClose, onLogout, toast }) {
  const [passkeys, setPasskeys] = useState([])
  const [ms, setMs] = useState(null)
  const [canPasskey, setCanPasskey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '', next2: '' })

  const load = async () => {
    try { setPasskeys(await api.listPasskeys()) } catch {}
    try { setMs(await api.msStatus()) } catch {}
  }
  useEffect(() => {
    load()
    if (browserSupportsWebAuthn()) platformAuthenticatorIsAvailable().then(setCanPasskey).catch(() => {})
  }, [])

  const registerPasskey = async () => {
    setBusy(true)
    try {
      const options = await api.passkeyRegisterOptions()
      const response = await startRegistration({ optionsJSON: options })
      const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'PC'
      await api.passkeyRegisterVerify(response, name)
      toast('Face ID / パスキーを登録しました')
      load()
    } catch (e) {
      if (e?.name === 'InvalidStateError') toast('この端末のパスキーは登録済みです')
      else if (e?.name === 'NotAllowedError') toast('登録がキャンセルされました')
      else toast('登録に失敗: ' + (e.message || e))
    } finally { setBusy(false) }
  }
  const removePasskey = async (p) => {
    if (!confirm(`「${p.device_name || 'パスキー'}」を削除しますか？`)) return
    try { await api.deletePasskey(p.id); load() } catch (e) { toast(e.message) }
  }
  const disconnectMs = async () => {
    if (!confirm('Microsoft アカウントの連携を解除しますか？')) return
    try { await api.msDisconnect(); load(); toast('連携を解除しました') } catch (e) { toast(e.message) }
  }
  const changePw = async (e) => {
    e.preventDefault()
    if (pw.next !== pw.next2) return toast('新しいパスワードが一致しません')
    setBusy(true)
    try { await api.changePassword(pw.current, pw.next); setPw({ current: '', next: '', next2: '' }); toast('パスワードを変更しました') } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  const secure = window.isSecureContext

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div><b>{user.name}</b> <span className="muted">@{user.login_id}{user.role === 'admin' ? ' · 管理者' : ''}</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><i className="ti ti-x" /></button>
        </div>

        <section className="sheet-sec">
          <h3><i className="ti ti-face-id" /> Face ID / パスキー</h3>
          <p className="muted small">この端末の Face ID / Touch ID / Windows Hello で、ID・パスワードなしにログインできるようにします。</p>
          {passkeys.map((p) => (
            <div key={p.id} className="row">
              <span><i className="ti ti-device-mobile" /> {p.device_name || 'パスキー'} <span className="muted small">登録 {String(p.created_at).slice(0, 10)}{p.last_used_at ? ` · 最終 ${String(p.last_used_at).slice(0, 16)}` : ''}</span></span>
              <button className="lnk danger" onClick={() => removePasskey(p)}>削除</button>
            </div>
          ))}
          {!secure && <div className="err small">HTTPS で開いたときのみ登録できます（公開 URL からアクセスしてください）</div>}
          {secure && !canPasskey && <div className="muted small">この端末・ブラウザでは Face ID / パスキーが利用できません</div>}
          <button className="btn-outline" onClick={registerPasskey} disabled={busy || !secure || !canPasskey}><i className="ti ti-plus" /> この端末で Face ID を登録</button>
        </section>

        <section className="sheet-sec">
          <h3><i className="ti ti-brand-office" /> Microsoft 365（Outlook / To Do）連携</h3>
          {!health?.ms && <p className="muted small">サーバーに MS_CLIENT_ID が設定されていないため、予定は「Outlook に登録」リンクで登録します。</p>}
          {health?.ms && ms && (ms.connected ? (
            <>
              <p className="small"><i className="ti ti-circle-check ok" /> 連携中: <b>{ms.account}</b><br /><span className="muted">予定は Outlook 予定表に、やることは Microsoft To Do に自動登録されます。</span></p>
              <button className="btn-outline" onClick={disconnectMs}>連携を解除</button>
            </>
          ) : (
            <>
              <p className="muted small">連携すると、登録した予定・やることが自動であなたの Outlook / To Do に入ります。</p>
              <a className="btn-outlook" href={api.msConnectUrl()}><i className="ti ti-brand-windows" /> Microsoft アカウントで連携</a>
            </>
          ))}
        </section>

        <section className="sheet-sec">
          <h3><i className="ti ti-key" /> パスワード変更</h3>
          <form onSubmit={changePw} className="pw-form">
            <input type="password" placeholder="現在のパスワード" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required />
            <input type="password" placeholder="新しいパスワード（8文字以上）" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={8} required />
            <input type="password" placeholder="新しいパスワード（確認）" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} autoComplete="new-password" minLength={8} required />
            <button className="btn-outline" type="submit" disabled={busy}>変更する</button>
          </form>
        </section>

        <section className="sheet-sec">
          <button className="btn-outline danger" onClick={onLogout}><i className="ti ti-logout" /> ログアウト</button>
        </section>
      </div>
    </div>
  )
}
