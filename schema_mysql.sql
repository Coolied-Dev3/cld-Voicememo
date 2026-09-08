-- Voice Memo  MySQL スキーマ（DB_DRIVER=mysql のとき。サーバー起動時にも自動作成される）
-- mysql -u root -p < schema_mysql.sql
CREATE DATABASE IF NOT EXISTS voicememo CHARACTER SET utf8mb4;
USE voicememo;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  login_id      VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,                       -- scrypt
  role          VARCHAR(16) NOT NULL DEFAULT 'user',         -- admin | user
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

CREATE TABLE IF NOT EXISTS passkeys (                        -- Face ID / Touch ID / Windows Hello（WebAuthn）
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

CREATE TABLE IF NOT EXISTS ms_tokens (                       -- Microsoft 365 連携（refresh_token は暗号化して保存）
  user_id       INT PRIMARY KEY,
  account       VARCHAR(255) NULL,
  refresh_token TEXT NOT NULL,
  scope         VARCHAR(512) NULL,
  updated_at    DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS memos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NULL,
  text            TEXT NOT NULL,                              -- 認識テキスト（原文）
  category        VARCHAR(16) NOT NULL DEFAULT 'idea',        -- idea | todo | schedule | shopping | search
  title           VARCHAR(255) NOT NULL DEFAULT '',           -- 見出し
  status          VARCHAR(16) NOT NULL DEFAULT 'open',        -- open | done
  start_at        DATETIME NULL,                              -- 予定 開始
  end_at          DATETIME NULL,                              -- 予定 終了
  all_day         TINYINT NOT NULL DEFAULT 0,
  due_at          DATETIME NULL,                              -- やること 期限
  search_query    VARCHAR(255) NULL,
  search_summary  MEDIUMTEXT NULL,
  search_sources  MEDIUMTEXT NULL,                            -- JSON [{title,url,snippet}]
  search_status   VARCHAR(16) NOT NULL DEFAULT 'none',        -- none | pending | done | error
  outlook_status  VARCHAR(16) NOT NULL DEFAULT 'none',        -- none | pending | link | done | error
  outlook_id      VARCHAR(255) NULL,                          -- Graph の予定/タスク ID または COM の EntryID
  outlook_url     TEXT NULL,                                  -- Outlook Web で開くリンク
  outlook_error   TEXT NULL,
  source          VARCHAR(16) NOT NULL DEFAULT 'text',        -- voice | text
  ai_used         TINYINT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  INDEX idx_memos_category (category),
  INDEX idx_memos_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
