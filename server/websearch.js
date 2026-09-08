// API キー不要の Web 検索（DuckDuckGo HTML ＋ Wikipedia 要約）
// 戻り値: { summary: string, sources: [{title,url,snippet}] }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function decodeEntities(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim()
}

function resolveDdgUrl(href) {
  try {
    const u = new URL(href.startsWith('//') ? 'https:' + href : href)
    const uddg = u.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : u.toString()
  } catch { return href }
}

async function fetchText(url, ms = 15000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.text()
}

export async function duckduckgo(query, limit = 6) {
  const html = await fetchText('https://html.duckduckgo.com/html/?kl=jp-jp&q=' + encodeURIComponent(query))
  const blocks = html.split(/<div class="result results_links/).slice(1)
  const out = []
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(div|span|td)>/)
    const url = resolveDdgUrl(a[1])
    if (/duckduckgo\.com\/y\.js/.test(url)) continue // 広告
    out.push({ title: decodeEntities(a[2]), url, snippet: sn ? decodeEntities(sn[1]) : '' })
    if (out.length >= limit) break
  }
  return out
}

export async function wikipediaSummary(query) {
  const api = 'https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=1&srsearch=' + encodeURIComponent(query)
  const j = JSON.parse(await fetchText(api))
  const hit = j?.query?.search?.[0]
  if (!hit) return null
  const sum = JSON.parse(await fetchText('https://ja.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.title)))
  if (!sum?.extract) return null
  return { title: sum.title, extract: sum.extract, url: sum.content_urls?.desktop?.page || `https://ja.wikipedia.org/wiki/${encodeURIComponent(hit.title)}` }
}

export async function webSearch(query) {
  const [ddg, wiki] = await Promise.allSettled([duckduckgo(query), wikipediaSummary(query)])
  const results = ddg.status === 'fulfilled' ? ddg.value : []
  const w = wiki.status === 'fulfilled' ? wiki.value : null
  if (!results.length && !w) {
    const err = ddg.status === 'rejected' ? ddg.reason?.message : '検索結果なし'
    throw new Error('検索に失敗しました: ' + err)
  }
  const lines = []
  if (w) lines.push(`【Wikipedia: ${w.title}】\n${w.extract.length > 400 ? w.extract.slice(0, 400) + '…' : w.extract}`)
  if (results.length) {
    lines.push('【主な検索結果】')
    results.slice(0, 5).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}${r.snippet ? '\n   ' + (r.snippet.length > 160 ? r.snippet.slice(0, 160) + '…' : r.snippet) : ''}`)
    })
  }
  const sources = []
  const seen = new Set()
  const key = (u) => { try { return decodeURIComponent(u).replace(/\/$/, '') } catch { return u } }
  for (const s of [w ? { title: `Wikipedia: ${w.title}`, url: w.url, snippet: '' } : null, ...results]) {
    if (!s || seen.has(key(s.url))) continue
    seen.add(key(s.url)); sources.push(s)
  }
  return { summary: lines.join('\n'), sources }
}
