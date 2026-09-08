// Outlook 連携
//  1) Outlook Web ディープリンク（スマホ/PC どちらでも 1 タップで予定作成画面が開く。設定不要・既定）
//  2) .ics ファイル（Outlook / 他カレンダーに取り込み）
//  3) COM 自動登録（OUTLOOK_MODE=com のとき。この PC の従来 Outlook にプロファイルが必要）
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const OUTLOOK_MODE = (process.env.OUTLOOK_MODE || 'link').toLowerCase() // link | com | off
const WEB_BASE = process.env.OUTLOOK_WEB_BASE || 'https://outlook.office.com' // 個人アカウントは https://outlook.live.com

const pad = (n) => String(n).padStart(2, '0')
function parseLocal(s) { // 'YYYY-MM-DD HH:MM:SS' → Date
  if (!s) return null
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
}
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
const icsLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`

// メモ → 予定の時間枠（todo は期限日の終日／期限なしは今日の終日）
export function eventWindow(memo) {
  let start = parseLocal(memo.start_at || memo.due_at)
  let allDay = !!memo.all_day
  if (memo.category === 'todo') allDay = !memo.due_at || /00:00:00$/.test(memo.due_at)
  if (!start) { const t = new Date(); start = new Date(t.getFullYear(), t.getMonth(), t.getDate()); allDay = true }
  let end = parseLocal(memo.end_at)
  if (allDay) { start = new Date(start.getFullYear(), start.getMonth(), start.getDate()); end = new Date(start); end.setDate(end.getDate() + 1) }
  else if (!end || end <= start) end = new Date(start.getTime() + 3600e3)
  return { start, end, allDay }
}

export function subjectOf(memo) {
  const prefix = memo.category === 'todo' ? '[TODO] ' : ''
  return prefix + (memo.title || memo.text).slice(0, 120)
}

export function outlookDeepLink(memo) {
  if (!['schedule', 'todo'].includes(memo.category)) return null
  const { start, end, allDay } = eventWindow(memo)
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: subjectOf(memo),
    startdt: isoLocal(start),
    enddt: isoLocal(end),
    allday: allDay ? 'true' : 'false',
    body: `${memo.text}\n\n(cld-Voice Memo #${memo.id})`,
  })
  return `${WEB_BASE}/calendar/deeplink/compose?${p.toString()}`
}

export function buildIcs(memo) {
  const { start, end, allDay } = eventWindow(memo)
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c)
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VoiceMemo//JP', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:voicememo-${memo.id}@local`,
    `DTSTAMP:${stamp}`,
    allDay ? `DTSTART;VALUE=DATE:${icsDate(start)}` : `DTSTART;TZID=Asia/Tokyo:${icsLocal(start)}`,
    allDay ? `DTEND;VALUE=DATE:${icsDate(end)}` : `DTEND;TZID=Asia/Tokyo:${icsLocal(end)}`,
    `SUMMARY:${esc(subjectOf(memo))}`,
    `DESCRIPTION:${esc(memo.text)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}

// COM 経由で従来 Outlook に登録（PowerShell スクリプトを起動）。戻り値: EntryID
export function comCreate(memo) {
  const { start, end, allDay } = eventWindow(memo)
  const script = path.join(__dirname, 'outlook-com.ps1')
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Kind', memo.category === 'todo' ? 'task' : 'appointment',
    '-Subject', subjectOf(memo),
    '-Body', `${memo.text}\n\n(cld-Voice Memo #${memo.id})`,
    '-Start', isoLocal(start), '-End', isoLocal(end),
    '-AllDay', allDay ? '1' : '0',
  ]
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', args, { windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => { ps.kill(); reject(new Error('Outlook COM がタイムアウトしました（Outlook のプロファイル未設定の可能性）')) }, 60000)
    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('close', (code) => {
      clearTimeout(timer)
      const m = out.match(/ENTRYID=(\S+)/)
      if (code === 0 && m) resolve(m[1])
      else reject(new Error((err || out || `exit ${code}`).trim().slice(0, 300)))
    })
  })
}
