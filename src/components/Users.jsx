import { useEffect, useState } from 'react'
import * as api from '../api'

// 管理者用: ユーザー管理（追加・パスワード再設定・権限・削除）
export default function Users({ me, onClose, toast }) {
  const [users, setUsers] = useState([])
  const [form, setForm] = useState({ login_id: '', name: '', password: '', role: 'user' })
  const [busy, setBusy] = useState(false)

  const load = async () => { try { setUsers(await api.listUsers()) } catch (e) { toast(e.message) } }
  useEffect(() => { load() }, [])

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    try { await api.createUser(form); setForm({ login_id: '', name: '', password: '', role: 'user' }); toast('ユーザーを追加しました'); load() } catch (e) { toast(e.message) } finally { setBusy(false) }
  }
  const resetPw = async (u) => {
    const p = prompt(`${u.name}（${u.login_id}）の新しいパスワード（8文字以上）`)
    if (!p) return
    try { await api.updateUser(u.id, { password: p }); toast('パスワードを再設定しました') } catch (e) { toast(e.message) }
  }
  const rename = async (u) => {
    const n = prompt('表示名', u.name)
    if (n == null) return
    try { await api.updateUser(u.id, { name: n }); load() } catch (e) { toast(e.message) }
  }
  const toggleRole = async (u) => {
    const role = u.role === 'admin' ? 'user' : 'admin'
    if (!confirm(`${u.name} を「${role === 'admin' ? '管理者' : '一般'}」にしますか？`)) return
    try { await api.updateUser(u.id, { role }); load() } catch (e) { toast(e.message) }
  }
  const del = async (u) => {
    if (!confirm(`${u.name}（${u.login_id}）を削除しますか？ メモ ${u.memos} 件も削除されます。`)) return
    try { await api.deleteUser(u.id); load(); toast('削除しました') } catch (e) { toast(e.message) }
  }

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div><b>ユーザー管理</b> <span className="muted">{users.length} 人</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><i className="ti ti-x" /></button>
        </div>

        <section className="sheet-sec">
          <h3><i className="ti ti-user-plus" /> 追加</h3>
          <form onSubmit={add} className="pw-form">
            <input placeholder="ログイン ID（英数字）" value={form.login_id} onChange={(e) => setForm({ ...form, login_id: e.target.value })} autoCapitalize="none" required />
            <input placeholder="表示名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="初期パスワード（8文字以上）" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} required />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">一般</option>
              <option value="admin">管理者</option>
            </select>
            <button className="btn-outline" type="submit" disabled={busy}>追加する</button>
          </form>
        </section>

        <section className="sheet-sec">
          <h3><i className="ti ti-users" /> 一覧</h3>
          {users.map((u) => (
            <div key={u.id} className="user-row">
              <div className="user-main">
                <b>{u.name}</b> <span className="muted small">@{u.login_id}</span>
                <div className="muted small">
                  {u.role === 'admin' ? '管理者' : '一般'} · メモ {u.memos} · Face ID {u.passkeys} · MS {u.ms ? '連携済' : '未'}
                </div>
              </div>
              <div className="user-actions">
                <button className="lnk" onClick={() => rename(u)}>名前</button>
                <button className="lnk" onClick={() => resetPw(u)}>PW再設定</button>
                {u.id !== me.id && <button className="lnk" onClick={() => toggleRole(u)}>{u.role === 'admin' ? '一般に' : '管理者に'}</button>}
                {u.id !== me.id && <button className="lnk danger" onClick={() => del(u)}>削除</button>}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
