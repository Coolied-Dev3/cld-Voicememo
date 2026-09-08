# cld-Voice Memo ― 音声メモ自動振り分けシステム（社内スタッフ向け）

スマホで話すだけで、メモを **アイデア／やること／予定／買い物／調べもの** に自動振り分けし、
スマホ・PC のどちらからでも確認できる社内向けアプリです。
陸上練習管理システムと同じ構成（React + Vite／Node.js + Express／この PC 上で常駐）で、
**グローバル Web サーバーのリバースプロキシ → この PC の LAN IP:3002** の形で公開します。

```
[iPhone / PC ブラウザ]  ── 音声認識（ブラウザ内蔵 Web Speech API）／Face ID（パスキー）
        │ https://voicememo.example.com
        ▼
[グローバル Web サーバー: リバースプロキシ（TLS 終端）]
        │ http://192.168.220.48:3002
        ▼
[この PC: Express (:3002)]   ← server/
        ├─ 認証             : ID/パスワード（scrypt）＋Cookie セッション、パスキー（Face ID / Touch ID / Windows Hello）
        ├─ 分類・日時抽出   : ルール分類（既定） or Claude API（ANTHROPIC_API_KEY 設定時）
        ├─ Web 検索・要約   : DuckDuckGo + Wikipedia（既定） or Claude web_search（API キー設定時）
        ├─ Outlook 連携     : Microsoft Graph（各ユーザーが Microsoft 連携）→ 予定表 / To Do に自動登録
        │                     未連携時は Outlook Web 登録リンク / .ics（PC の従来 Outlook COM も選択可）
        └─ DB               : SQLite（既定・設定不要） or MySQL（DB_DRIVER=mysql）
```

## 機能

| 話した内容 | 分類 | 表示・連携 |
|---|---|---|
| 「〇〇というサービスはどうだろう」「アイデア、〇〇」 | アイデア | 一覧表示 |
| 「見積書を送る」「金曜までに週報を提出」 | やること | チェックで完了。Microsoft 連携済みなら To Do に自動登録 |
| 「明日15時に山田さんと打ち合わせ」 | 予定 | 日時を抽出。Microsoft 連携済みなら Outlook 予定表に自動登録。未連携なら **Outlook に登録** ボタン／.ics |
| 「牛乳と卵を買う」「買い物、シャンプー」 | 買い物 | チェックで完了 |
| 「インボイス制度について調べて」「RAGとは」 | 調べもの | サーバーが Web 検索し、要約＋参照リンクを表示 |

- メモは **ユーザーごとに分離** されます（他人のメモは見えません）。
- 文頭に **「アイデア、」「やること、」「予定、」「買い物、」「調べて、」** と付けると確実に振り分けられます。入力欄上のチップで手動指定も可能。登録後もカード右上のバッジで変更できます。
- 「話し終えたら自動登録」ON なら、マイク → 話す → 自動で登録、の 2 タップで完了します。

## ユーザーとログイン

- 初回起動時に管理者 `admin / voicememo`（`server/.env` の `ADMIN_LOGIN_ID` / `ADMIN_PASSWORD`）が作られます。**ログイン後、設定（右上の人型アイコン）からパスワードを変更してください。**
- 管理者は右上の「ユーザー管理」からスタッフを追加します（ID・表示名・初期パスワード・権限）。パスワード再設定・削除もここから。
- **Face ID でのログイン**：各スタッフは初回 ID/パスワードでログイン → 設定 →「この端末で Face ID を登録」。以後はログイン画面の「Face ID / Touch ID でログイン」だけで入れます（Web 標準のパスキー。HTTPS の公開 URL で開いていることが条件）。
- ログイン失敗が 10 回続くと 15 分ロック。セッションは 30 日（`SESSION_DAYS`）。
- 一般ユーザーは自分のメモのみ、管理者はユーザー管理ができます（管理者も他人のメモは見えません）。

## 必要なもの

- Node.js 18 以上（この PC は 24）
- （MySQL を使う場合のみ）MySQL 8.0

## セットアップ（この PC）

```bash
npm install
cd server && npm install && cd ..
copy server\.env.example server\.env    # 必要に応じて編集（既定のままで動作します）
npm run build                            # フロント本番ビルド（dist/）
npm run server                           # http://localhost:3002
```

開発時（ホットリロード）: `npm run dev:all` → http://localhost:5173

