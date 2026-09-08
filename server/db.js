// DB アダプタ
// DB_DRIVER=sqlite（既定・追加設定なしで動く）／ DB_DRIVER=mysql（陸上練習管理systemと同じ MySQL 運用）
// どちらも同じインタフェース { all, get, run } を返す。SQL は '?' プレースホルダで共通化する。
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

export const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase()

// memos テーブルの列（INSERT/UPDATE で使う）
export const MEMO_COLS = [
  'user_id', 'text', 'category', 'title', 'status',
  'start_at', 'end_at', 'all_day', 'due_at',
  'search_query', 'search_summary', 'search_sources', 'search_status',
  'outlook_status', 'outlook_id', 'outlook_url', 'outlook_error',
  'source', 'ai_used', 'created_at', 'updated_at',
]

// ---- スキーマ（SQLite / MySQL）----
const SCHEMA = {
  sqlite: `
CREATE TABLE IF NOT EXISTS memos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER,
  text            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'idea',
  title           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',
  start_at        TEXT,
  end_at          TEXT,
  all_day         INTEGER NOT NULL DEFAULT 0,
  due_at          TEXT,
  search_query    TEXT,
  search_summary  TEXT,
  search_sources  TEXT,
  search_status   TEXT NOT NULL DEFAULT 'none',
  outlook_status  TEXT NOT NULL DEFAULT 'none',
  outlook_id      TEXT,
  outlook_url     TEXT,
  outlook_error   TEXT,
  source          TEXT NOT NULL DEFAULT 'text',
  ai_used         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memos_category ON memos(category);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL,
  user_agent  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  device_name   TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE TABLE IF NOT EXISTS ms_tokens (
  user_id       INTEGER PRIMARY KEY,
  account       TEXT,
  refresh_token TEXT NOT NULL,
  scope         TEXT,
  updated_at    TEXT NOT NULL
);
`,
  mysql: `
CREATE TABLE IF NOT EXISTS memos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NULL,
  text            TEXT NOT NULL,
  category        VARCHAR(16) NOT NULL DEFAULT 'idea',
  title           VARCHAR(255) NOT NULL DEFAULT '',
  status          VARCHAR(16) NOT NULL DEFAULT 'open',
  start_at        DATETIME NULL,
  end_at          DATETIME NULL,
  all_day         TINYINT NOT NULL DEFAULT 0,
  due_at          DATETIME NULL,
  search_query    VARCHAR(255) NULL,
  search_summary  MEDIUMTEXT NULL,
  search_sources  MEDIUMTEXT NULL,
  search_status   VARCHAR(16) NOT NULL DEFAULT 'none',
  outlook_status  VARCHAR(16) NOT NULL DEFAULT 'none',
  outlook_id      VARCHAR(255) NULL,
  outlook_url     TEXT NULL,
  outlook_error   TEXT NULL,
  source          VARCHAR(16) NOT NULL DEFAULT 'text',
  ai_used         TINYINT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  INDEX idx_memos_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  login_id      VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at    DATETIME NOT NULL,
  updated_at    DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sessions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  user_id     INT NOT NULL,
  user_agent  VARCHAR(255) NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS passkeys (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  credential_id VARCHAR(512) NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       INT NOT NULL DEFAULT 0,
  transports    VARCHAR(255) NULL,
  device_name   VARCHAR(128) NULL,
  created_at    DATETIME NOT NULL,
  last_used_at  DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ms_tokens (
  user_id       INT PRIMARY KEY,
  account       VARCHAR(255) NULL,
  refresh_token TEXT NOT NULL,
  scope         VARCHAR(512) NULL,
  updated_at    DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`,
}

// 旧バージョンの memos テーブルに列を追加（存在チェックは SELECT の失敗で判定）
async function migrate(db) {
  const adds = [
    ['user_id', DRIVER === 'mysql' ? 'INT NULL' : 'INTEGER'],
    ['outlook_url', 'TEXT'],
  ]
  for (const [col, type] of adds) {
    try { await db.get(`SELECT ${col} FROM memos LIMIT 1`) } catch {
      await db.run(`ALTER TABLE memos ADD COLUMN ${col} ${type}`)
      console.log(`[db] memos.${col} を追加しました`)
    }
  }
  // user_id のインデックス（列追加後に作成。MySQL は IF NOT EXISTS 非対応なので重複エラーは無視）
  try { await db.run(DRIVER === 'mysql' ? 'CREATE INDEX idx_memos_user ON memos(user_id)' : 'CREATE INDEX IF NOT EXISTS idx_memos_user ON memos(user_id)') } catch {}
}

async function initSqlite() {
  const { DatabaseSync } = await import('node:sqlite')
  const dataDir = path.resolve(__dirname, '..', 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const file = process.env.SQLITE_FILE || path.join(dataDir, 'voicememo.db')
  const conn = new DatabaseSync(file)
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec(SCHEMA.sqlite)
  return {
    driver: 'sqlite',
    file,
    all: async (sql, params = []) => conn.prepare(sql).all(...params),
    get: async (sql, params = []) => conn.prepare(sql).get(...params) ?? null,
    run: async (sql, params = []) => {
      const r = conn.prepare(sql).run(...params)
      return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }
    },
    close: () => conn.close(),
  }
}

async function initMysql() {
  const mysql = (await import('mysql2/promise')).default
  const database = process.env.DB_NAME || 'voicememo'
  const base = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  }
  try {
    const c = await mysql.createConnection(base)
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`)
    await c.end()
  } catch (e) {
    console.warn('[db] CREATE DATABASE をスキップ:', e.message)
  }
  const pool = mysql.createPool({
    ...base, database,
    waitForConnections: true, connectionLimit: 10,
    dateStrings: true, multipleStatements: true,
  })
  await pool.query(SCHEMA.mysql)
  return {
    driver: 'mysql',
    all: async (sql, params = []) => (await pool.query(sql, params))[0],
    get: async (sql, params = []) => (await pool.query(sql, params))[0][0] ?? null,
    run: async (sql, params = []) => {
      const [r] = await pool.query(sql, params)
      return { id: r.insertId, changes: r.affectedRows }
    },
    close: () => pool.end(),
  }
}

export async function initDb() {
  const db = DRIVER === 'mysql' ? await initMysql() : await initSqlite()
  await migrate(db)
  console.log(`[db] driver=${db.driver}${db.file ? ' file=' + db.file : ''}`)
  return db
}

// 'YYYY-MM-DD HH:MM:SS'（ローカル時刻）
export function nowStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
