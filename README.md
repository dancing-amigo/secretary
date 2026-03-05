# LINE Secretary (Minimal)

このアプリは次の3つだけを行います。

- バンクーバー時間 08:00 に `朝です` を送信
- バンクーバー時間 22:00 に `夜です` を送信
- LINEテキストメッセージへの返信は常に `おけ`

## 必須環境変数

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DEFAULT_USER_ID`

任意:

- `TZ`（既定: `America/Vancouver`）
- `PORT`（既定: `8787`）
- `MORNING_PLAN_CRON`（既定: `0 8 * * *`）
- `NIGHT_REVIEW_CRON`（既定: `0 22 * * *`）
- `CRON_SECRET`（`/api/jobs/*` 保護用）

## 起動

```bash
npm install
npm run dev
```

## エンドポイント

- `POST /webhook/line` LINE webhook
- `POST /api/jobs/morning` 朝通知ジョブ（ローカル時刻08時のみ送信）
- `POST /api/jobs/night` 夜通知ジョブ（ローカル時刻22時のみ送信）
- `GET /health` ヘルスチェック
