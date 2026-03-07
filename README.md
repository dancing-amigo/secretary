# LINE Secretary (Minimal)

このアプリは次のことを行います。

- バンクーバー時間の朝ウィンドウ `07:30-08:30` に `朝です` を1回だけ送信
- バンクーバー時間の夜ウィンドウ `21:30-22:30` に当日サマリーを1回だけ送信
- LINE自由形式メッセージをLLMで判定し、当日予定の更新・一覧取得・その他応答を返す
- 各処理開始前に当日 Google Calendar event を読取同期し、手動追加・編集された予定も判断材料に含める
- アプリが作成・更新する event の description 先頭には `status` を書き込み、完了状態を保持する
- Google Drive の `conversations/YYYY-MM-DD.json` に日次会話履歴を保存する
- Google Drive 直下の `log.md` に夜サマリーを日次セクションで蓄積する

アクション判定は、ユーザー入力に加えて処理直前に Google Calendar から取得した当日予定一覧を参照して行います。`modify_events` は Google Calendar event 一覧そのものを更新し、`list_events` はその一覧を返します。追加、編集、削除、完了報告、detail 更新はすべて同じ更新経路で処理され、更新用 LLM は現在の当日予定一覧とユーザー指示をもとに、その日の最終 event 一覧を JSON で返します。プログラム側はその event 一覧を検証して Google Calendar に直接リコンシリエーションします。アプリが更新した event の description には `status: todo|done` を先頭に保存し、当日の全項目を単一の event モデルで扱います。Google Calendar の読取スナップショットと同期失敗ログは Google Drive 上の `task-sync-state.json` に保存され、夜サマリーも当日 Calendar event 一覧を元に生成します。

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
