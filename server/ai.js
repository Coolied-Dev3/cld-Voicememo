// Claude API 連携（任意）。server/.env に ANTHROPIC_API_KEY があるときだけ有効。
//  - aiClassify : 音声テキストの分類＋日時抽出（構造化出力）
//  - aiSearch   : Web 検索ツール付きで調べて日本語で要約
// 未設定時は classify.js（ルール）と websearch.js（DuckDuckGo/Wikipedia）にフォールバックする。
import { CATEGORIES } from './classify.js'

export const aiEnabled = !!process.env.ANTHROPIC_API_KEY
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5'

let _client = null
async function client() {
  if (!_client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    _client = new Anthropic()
  }
  return _client
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    title: { type: 'string', description: '一覧に表示する短い見出し（日本語、40文字以内）' },
    start_at: { type: ['string', 'null'], description: '予定の開始 "YYYY-MM-DD HH:MM:SS"（ローカル時刻）。予定以外や不明なら null' },
    end_at: { type: ['string', 'null'], description: '予定の終了。不明なら開始+1時間。終日なら null' },
    all_day: { type: 'boolean' },
    due_at: { type: ['string', 'null'], description: 'やるべきことの期限 "YYYY-MM-DD HH:MM:SS"。無ければ null' },
    search_query: { type: ['string', 'null'], description: 'category=search のときの検索クエリ' },
  },
  required: ['category', 'title', 'start_at', 'end_at', 'all_day', 'due_at', 'search_query'],
  additionalProperties: false,
}

const WEEKJA = ['日', '月', '火', '水', '木', '金', '土']

export async function aiClassify(text, now = new Date()) {
  const c = await client()
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${WEEKJA[now.getDay()]}曜日）`
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    system: [
      'あなたは音声メモの分類器です。ユーザーがスマホで話した短い日本語メモを、次の5種類に分類します。',
      '- idea: ビジネスアイデア・企画・思いつき',
      '- todo: やるべきこと（期限があれば due_at に入れる）',
      '- schedule: 日時が決まっている予定（start_at/end_at を必ず埋める。時刻が無ければ all_day=true）',
      '- shopping: 買い物メモ',
      '- search: Web で調べたいこと（search_query に検索しやすい短いクエリを入れる）',
      `現在日時: ${nowStr}。相対表現（明日・来週金曜・15時など）はこの日時を基準に絶対日時へ変換してください。`,
      '文頭に「アイデア、」「買い物、」「予定、」「やること、」「調べて、」のような指定があればそれを最優先します。',
    ].join('\n'),
    messages: [{ role: 'user', content: text }],
  })
  if (res.stop_reason === 'refusal') throw new Error('AI が分類を拒否しました')
  const t = res.content.find((b) => b.type === 'text')?.text
  if (!t) throw new Error('AI 応答が空です')
  const o = JSON.parse(t)
  return {
    category: CATEGORIES.includes(o.category) ? o.category : 'idea',
    title: o.title || text.slice(0, 40),
    start_at: o.start_at || null,
    end_at: o.end_at || null,
    all_day: o.all_day ? 1 : 0,
    due_at: o.due_at || null,
    search_query: o.search_query || null,
  }
}

export async function aiSearch(query) {
  const c = await client()
  const params = {
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'medium' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' } }],
    system: '与えられた調べものについて Web 検索し、日本語で要点を 5〜8 行にまとめてください。数字・日付・固有名詞は正確に。最後に参考にした情報源を挙げる必要はありません（別途表示します）。',
    messages: [{ role: 'user', content: query }],
  }
  const sources = []
  let text = ''
  for (let i = 0; i < 6; i++) {
    const res = await c.messages.create(params)
    for (const b of res.content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.type === 'web_search_result') sources.push({ title: r.title, url: r.url, snippet: '' })
      }
    }
    if (res.stop_reason === 'pause_turn') { params.messages.push({ role: 'assistant', content: res.content }); continue }
    if (res.stop_reason === 'refusal') throw new Error('AI が検索を拒否しました')
    text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    break
  }
  if (!text) throw new Error('AI 要約が空です')
  const seen = new Set()
  return { summary: text, sources: sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 8) }
}
