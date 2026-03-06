# LINE Secretary (Minimal)

このアプリは次のことを行います。

- バンクーバー時間の朝ウィンドウ `07:30-08:30` に `朝です` を1回だけ送信
- バンクーバー時間の夜ウィンドウ `21:30-22:30` に `夜です` を1回だけ送信
- LINE自由形式メッセージをLLMで判定し、当日タスクの保存・一覧取得・その他応答を返す
- Google Drive の `tasks/YYYY-MM-DD.md` に日次タスクを保存する

## 必須環境変数

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DEFAULT_USER_ID`
- `OPENAI_API_KEY`

任意:

- `TZ`（既定: `America/Vancouver`）
- `PORT`（既定: `8787`）
- `MORNING_PLAN_CRON`（既定: `0 8 * * *`）
- `NIGHT_REVIEW_CRON`（既定: `0 22 * * *`）
- `CRON_SECRET`（`/api/jobs/*` 保護用）
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_ACTION_MODEL`
- `OPENAI_TASK_MODEL`
- `GOOGLE_DRIVE_ENABLED` / `GOOGLE_DRIVE_FOLDER_ID` / `GOOGLE_DRIVE_STATE_FILE_NAME`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` / `GOOGLE_OAUTH_REDIRECT_URI`

## 起動

```bash
npm install
npm run dev
```

GitHub Actions から使う場合は `.github/workflows/secretary-cron.yml` が 15 分ごとに `/api/jobs/*` を叩き、
アプリ側でバンクーバー時間の送信 window 判定と Google Drive 上の重複防止を行います。

## エンドポイント

- `POST /webhook/line` LINE webhook
- `POST /api/jobs/morning` 朝通知ジョブ（ローカル時刻 `07:30-08:30` の window 内で1回のみ送信）
- `POST /api/jobs/night` 夜通知ジョブ（ローカル時刻 `21:30-22:30` の window 内で1回のみ送信）
- `GET /health` ヘルスチェック
