// ルールベース分類＋日本語日時パーサ（Claude API 未設定でも動く既定の分類器）
// 出力: { category, title, start_at, end_at, all_day, due_at, search_query }
//   category: idea | todo | schedule | shopping | search

export const CATEGORIES = ['idea', 'todo', 'schedule', 'shopping', 'search']

const pad = (n) => String(n).padStart(2, '0')
export const fmtDT = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`

// 全角数字→半角、漢数字（一〜三十一程度）→算用数字
function normalizeNumbers(s) {
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/[：]/g, ':').replace(/[〜～]/g, '~')
  const K = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  // 「二十三」「十五」「三」など（日付・時刻の直前で使われるものだけ変換）
  s = s.replace(/([一二三四五六七八九]?)十([一二三四五六七八九]?)(?=[月日時分曜週])/g, (_, a, b) => String((a ? K[a] : 1) * 10 + (b ? K[b] : 0)))
  s = s.replace(/([一二三四五六七八九〇零])(?=[月日時分週])/g, (_, a) => String(K[a]))
  return s
}

const WEEK = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 }

// 日時抽出。戻り値 { start:Date|null, end:Date|null, allDay, hasDate, hasTime, deadline, tokens:[] }
export function parseJapaneseDateTime(input, now = new Date()) {
  const s = normalizeNumbers(input)
  const tokens = []
  let base = null            // 日付（時刻なし）
  let hasDate = false
  let hasTime = false
  let deadline = /まで(に|には)?/.test(s)

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const setDate = (d, tok) => { base = d; hasDate = true; if (tok) tokens.push(tok) }

  let m
  // 年月日
  if ((m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/))) {
    setDate(new Date(+m[1], +m[2] - 1, +m[3]), m[0])
  } else if ((m = s.match(/(\d{1,2})月(\d{1,2})日/))) {
    let d = new Date(today.getFullYear(), +m[1] - 1, +m[2])
    if (d < today && (today - d) > 1000 * 60 * 60 * 24 * 60) d = new Date(today.getFullYear() + 1, +m[1] - 1, +m[2]) // 2か月以上前なら来年
    setDate(d, m[0])
  } else if ((m = s.match(/(\d{1,2})\/(\d{1,2})(?!\d)/))) {
    setDate(new Date(today.getFullYear(), +m[1] - 1, +m[2]), m[0])
  } else if ((m = s.match(/(?<![月\d])(\d{1,2})日(?![後間])/))) {
    // 「15日に」など（今月、過ぎていれば来月）
    let d = new Date(today.getFullYear(), today.getMonth(), +m[1])
    if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +m[1])
    setDate(d, m[0])
  }

  // 相対日
  if (!hasDate) {
    const rel = [
      [/明々後日|しあさって/, 3], [/明後日|あさって/, 2], [/明日|あした|あす/, 1],
      [/今日|本日|きょう/, 0], [/昨日|きのう/, -1],
    ]
    for (const [re, n] of rel) {
      if ((m = s.match(re))) { const d = new Date(today); d.setDate(d.getDate() + n); setDate(d, m[0]); break }
    }
  }
  if (!hasDate && (m = s.match(/(\d{1,2})日後/))) { const d = new Date(today); d.setDate(d.getDate() + +m[1]); setDate(d, m[0]) }
  if (!hasDate && (m = s.match(/(\d{1,2})週間後/))) { const d = new Date(today); d.setDate(d.getDate() + 7 * +m[1]); setDate(d, m[0]) }

  // 曜日（今週/来週/再来週）
  if (!hasDate && (m = s.match(/(今週|来週|再来週)?の?([日月火水木金土])曜日?/))) {
    const w = WEEK[m[2]]
    const d = new Date(today)
    const cur = d.getDay()
    if (m[1] === '来週' || m[1] === '再来週') {
      const toMon = ((1 - cur) + 7) % 7 || 7 // 次の月曜
      d.setDate(d.getDate() + toMon + (m[1] === '再来週' ? 7 : 0) + ((w + 6) % 7))
    } else if (m[1] === '今週') {
      d.setDate(d.getDate() - ((cur + 6) % 7) + ((w + 6) % 7))
    } else {
      d.setDate(d.getDate() + ((w - cur + 7) % 7))
    }
    setDate(d, m[0])
  } else if (!hasDate && (m = s.match(/来週/))) {
    const d = new Date(today); d.setDate(d.getDate() + (((1 - d.getDay()) + 7) % 7 || 7)); setDate(d, m[0])
  } else if (!hasDate && (m = s.match(/来月/))) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 1); setDate(d, m[0])
  }

  // 時刻（開始・終了）
  const times = []
  const timeRe = /(午前|午後|朝|昼|夕方|夜|晩)?\s*(?:(\d{1,2})(?::(\d{2})|時(半|(\d{1,2})分)?)|正午)/g
  let t
  while ((t = timeRe.exec(s))) {
    // 「3日」「9月」の数字を時刻と誤認しないよう、時 or : が無いものは除外
    if (!/時|:|正午/.test(t[0])) continue
    let h, mi = 0
    if (t[0].includes('正午')) { h = 12 } else {
      h = +t[2]
      if (t[3]) mi = +t[3]
      else if (t[4] === '半') mi = 30
      else if (t[5]) mi = +t[5]
    }
    const pre = t[1] || ''
    if ((pre === '午後' || pre === '夜' || pre === '晩' || pre === '夕方') && h < 12) h += 12
    if (pre === '昼' && h < 11) h += 12
    if (h > 23 || mi > 59) continue
    times.push({ h, mi, tok: t[0] })
  }
  if (times.length) { hasTime = true; tokens.push(...times.map((x) => x.tok)) }

  // 日付が無く時刻だけ → 今日
  if (!hasDate && hasTime) base = new Date(today)
  if (!base) return { start: null, end: null, allDay: false, hasDate, hasTime, deadline, tokens }

  let start, end = null
  if (hasTime) {
    start = new Date(base); start.setHours(times[0].h, times[0].mi, 0, 0)
    if (times[1] && /(から|~|-|〜)/.test(s)) {
      let eh = times[1].h
      if (eh < 12 && (eh < times[0].h || (eh === times[0].h && times[1].mi <= times[0].mi))) eh += 12 // 「2時から4時」の4時は16時
      end = new Date(base); end.setHours(eh, times[1].mi, 0, 0)
      if (end <= start) end = null
    }
    if (!end) {
      const dur = s.match(/(\d{1,2})時間/)
      end = new Date(start.getTime() + (dur ? +dur[1] : 1) * 60 * 60 * 1000)
    }
  } else {
    start = new Date(base)
  }
  return { start, end, allDay: !hasTime, hasDate, hasTime, deadline, tokens }
}

// 文頭の明示的なカテゴリ指定（「アイデア、〜」「買い物、〜」など）
const PREFIX = [
  [/^(アイデア|アイディア|案|企画)[、,:：\s]+/, 'idea'],
  [/^(やること|やるべきこと|タスク|todo|ToDo|TODO|作業)[、,:：\s]+/, 'todo'],
  [/^(予定|スケジュール|アポ)[、,:：\s]+/, 'schedule'],
  [/^(買い物|買うもの|買い物メモ|購入)[、,:：\s]+/, 'shopping'],
  [/^(調べて|調べる|調べ物|検索|リサーチ|質問)[、,:：\s]+/, 'search'],
]

const SEARCH_RE = /調べ|検索|ググ|って何|って なに|とは何|とは$|とは[?？]|とは。|教えて|知りたい|の意味|やり方|方法|違い|どうやって|何ですか|なんですか|ですか[?？]?$|ますか[?？]?$|でしょうか|どこ(です|に|で)|いくら|何時|何日|天気|相場|評判|口コミ|比較|おすすめ|(高さ|長さ|広さ|重さ|値段|価格|料金|人口|場所|住所|営業時間|電話番号|距離|由来|歴史|読み方|使い方|作り方|仕組み|原因|理由|特徴|メリット|デメリット)は?[?？]?$/
const SHOP_RE = /買|購入|買い物|注文|発注|スーパー|ドラッグストア|コンビニ|ホームセンター|切らし|ストック|補充/
const MEETING_RE = /会議|打ち合わせ|打合せ|打合わせ|ミーティング|MTG|面談|面接|商談|出張|訪問|来客|来訪|アポ|予約|飲み会|懇親会|食事会|ランチ|ディナー|セミナー|研修|発表|説明会|イベント|練習|試合|大会|通院|病院|歯医者|美容院|集合|出発|移動|参加|出席|予定/
const TODO_RE = /やる|する|しなきゃ|しないと|しなければ|やらなきゃ|やらないと|忘れず|忘れない|タスク|todo|やること|対応|送る|送付|提出|確認|連絡|依頼|準備|返信|返事|電話|申請|予約|手配|支払|振込|作成|作る|書く|まとめる|整理|片付け|掃除|洗濯|修理|更新|登録|設定|印刷|発送|受け取|取りに行く|持って行く|お願い|頼む|チェック/
const IDEA_STRONG_RE = /アイデア|アイディア|企画|ビジネス|新規事業|思いつ|どうだろう|どうか$|面白い|おもしろい|できそう|かもしれない|してみたい|したらどう|作れそう|売れそう|ニーズ|マネタイズ|コンセプト|というのは/
const IDEA_RE = /案|サービス|新規|事業|市場|収益|仕組み/

function stripDateTokens(text, tokens) {
  let t = normalizeNumbers(text)
  for (const tok of tokens) t = t.replace(tok, ' ')
  t = t.replace(/(^|\s)(の|に|は|で)?(から|まで(に|には)?|~)+(の|に|は|で)?/g, ' ')
  t = t.replace(/^\s*(から|まで(に|には)?|~)+/, '').replace(/\s+(から|まで(に|には)?)\s*$/, '')
  return t
    .replace(/(から|まで(に|には)?|に|の|は|で|、|,|\s)+$/g, '')
    .replace(/^(に|の|は|で|、|,|\s)+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[、,]\s*[、,]/g, '、')
    .trim()
}

function cleanTitle(text, category) {
  let t = text
  if (category === 'todo') {
    t = t.replace(/(を)?(やらなきゃ|やらないと(いけない|だめ)?|しなきゃ|しないと(いけない|だめ)?|しなければ(ならない|いけない)?|する必要がある|しておく|しておいて|してください|して欲しい|してほしい|すること|をやる|やる|忘れずに|忘れないように|お願い|こと)+[。.!！]?$/, '')
  } else if (category === 'shopping') {
    t = t.replace(/(を)?(買っておく|買っておいて|買わないと|買わなきゃ|買う|買って|買いたい|購入する|購入|注文する|注文|が切れた|を切らした|がない|が無い|補充)+[。.!！]?$/, '')
    t = t.replace(/^(スーパーで|コンビニで|ドラッグストアで|帰りに)/, '')
  } else if (category === 'schedule') {
    t = t.replace(/(が|の)?(あります|ある|入った|入れる|入れて|予定|です|があります)+[。.!！]?$/, '')
  } else if (category === 'idea') {
    t = t.replace(/(というアイデア|というアイディア|というのはどうだろう|はどうだろう|というのはどうか|を思いついた|思いついた)+[。.!！]?$/, '')
  }
  t = t.replace(/[。.!！]+$/, '').trim()
  if (!t) t = text.trim()
  return t.length > 60 ? t.slice(0, 60) + '…' : t
}

export function extractSearchQuery(text) {
  let q = normalizeNumbers(text)
  q = q.replace(/^(調べて|調べる|調べ物|検索|リサーチ|質問|ググって)[、,:：\s]+/, '')
  q = q.replace(/(について|に関して|のこと|の件)?(を)?(詳しく)?(調べて(ほしい|欲しい|おいて|みて|ください)?|調べる|調べたい|検索して(ほしい|欲しい|おいて|みて)?|検索|ググって|リサーチして|教えて(ほしい|欲しい|ください)?|知りたい|確認して)[。.!！?？]?$/, '')
  q = q.replace(/(って何(ですか)?|ってなに|とは何(ですか)?|とはなに|とは|って(どういう意味|何のこと)|の意味|は何(ですか)?|は何|なんですか|ですか|でしょうか|かな|だっけ)[。.!！?？]?$/, '')
  q = q.replace(/[。.!！?？]+$/, '').trim()
  q = q.replace(/(について|に関して|のこと|を|は|が|の)$/, '').trim()
  return q || text.trim()
}

export function classifyText(text, now = new Date()) {
  const raw = String(text || '').trim()
  let body = raw
  let category = null

  for (const [re, cat] of PREFIX) {
    const m = body.match(re)
    if (m) { category = cat; body = body.slice(m[0].length).trim(); break }
  }

  const dt = parseJapaneseDateTime(body, now)
  const hasDT = !!dt.start

  if (!category) {
    if (SEARCH_RE.test(body)) category = 'search'
    else if (SHOP_RE.test(body)) category = 'shopping'
    else if (hasDT) {
      if (dt.deadline && !MEETING_RE.test(body)) category = 'todo'
      else if (dt.hasTime || MEETING_RE.test(body)) category = 'schedule'
      else if (TODO_RE.test(body)) category = 'todo'
      else category = 'schedule'
    } else if (IDEA_STRONG_RE.test(body)) category = 'idea'
    else if (MEETING_RE.test(body) && !TODO_RE.test(body)) category = 'schedule'
    else if (TODO_RE.test(body)) category = 'todo'
    else if (IDEA_RE.test(body)) category = 'idea'
    else category = 'idea'
  }

  const res = { category, title: '', start_at: null, end_at: null, all_day: 0, due_at: null, search_query: null }
  const stripped = hasDT ? stripDateTokens(body, dt.tokens) : body

  if (category === 'schedule') {
    res.title = cleanTitle(stripped, 'schedule')
    if (hasDT) {
      res.start_at = fmtDT(dt.start)
      res.end_at = dt.end ? fmtDT(dt.end) : (dt.allDay ? null : fmtDT(new Date(dt.start.getTime() + 3600e3)))
      res.all_day = dt.allDay ? 1 : 0
    }
  } else if (category === 'todo') {
    res.title = cleanTitle(stripped, 'todo')
    if (hasDT) res.due_at = fmtDT(dt.start)
  } else if (category === 'search') {
    res.search_query = extractSearchQuery(body)
    res.title = res.search_query
  } else if (category === 'shopping') {
    res.title = cleanTitle(stripped, 'shopping')
  } else {
    res.title = cleanTitle(stripped, 'idea')
  }
  return res
}
