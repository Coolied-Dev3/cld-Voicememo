import { useState } from 'react'
import { CATS, CAT_MAP } from '../cats'
import * as api from '../api'

const WEEK = ['日', '月', '火', '水', '木', '金', '土']
function fmtDT(s, allDay) {
  if (!s) return ''
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return s
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  const date = `${+m[2]}/${+m[3]}(${WEEK[d.getDay()]})`
  return allDay ? date : `${date} ${m[4]}:${m[5]}`
}
function fmtRange(m) {
  if (!m.start_at) return '日時未定'
  const a = fmtDT(m.start_at, m.all_day)
  if (m.all_day || !m.end_at) return a + (m.all_day ? '（終日）' : '')
  const e = String(m.end_at).match(/(\d{2}):(\d{2})/)
  return `${a} 〜 ${e ? e[1] + ':' + e[2] : ''}`
}
function fmtCreated(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return m ? `${+m[2]}/${+m[3]} ${m[4]}:${m[5]}` : ''
}

export default function MemoCard({ memo, onChange, outlookMode, autoOutlook, toast }) {
  const [open, setOpen] = useState(false)
  const [sumOpen, setSumOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [noteEdit, setNoteEdit] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const c = CAT_MAP[memo.category] || CAT_MAP.idea
  const done = memo.status === 'done'

  const run = async (fn, msg) => {
    setBusy(true)
    try { const r = await fn(); onChange(r); if (msg) toast(msg) } catch (e) { toast('エラー: ' + e.message) } finally { setBusy(false) }
  }
  const toggleDone = () => run(() => api.updateMemo(memo.id, { status: done ? 'open' : 'done' }))
  const changeCat = (e) => run(() => api.updateMemo(memo.id, { category: e.target.value }), 'カテゴリを変更しました')
  const del = () => { if (confirm('このメモを削除しますか？')) run(async () => { await api.deleteMemo(memo.id); return { ...memo, _deleted: true } }, '削除しました') }
  const editTitle = () => {
    const t = prompt('見出しを編集', memo.title || '')
    if (t != null && t.trim()) run(() => api.updateMemo(memo.id, { title: t.trim() }))
  }
  const reprocess = () => run(() => api.reprocessMemo(memo.id), '再実行しました')
  const outlookRegister = () => run(() => api.outlookRegister(memo.id))

  const isEvent = memo.category === 'schedule' || memo.category === 'todo'
  const longText = memo.text && memo.text !== memo.title

  return (
    <article className={'card c-' + memo.category + (done ? ' done' : '')}>
      <div className="card-head">
        <div className="card-main">
          <div className="card-title" onClick={editTitle} title="タップで見出し編集">{memo.title || memo.text}</div>
          {memo.category === 'schedule' && <div className="card-meta"><i className="ti ti-calendar-event" /> {fmtRange(memo)}</div>}
          {memo.category === 'todo' && (
            <div className="card-meta due-edit">
              <i className="ti ti-clock" /> 期限
              <input
                type="date"
                className="due-input"
                value={String(memo.due_at || '').slice(0, 10)}
                disabled={busy}
                aria-label="期限を変更"
                title="期限を変更（To Do にも反映）"
                onChange={(e) => { const v = e.target.value; if (v) run(() => api.updateMemo(memo.id, { due_at: v + ' 00:00:00' }), `期限を ${v.slice(5).replace('-', '/')} に変更しました`) }}
              />
              {memo.due_at && <span className="muted small">{fmtDT(memo.due_at, true).replace(/^[\d/]+/, '')}</span>}
            </div>
          )}
        </div>
        <div className="card-side">
          <select className={'badge c-' + memo.category} value={memo.category} onChange={changeCat} disabled={busy} aria-label="カテゴリ変更">
            {CATS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <button className={'btn-done' + (done ? ' on' : '')} onClick={toggleDone} disabled={busy} aria-label={done ? '未完了に戻す' : '完了'}>
            <i className={'ti ' + (done ? 'ti-arrow-back-up' : 'ti-check')} /> {done ? '戻す' : '完了'}
          </button>
        </div>
      </div>

      {longText && (
        <div className={'card-text' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>{memo.text}</div>
      )}

      {/* 備考（メモ） */}
      {noteEdit ? (
        <div className="note-box editing">
          <textarea className="ta note-ta" rows={3} value={noteDraft} autoFocus placeholder="備考（メモ登録）" onChange={(e) => setNoteDraft(e.target.value)} />
          <div className="note-actions">
            <button className="btn-ghost" onClick={() => setNoteEdit(false)} disabled={busy}>キャンセル</button>
            <button className="btn-note-save" disabled={busy} onClick={async () => { await run(() => api.updateMemo(memo.id, { note: noteDraft }), '備考を保存しました'); setNoteEdit(false) }}><i className="ti ti-check" /> 保存</button>
          </div>
        </div>
      ) : memo.note ? (
        <div className="note-box" onClick={() => { setNoteDraft(memo.note || ''); setNoteEdit(true) }} title="タップで備考を編集">
          <i className="ti ti-note" /><span className="note-text">{memo.note}</span>
        </div>
      ) : null}

      {memo.category === 'search' && (
        <div className="search-box">
          {memo.search_status === 'pending' && <div className="pending"><span className="spin" /> Web で検索中…</div>}
          {memo.search_status === 'error' && <div className="err">検索に失敗しました：{memo.search_summary} <button className="lnk" onClick={reprocess}>再試行</button></div>}
          {memo.search_status === 'done' && (
            <>
              <pre className={'summary' + (sumOpen ? ' open' : '')}>{memo.search_summary}</pre>
              {(memo.search_summary || '').length > 180 && (
                <button className="lnk" onClick={() => setSumOpen(!sumOpen)}><i className={'ti ' + (sumOpen ? 'ti-chevron-up' : 'ti-chevron-down')} /> {sumOpen ? '閉じる' : '続きを読む'}</button>
              )}
              {memo.search_sources?.length > 0 && (
                <div className="sources">
                  {memo.search_sources.slice(0, 6).map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"><i className="ti ti-external-link" />{s.title || s.url}</a>
                  ))}
                </div>
              )}
              <div className="row-end"><button className="lnk" onClick={reprocess}><i className="ti ti-refresh" /> もう一度検索</button></div>
            </>
          )}
        </div>
      )}

      {isEvent && outlookMode !== 'off' && (
        <div className="outlook-row">
          {memo.outlook_status === 'done' && (
            <span className="ok"><i className="ti ti-circle-check" /> {memo.category === 'todo' && memo.outlook_url ? 'To Do' : 'Outlook'} 登録済み
              {memo.outlook_url && <a href={memo.outlook_url} target="_blank" rel="noopener noreferrer" className="lnk">開く</a>}
            </span>
          )}
          {memo.outlook_status === 'pending' && autoOutlook && <span className="pending"><span className="spin" /> Outlook に登録中…</span>}
          {memo.outlook_status === 'error' && <span className="err" title={memo.outlook_error}><i className="ti ti-alert-circle" /> 自動登録に失敗（{(memo.outlook_error || '').slice(0, 60)}）</span>}
          {memo.outlook_status === 'done' && memo.outlook_error && <span className="err small" title={memo.outlook_error}><i className="ti ti-alert-circle" /> {memo.outlook_error.slice(0, 60)}</span>}
          {memo.outlook_status !== 'done' && memo.outlook_link && (
            <a className="btn-outlook" href={memo.outlook_link} target="_blank" rel="noopener noreferrer">
              <i className="ti ti-brand-office" /> Outlook に{memo.category === 'todo' ? '期限を' : ''}登録
            </a>
          )}
          <a className="btn-ghost" href={api.icsUrl(memo.id)}><i className="ti ti-download" /> .ics</a>
          {autoOutlook && memo.outlook_status !== 'done' && memo.outlook_status !== 'pending' && (
            <button className="btn-ghost" onClick={outlookRegister} disabled={busy}><i className="ti ti-refresh" /> 自動登録を再試行</button>
          )}
        </div>
      )}

      <div className="card-foot">
        <span className="ts" title={memo.source === 'todo' ? 'Microsoft To Do から取り込み' : memo.source === 'voice' ? '音声入力' : 'キーボード入力'}>
          <i className={'ti ' + (memo.source === 'todo' ? 'ti-checklist' : memo.source === 'voice' ? 'ti-microphone' : 'ti-keyboard')} /> {fmtCreated(memo.created_at)}{memo.source === 'todo' ? ' · To Do' : ''}{memo.ai_used ? ' · AI' : ''}
        </span>
        <span className="foot-actions">
          {!memo.note && !noteEdit && <button className="lnk" onClick={() => { setNoteDraft(''); setNoteEdit(true) }} disabled={busy}><i className="ti ti-note" /> <b>備考（メモ登録）</b></button>}
          <button className="lnk danger" onClick={del} disabled={busy}><i className="ti ti-trash" /> 削除</button>
        </span>
      </div>
    </article>
  )
}