### 自動起動・LAN 公開（管理者 PowerShell で 1 回）

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

- ファイアウォール 3002/3443 を開放し、**PC 起動時（ログイン不要・SYSTEM 権限）** に自動起動するタスク `VoiceMemo` を登録します。
- `OUTLOOK_MODE=com`（この PC の従来 Outlook に COM 登録）を使う場合だけ `-AtLogon` を付けて実行し、ログオン時起動にします。
- 解除は `uninstall-autostart.ps1`、ソース更新後の反映は `update-prod.ps1`。

## リバースプロキシで公開する（サブドメイン直下）

グローバル Web サーバー側で `https://voicememo.example.com` → `http://192.168.220.48:3002` に転送します。
サーバーは `trust proxy` 有効なので `X-Forwarded-*` を付けてください（Cookie の Secure 判定、パスキーの origin 判定、Microsoft 連携のリダイレクト URI に使います）。

```nginx
server {
    listen 443 ssl;
    server_name voicememo.example.com;
    # ssl_certificate ...;  ssl_certificate_key ...;
    location / {
        proxy_pass http://192.168.220.48:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

`server/.env` に公開ドメインを固定しておくと確実です（未設定でも Host ヘッダから自動判定します）。

```
RP_ID=voicememo.example.com
ORIGIN=https://voicememo.example.com
```

- TLS はプロキシで終端するため、この PC 側の HTTPS(:3443) は不要です（LAN 内から直接使う場合のみ `npm run make-cert`）。
- スマホのマイクボタン（Web Speech API）とパスキーは HTTPS が必要なので、必ず公開 URL からアクセスしてください。
- iPhone では Safari で公開 URL を開き「ホーム画面に追加」するとアプリのように使えます。

## Microsoft 365 連携（Outlook 予定表 / To Do に自動登録）

各スタッフが「設定 → Microsoft アカウントで連携」を一度行うと、以後は予定が Outlook 予定表に、やることが Microsoft To Do に自動登録されます。
そのために **Entra ID（Azure AD）へのアプリ登録が 1 回だけ** 必要です（管理者権限が無くても、ユーザー同意が許可されているテナントなら登録できます）。

1. [Azure ポータル](https://portal.azure.com) → **Microsoft Entra ID → アプリの登録 → 新規登録**
   - 名前: `cld-Voice Memo`
   - サポートされているアカウントの種類: 「この組織ディレクトリのみ」または「任意の組織ディレクトリ」
   - リダイレクト URI: プラットフォーム **Web**、`https://voicememo.example.com/api/ms/callback`
2. 登録後の「概要」の **アプリケーション (クライアント) ID** を `server/.env` の `MS_CLIENT_ID` に設定
3. **認証** → 「パブリック クライアント フローを許可する」は不要。Web プラットフォームのままで OK
   - シークレットを使う場合: **証明書とシークレット** → 新しいクライアント シークレット → 値を `MS_CLIENT_SECRET` に設定（使わなければ空のままで PKCE で動作）
4. **API のアクセス許可** → Microsoft Graph → **委任されたアクセス許可** で次を追加
   - `User.Read`, `Calendars.ReadWrite`, `Tasks.ReadWrite`, `offline_access`
   - テナントの設定で必要なら「管理者の同意を与えます」
5. `MS_TENANT` に自社テナント ID（概要の「ディレクトリ (テナント) ID」）を入れると自社アカウント限定になります
6. サーバーを再起動 → 各スタッフが設定画面から「Microsoft アカウントで連携」

トークン（refresh_token）はサーバーの DB に暗号化して保存します（鍵は `SESSION_SECRET` または自動生成の `data/secret.key`）。連携解除は設定画面から。

### 未連携ユーザー向けの動作（`OUTLOOK_MODE`）

| モード | 動作 |
|---|---|
| `link`（既定） | 予定・やることのカードに **「Outlook に登録」** ボタン。Outlook Web の予定作成画面が件名・日時入りで開き、保存するだけ |
| `com` | この PC の従来 Outlook に COM で自動登録（従来 Outlook にプロファイル設定が必要。サーバーはログオンユーザーで起動） |
| `off` | 連携なし |

どのモードでも `.ics` をダウンロードできます。

## Claude API を使う（任意）

