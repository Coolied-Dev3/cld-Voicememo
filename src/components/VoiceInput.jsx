import { useEffect, useRef, useState } from 'react'
import { useSpeech } from '../useSpeech'
import { CATS } from '../cats'

const AUTO_KEY = 'vm.autoSubmit'

export default function VoiceInput({ onSubmit, busy }) {
  const [text, setText] = useState('')
  const [cat, setCat] = useState('auto')
  const [autoSubmit, setAutoSubmit] = useState(() => { try { return localStorage.getItem(AUTO_KEY) !== '0' } catch { return true } })
  const taRef = useRef(null)
  const sourceRef = useRef('text')

  useEffect(() => { try { localStorage.setItem(AUTO_KEY, autoSubmit ? '1' : '0') } catch {} }, [autoSubmit])

  const inflight = useRef(false)
  const last = useRef({ text: '', at: 0 })
  const submit = async (t, source) => {
    const v = (t ?? text).trim()
    if (!v) return
    // 二重送信防止: 送信中、または同じ内容を 5 秒以内に送った場合は無視
    if (inflight.current) return
    if (last.current.text === v && Date.now() - last.current.at < 5000) return
    inflight.current = true
    try {
      const ok = await onSubmit(v, cat === 'auto' ? null : cat, source || sourceRef.current)
      if (ok) { last.current = { text: v, at: Date.now() }; setText(''); sourceRef.current = 'text' }
    } finally { inflight.current = false }
  }

  const speech = useSpeech({
    onInterim: (t) => { sourceRef.current = 'voice'; setText(t) },
    onFinal: (t) => {
      if (!t) return
      sourceRef.current = 'voice'
      setText(t)
      if (autoSubmit) submit(t, 'voice')
    },
  })

  const micClick = () => {
    if (speech.listening) { speech.stop(); return }
    if (speech.supported && speech.secure) speech.start()
    else {
      // フォールバック: キーボードのマイク（OS の音声入力）を使う
      taRef.current?.focus()
    }
  }

  const micHint = speech.listening ? '聞き取り中… タップで停止'
    : !speech.supported ? 'このブラウザは音声認識非対応。キーボードのマイクで音声入力してください'
    : !speech.secure ? 'HTTP 接続ではマイクが使えません。キーボードのマイクで音声入力するか、HTTPS で開いてください'
    : 'タップして話す'

  return (
    <section className="input-panel">
      <div className="chips" role="radiogroup" aria-label="カテゴリ">
        <button className={'chip' + (cat === 'auto' ? ' on' : '')} onClick={() => setCat('auto')}><i className="ti ti-sparkles" />自動判定</button>
        {CATS.map((c) => (
          <button key={c.key} className={'chip c-' + c.key + (cat === c.key ? ' on' : '')} onClick={() => setCat(c.key)}><i className={'ti ' + c.icon} />{c.label}</button>
        ))}
      </div>

      <div className={'mic-wrap' + (speech.listening ? ' live' : '')}>
        <button className="mic" onClick={micClick} aria-label="音声入力" disabled={busy}>
          <i className={'ti ' + (speech.listening ? 'ti-player-stop-filled' : 'ti-microphone')} />
        </button>
        <div className="mic-hint">{micHint}</div>
        {speech.error && <div className="mic-err">{speech.error}</div>}
      </div>

      <textarea
        ref={taRef}
        className="ta"
        rows={3}
        value={text}
        placeholder={'例）明日15時に山田さんと打ち合わせ／牛乳と卵を買う／インボイス制度について調べて／アイデア、〇〇'}
        onChange={(e) => { sourceRef.current = 'text'; setText(e.target.value) }}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit() }}
      />

      <div className="input-actions">
        <label className="switch">
          <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} />
          <span>話し終えたら自動登録</span>
        </label>
        <button className="btn-primary" onClick={() => submit()} disabled={busy || !text.trim()}>
          <i className="ti ti-send" /> 登録
        </button>
      </div>
      <div className="tips">
        文頭に「アイデア、」「やること、」「予定、」「買い物、」「調べて、」と付けると確実に振り分けられます
      </div>
    </section>
  )
}
