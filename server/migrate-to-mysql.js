// SQLite → MySQL データ移行
//   前提: server/.env の DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME に MySQL の接続情報が入っていること
//         （DB_DRIVER はまだ sqlite のままで良い。移行後に mysql へ切り替える）
//   node server/migrate-to-mysql.js          → 件数の確認と MySQL 接続テストのみ
//   node server/migrate-to-mysql.js --apply  → MySQL 側のテーブルを空にしてから全件コピー（id もそのまま）
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })
const apply = process.argv.includes('--apply')

// --- SQLite（元） ---
const { DatabaseSync } = await import('node:sqlite')
const sqliteFile = process.env.SQLITE_FILE || path.resolve(__dirname, '..', 'data', 'voicememo.db')
if (!fs.existsSync(sqliteFile)) { console.error('SQLite ファイルがありません:', sqliteFile); process.exit(1) }
const src = new DatabaseSync(sqliteFile)

// --- MySQL（先） ---  db.js の initMysql と同じ設定でスキーマを作る
process.env.DB_DRIVER = 'mysql'
const { initDb } = await import('./db.js')
let dst
try { dst = await initDb() } catch (e) { console.error('MySQL に接続できません:', e.message); process.exit(1) }

const TABLES = {
  users:     ['id', 'login_id', 'name', 'password_hash', 'role', 'created_at', 'updated_at'],
  sessions:  ['id', 'token_hash', 'user_id', 'user_agent', 'expires_at', 'created_at'],
  passkeys:  ['id', 'user_id', 'credential_id', 'public_key', 'counter', 'transports', 'device_name', 'created_at', 'last_used_at'],
  ms_tokens: ['user_id', 'account', 'refresh_token', 'scope', 'updated_at'],
  memos:     ['id', 'user_id', 'text', 'category', 'title', 'status', 'start_at', 'end_at', 'all_day', 'due_at',
              'search_query', 'search_summary', 'search_sources', 'search_status',
              'outlook_status', 'outlook_id', 'outlook_url', 'outlook_error', 'source', 'ai_used', 'created_at', 'updated_at'],
}

console.log(`SQLite: ${sqliteFile}`)
console.log(`MySQL : ${process.env.DB_USER || 'root'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'voicememo'}`)
let total = 0
for (const [t, cols] of Object.entries(TABLES)) {
  const rows = src.prepare(`SELECT ${cols.join(',')} FROM ${t}`).all()
  const cur = await dst.get(`SELECT COUNT(*) AS c FROM ${t}`)
  console.log(`${t.padEnd(10)} SQLite ${String(rows.length).padStart(4)} 件 → MySQL 現在 ${cur.c} 件`)
  total += rows.length
  if (!apply) continue
  await dst.run(`DELETE FROM ${t}`)
  for (const r of rows) {
    await dst.run(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => r[c] ?? null))
  }
  const after = await dst.get(`SELECT COUNT(*) AS c FROM ${t}`)
  console.log(`   → コピー完了 ${after.c} 件`)
}
if (apply) {
  console.log(`\n合計 ${total} 件を移行しました。server/.env の DB_DRIVER=mysql に変更してサーバーを再起動してください。`)
} else {
  console.log('\n接続 OK。--apply を付けると MySQL 側を空にして全件コピーします。')
}
await dst.close()
src.close()
