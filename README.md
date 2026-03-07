# LINE Secretary (Minimal)

このアプリは次のことを行います。

- バンクーバー時間の朝ウィンドウ `07:30-08:30` に `朝です` を1回だけ送信
- バンクーバー時間の夜ウィンドウ `21:30-22:30` に当日サマリーを1回だけ送信
- LINE自由形式メッセージをLLMで判定し、当日タスクの更新・一覧取得・その他応答を返す
- Google Drive の `tasks/YYYY-MM-DD.md` に日次タスクを保存する
- `modify_tasks` 後に Google Calendar へ順方向同期する
- `14:00〜18:00` のような時刻レンジがあるタスクは時間付きイベント、時刻なしタスクは終日イベントとして作る
- Google Drive の `conversations/YYYY-MM-DD.json` に日次会話履歴を保存する
- Google Drive 直下の `log.md` に夜サマリーを日次セクションで蓄積する

アクション判定は、ユーザー入力に加えて Google Drive 上の当日 `tasks/YYYY-MM-DD.md` を参照して行います。タスク更新系は `modify_tasks` に統一されています。追加、編集、削除、完了報告、detail 更新はすべて同じ更新経路で処理され、`modify_tasks` 用 LLM は現在の `tasks/YYYY-MM-DD.md` 全文とユーザー指示をもとに、更新後の Markdown 全文をそのまま返します。プログラム側はその Markdown を検証して Google Drive に書き込み、その後 Google Calendar の同一カレンダーへリコンシリエーションします。`detail` などから時刻レンジを抽出できたタスクは時間付きイベント、時刻なしタスクは終日イベントとして作成し、完了タスクはカレンダーから削除します。Google Calendar との対応関係と同期失敗ログは Google Drive 上の `task-sync-state.json` に保存され、`list_tasks` は保存済みの `title` / `status` のみを返します。

## 必須環境変数

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DEFAULT_USER_ID`
- `OPENAI_API_KEY`

任意:

- `APP_TIMEZONE`（既定: `America/Vancouver`。`TZ` は後方互換のフォールバックとしてのみ参照）
- `PORT`（既定: `8787`）
- `MORNING_PLAN_CRON`（既定: `0 8 * * *`。ローカル常駐起動時のみ使用）
- `NIGHT_REVIEW_CRON`（既定: `0 22 * * *`。ローカル常駐起動時のみ使用）
- `CRON_SECRET`（`/api/jobs/*` 保護用）
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_ACTION_MODEL`
- `OPENAI_TASK_MODEL`
- `OPENAI_SUMMARY_MODEL`
- `GOOGLE_DRIVE_ENABLED` / `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_DRIVE_NOTIFICATION_STATE_FILE_NAME`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` / `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_CALENDAR_ENABLED`（未指定時は `GOOGLE_DRIVE_ENABLED` を継承）
- `GOOGLE_CALENDAR_ID`（既定: `primary`）
- `GOOGLE_CALENDAR_EVENT_COLOR_ID`（既定: `1`）
- `GOOGLE_CALENDAR_SYNC_STATE_FILE_NAME`（既定: `task-sync-state.json`）

補足:

- Google Calendar イベント同期を使う場合、現在の refresh token に Calendar scope が含まれている必要があります

## 起動

```bash
npm install
npm run dev
```

GitHub Actions から使う場合は `.github/workflows/secretary-cron-morning.yml` と
`.github/workflows/secretary-cron-night.yml` が、PST 固定で朝 `07:35` / `08:05`、
夜 `21:35` / `22:05` に対応する UTC 時刻だけ `/api/jobs/*` を叩きます。
アプリ側では Google Drive 上の重複防止のみを行います。

## エンドポイント

- `POST /webhook/line` LINE webhook
- `POST /api/jobs/morning` 朝通知ジョブ（ローカル時刻 `07:30-08:30` の window 内で1回のみ送信）
- `POST /api/jobs/night` 夜サマリージョブ（ローカル時刻 `21:30-22:30` の window 内で1回のみ送信）
- `GET /health` ヘルスチェック
