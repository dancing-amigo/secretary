# LINE Secretary MVP

LINEだけで使えるAI秘書MVPです。以下を実装しています。

- 朝の自動プラン提案
- LINE返信でタスク追加/削除/計画確定
- 開始通知・終了確認・再通知
- 夜のレビュー通知
- LINE自然文で記憶の `remember/forget/tune/rollback`
- ファイルベースメモリ + 変更履歴
- Google Drive 永続化（state + memory 同期）

## 1. セットアップ

```bash
npm install
cp .env.example .env
```

`.env` の必須:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

推奨:

- `LINE_DEFAULT_USER_ID`
- `OPENAI_API_KEY`

## 2. 起動

```bash
npm run dev
```

- Health check: `GET /health`
- LINE webhook endpoint: `POST /webhook/line`
- Local test endpoint: `POST /internal/chat` with JSON `{ "userId": "U_demo", "text": "今日の計画" }`

## 3. LINEで使う自然文例

- `今日はあと寝る前にcpsc406の勉強をする`
- `今あるタスクを教えて`
- `今日何やるべき？`
- `このプランで確定`
- `終わった` / `まだ終わってない`
- `あと15分延長したい`
- `ミーティング直後は30分バッファを覚えておいて`
- `そのルールは忘れて`
- `前の変更を取り消して`

## 4. Google Drive 永続化（重要）

Vercelサーバレスで状態が消えないよう、Driveを永続ストアとして使えます。

### 4.1 認証方式

- `OAuthユーザー認証`（推奨）
- `Service Account`（Shared Drive向け）

### 4.2 OAuthユーザー認証（CLI）

1. Google Cloudで OAuth Client (Desktop app) を作成
2. 環境変数を設定してCLIを実行

```bash
export GOOGLE_OAUTH_CLIENT_ID="..."
export GOOGLE_OAUTH_CLIENT_SECRET="..."
node scripts/google-oauth-cli.js
```

3. 表示URLをブラウザで開いて許可
4. リダイレクト後URL（または code）をCLIに貼り付け
5. 出力された `refresh_token` を Vercel env に設定

必要なVercel env:

- `GOOGLE_DRIVE_ENABLED=true`
- `GOOGLE_DRIVE_FOLDER_ID=<your_folder_id>`
- `GOOGLE_OAUTH_CLIENT_ID=<...>`
- `GOOGLE_OAUTH_CLIENT_SECRET=<...>`
- `GOOGLE_OAUTH_REFRESH_TOKEN=<...>`
- `GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback`

### 4.3 Service Account方式（必要な場合）

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- Shared Drive上のフォルダを使うこと（My Driveだとquota制限が出る）

### 4.4 動作

- 各リクエスト開始時に Drive -> runtime へ pull
- 処理後に runtime -> Drive へ push
- `/internal/drive-status` で設定状態確認
- `/internal/drive-debug` で同期実体確認

## 5. データ保存場所

- 実行時キャッシュ: runtime `data/state.json`
- 長期記憶: runtime `memory/*`
- 永続実体: Google Drive の `secretary-state.json` / `secretary-memory.json`

## 6. スケジューラ

`.env` のcronで調整できます。

- `MORNING_PLAN_CRON`（既定 08:00）
- `NIGHT_REVIEW_CRON`（既定 22:00）
- `REMINDER_TICK_CRON`（既定 1分ごと）

## 7. 注意

- Vercel Hobbyでは高頻度Cronが使えないため、定期通知は外部cron（GitHub Actions/cron-job.org など）で `/internal/morning`, `/internal/night`, `/internal/reminder-tick` を叩く構成にしてください。
- Google CalendarはOAuthトークン管理を本番向けに強化してください。

## 8. 外部Cron（GitHub Actions）

Vercel Hobby制限のため、定期実行はGitHub Actionsで行います。

追加済みワークフロー:

- `.github/workflows/secretary-cron.yml`
  - 毎時: `/api/jobs/morning` と `/api/jobs/night`
  - 15分ごと: `/api/jobs/reminder-tick`

### 必要なGitHub Secrets

- `SECRETARY_BASE_URL` 例: `https://secretary-six.vercel.app`
- `SECRETARY_CRON_SECRET` 例: `long-random-string`

### 必要なVercel Environment Variable

- `CRON_SECRET` を `SECRETARY_CRON_SECRET` と同じ値に設定

これで外部からのジョブ呼び出しを認証付きで実行できます。

## 9. リマインダー送信時間

- リマインダー送信は `America/Vancouver` で **08:00〜21:59** のみ実行
- 22:00以降〜07:59の間に期限が来たリマインダージョブは `skipped (quiet_hours)` として送信しません
