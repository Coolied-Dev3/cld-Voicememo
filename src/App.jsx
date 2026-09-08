import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { CATS } from './cats'
import VoiceInput from './components/VoiceInput'
import MemoCard from './components/MemoCard'
import Login from './components/Login'
import Account from './components/Account'
import Users from './components/Users'

// ============ トースト ============
function useToast() {
  const [msg, setMsg] = useState('')
  const show = useCallback((m) => { setMsg(m); setTimeout(() => setMsg(''), 2800) }, [])
  const node = <div className={'tst' + (msg ? ' on' : '')}>{msg}</div>
  return [show, node]
}

// ============ テーマ ============
function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('theme', theme) } catch {}
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}

const TABS = [{ key: 'all', label: 'すべて', icon: 'ti-list' }, ...CATS]

export default function App() {
  const [session, setSession] = useState(undefined) // undefined=確認中, null=未ログイン, {user,...}
  const [memos, setMemos] = useState([])
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('vm.tab') || 'all' } catch { return 'all' } })
  const [showDone, setShowDone] = useState(false)
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState(null) // 'account' | 'users'
  const [toast, toastNode] = useToast()
  const [theme, toggleTheme] = useTheme()
  const timer = useRef(null)

  const handleErr = useCallback((e) => {
    if (e?.status === 401) { setSession(null); return true }
    return false
  }, [])

  const refreshSession = useCallback(async () => {
    try { setSession(await api.me()) } catch (e) { if (!handleErr(e)) console.error(e) }
  }, [handleErr])

  const load = useCallback(async () => {
    try { setMemos(await api.listMemos()) } catch (e) { if (!handleErr(e)) console.error(e) } finally { setLoading(false) }
  }, [handleErr])

  // 起動: 状態確認 → セッション確認 → Microsoft 連携の戻り値を表示
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }))
    refreshSession()
    const q = new URLSearchParams(location.search)
    if (q.get('ms')) {
      if (q.get('ms') === 'ok') toast(`Microsoft アカウント（${q.get('account') || ''}）と連携しました`)
      else if (q.get('ms') === 'error') toast('Microsoft 連携に失敗: ' + (q.get('msg') || ''))
      else if (q.get('ms') === 'login') toast('先にログインしてください')
      history.replaceState(null, '', location.pathname)
    }
  }, [refreshSession, toast])

  useEffect(() => {
    if (!session) return
    load()
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [session, load])

  // 処理中があれば 3 秒ごと、それ以外は 30 秒ごとに更新（別端末からの登録も反映）
  const autoOutlook = !!(session?.ms?.connected || health?.outlook === 'com')
  const pending = memos.some((m) => m.search_status === 'pending' || (m.outlook_status === 'pending' && autoOutlook))
  useEffect(() => {
    clearInterval(timer.current)
    if (!session) return
    timer.current = setInterval(load, pending ? 3000 : 30000)
    return () => clearInterval(timer.current)
  }, [pending, load, session])

  useEffect(() => { try { localStorage.setItem('vm.tab', tab) } catch {} }, [tab])

  const onSubmit = async (text, category, source) => {
    setBusy(true)
    try {
      const m = await api.createMemo(text, category, source)
      setMemos((list) => [m, ...list])
      const c = CATS.find((x) => x.key === m.category)
      toast(`「${c?.label}」に登録しました${m.category === 'search' ? '（検索中…）' : ''}`)
      return true
    } catch (e) { if (!handleErr(e)) toast('登録に失敗: ' + e.message); return false } finally { setBusy(false) }
  }

  const onChange = (m) => {
    setMemos((list) => (m._deleted ? list.filter((x) => x.id !== m.id) : list.map((x) => (x.id === m.id ? m : x))))
  }

  const logout = async () => {
    try { await api.logout() } catch {}
    setPanel(null); setMemos([]); setSession(null)
  }

  const counts = useMemo(() => {
    const c = { all: 0 }
    for (const m of memos) { if (m.status === 'done') continue; c.all++; c[m.category] = (c[m.category] || 0) + 1 }
    return c
  }, [memos])

  const shown = memos.filter((m) => (tab === 'all' || m.category === tab) && (showDone || m.status !== 'done'))

  if (session === undefined) return <div className="app"><div className="empty"><span className="spin" /> 確認中…</div></div>
  if (!session) return <div className="app"><Login onLogin={() => refreshSession()} />{toastNode}</div>

  const user = session.user
  return (
    <div className="app">
      <header className="header">
        <i className="ti ti-microphone logo" />
        <div className="h-title">
          <h1>cld-Voice Memo</h1>
          <div className="h-sub">
            {health ? (
              health.ok ? <>{user.name} · {health.ai ? 'AI分類' : 'ルール分類'} · Outlook: {session.ms?.connected ? '自動登録' : health.outlook === 'com' ? '自動登録(PC)' : health.outlook === 'off' ? 'なし' : 'リンク'}</> : <span className="err">サーバーに接続できません</span>
            ) : '接続確認中…'}
          </div>
        </div>
        {user.role === 'admin' && <button className="icon-btn" onClick={() => setPanel('users')} aria-label="ユーザー管理" title="ユーザー管理"><i className="ti ti-users" /></button>}
        <button className="icon-btn" onClick={() => setPanel('account')} aria-label="設定" title="設定"><i className="ti ti-user-circle" /></button>
        <button className="icon-btn" onClick={toggleTheme} aria-label="ライト/ダーク切替"><i className={'ti ' + (theme === 'dark' ? 'ti-sun' : 'ti-moon')} /></button>
      </header>

      <div className="layout">
        <div className="left">
          <VoiceInput onSubmit={onSubmit} busy={busy} />
        </div>

        <div className="right">
          <nav className="nav">
            {TABS.map((t) => (
              <button key={t.key} className={'nav-btn c-' + t.key + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
                <i className={'ti ' + t.icon} />
                <span>{t.label}</span>
                {counts[t.key] > 0 && <b className="cnt">{counts[t.key]}</b>}
              </button>
            ))}
          </nav>
          <div className="list-tools">
            <label className="switch"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /><span>完了済みも表示</span></label>
            <span className="muted">{shown.length} 件 <button className="lnk" onClick={load} aria-label="更新"><i className="ti ti-refresh" /></button></span>
          </div>
          <div className="list">
            {loading ? <div className="empty"><span className="spin" /> 読み込み中…</div>
              : shown.length === 0 ? <div className="empty"><i className="ti ti-microphone" /><div>まだメモがありません。マイクをタップして話してみてください。</div></div>
              : shown.map((m) => <MemoCard key={m.id} memo={m} onChange={onChange} outlookMode={health?.outlook || 'link'} autoOutlook={autoOutlook} toast={toast} />)}
          </div>
        </div>
      </div>

      {panel === 'account' && <Account user={user} health={health} onClose={() => { setPanel(null); refreshSession() }} onLogout={logout} toast={toast} />}
      {panel === 'users' && <Users me={user} onClose={() => setPanel(null)} toast={toast} />}
      {toastNode}
    </div>
  )
}