`server/.env` に `ANTHROPIC_API_KEY` を設定すると、分類・日時抽出が Claude（構造化出力）に、調べものが Claude の Web 検索ツールによる日本語要約になります。未設定でもルール分類と DuckDuckGo/Wikipedia で動作します。

## MySQL を使う（陸上練習管理システムと同じ運用にする場合）

```
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=（root パスワード）
DB_NAME=voicememo
```

起動時に DB とテーブルを自動作成します（手動なら `schema_mysql.sql`）。バックアップ: `mysqldump -u root -p voicememo > backup.sql`。
SQLite の場合は `data/voicememo.db` と `data/secret.key` をコピーしてください。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/health | 状態（db / ai / outlook / ms） |
| POST | /api/auth/login `{loginId,password}` | ログイン（Cookie） |
| POST | /api/auth/logout | ログアウト |
| GET | /api/auth/me | ログイン中ユーザー・パスキー数・Microsoft 連携状態 |
| POST | /api/auth/password `{current,next}` | パスワード変更 |
| POST | /api/passkey/register/options → /verify | パスキー登録（要ログイン） |
| POST | /api/passkey/login/options → /verify | パスキーでログイン |
| GET/DELETE | /api/passkey, /api/passkey/:id | 登録済みパスキー |
| GET | /api/ms/connect → /api/ms/callback | Microsoft 連携（OAuth） |
| GET/POST | /api/ms/status, /api/ms/disconnect | 連携状態・解除 |
| GET/POST/PATCH/DELETE | /api/users[/:id] | ユーザー管理（管理者） |
| GET | /api/memos?category=&status=&q= | 自分のメモ一覧 |
| POST | /api/memos `{text, category?, source?}` | 登録（category 省略で自動判定）。検索・Outlook 登録はバックグラウンド |
| PATCH | /api/memos/:id | 更新（category / status / title / 日時 …） |
| DELETE | /api/memos/:id | 削除 |
| POST | /api/memos/:id/process | 検索・Outlook 登録の再実行 |
| POST | /api/memos/:id/outlook | Outlook 登録の再試行 |
| GET | /api/memos/:id/ics | .ics ダウンロード |

動作確認: `node server/test-api.js --clean`（サーバー起動中に実行。ログイン・ユーザー分離・検索・Outlook リンクを検証）

## ファイル構成

```
server/
  index.js         Express ルート・バックグラウンド処理・dist 配信・HTTP/HTTPS 起動
  auth.js          パスワードハッシュ・Cookie セッション・ログイン制限・初期管理者
  passkey.js       パスキー（WebAuthn）登録・ログイン
  msgraph.js       Microsoft 365 連携（OAuth PKCE・予定表 / To Do 作成）
  db.js            SQLite / MySQL アダプタ（スキーマ自動作成・移行）
  classify.js      ルール分類＋日本語日時パーサ
  websearch.js     DuckDuckGo + Wikipedia 検索
  ai.js            Claude API（分類・Web 検索要約）※任意
  outlook.js       Outlook Web リンク / .ics / COM 呼び出し
  outlook-com.ps1  従来 Outlook に予定・タスクを作る PowerShell
  make-cert.js     自己署名証明書の作成（LAN 内 HTTPS 用）
  test-classify.js / test-api.js  動作確認
src/
  App.jsx          画面全体（ログイン判定・ヘッダ・タブ・一覧・ポーリング）
  components/Login.jsx       ログイン（ID/パスワード・Face ID）
  components/Account.jsx     設定（Face ID 登録・Microsoft 連携・パスワード変更・ログアウト）
  components/Users.jsx       ユーザー管理（管理者）
  components/VoiceInput.jsx  マイク・カテゴリチップ・入力欄
  components/MemoCard.jsx    メモカード（完了・カテゴリ変更・検索結果・Outlook）
  useSpeech.js / api.js / cats.js / styles.css
schema_mysql.sql   MySQL スキーマ
run-prod.cmd / install-autostart.ps1 / uninstall-autostart.ps1 / update-prod.ps1
```

## 注意

- 公開するときは必ず HTTPS（プロキシで TLS 終端）にしてください。HTTP のままだと Cookie・パスキー・マイクが正しく動きません。
- 初期管理者のパスワードは必ず変更してください。
- 音声認識の精度はブラウザ（Google / Apple の認識エンジン）に依存します。認識結果は登録前に入力欄で修正できます。
