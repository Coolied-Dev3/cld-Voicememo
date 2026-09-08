import { useCallback, useEffect, useRef, useState } from 'react'

// Web Speech API（ブラウザ内蔵の音声認識）。Chrome / Edge / iOS Safari(14.5+) で動作。
// HTTPS（または localhost）でないとマイクが使えないため、非対応時はキーボードの音声入力にフォールバックする。
export function useSpeech({ lang = 'ja-JP', onInterim, onFinal } = {}) {
  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
  const supported = !!SR
  const secure = typeof window !== 'undefined' ? window.isSecureContext : false
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const recRef = useRef(null)
  const finalRef = useRef('')
  const cb = useRef({ onInterim, onFinal })
  useEffect(() => { cb.current = { onInterim, onFinal } }, [onInterim, onFinal])

  const start = useCallback(() => {
    if (!SR) return
    setError('')
    finalRef.current = ''
    const rec = new SR()
    rec.lang = lang
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onstart = () => setListening(true)
    rec.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript
        if (ev.results[i].isFinal) finalRef.current += t
        else interim += t
      }
      cb.current.onInterim?.(finalRef.current + interim)
    }
    rec.onerror = (ev) => {
      const map = { 'not-allowed': 'マイクの使用が許可されていません', 'no-speech': '音声が検出されませんでした', network: 'ネットワークエラー（音声認識サービスに接続できません）', 'audio-capture': 'マイクが見つかりません', 'service-not-allowed': 'このブラウザでは音声認識が許可されていません' }
      setError(map[ev.error] || `音声認識エラー: ${ev.error}`)
    }
    let ended = false // onend が 2 回呼ばれる端末があるため、1 回の認識につき 1 回だけ通知する
    rec.onend = () => {
      setListening(false)
      recRef.current = null
      if (ended) return
      ended = true
      cb.current.onFinal?.(finalRef.current.trim())
    }
    recRef.current = rec
    try { rec.start() } catch (e) { setError(String(e.message || e)); setListening(false) }
  }, [SR, lang])

  const stop = useCallback(() => { try { recRef.current?.stop() } catch {} }, [])

  useEffect(() => () => { try { recRef.current?.abort() } catch {} }, [])

  return { supported, secure, listening, error, start, stop }
}
