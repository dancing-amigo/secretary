# LINE Secretary (Minimal)

このアプリは次のことを行います。

- バンクーバー時間の毎朝 `08:00` に、前日 `record/timeline/days/YYYY-MM-DD.md` の日次ログと当日予定を踏まえた LLM 生成の朝メッセージを送信
- バンクーバー時間の毎夜 `22:00` に、1日のまとめ送信を促すメッセージを送信
- バンクーバー時間の毎日 `03:00` に、前日 `03:00-当日02:59:59` の日次ログを `record/timeline/days/YYYY-MM-DD.md` へ保存し、必要なら X 投稿する
- LINE自由形式メッセージをLLMで判定し、当日予定の更新・一覧取得、`SOUL.md` / `USER.md` の編集、その他応答を返す
- Google Drive 上の `memory/` フォルダを長期記憶として段階探索し、人物、所属、過去イベント、継続プロジェクトなどの参照質問に返答する
- 各処理開始前に当日 Google Calendar event を読取同期し、手動追加・編集された予定も判断材料に含める
- アプリが作成・更新する event の description 先頭には `status` と `notifyOnEnd` を書き込み、完了状態と終了通知設定を保持する
- `modify_events` 後に Cloud Tasks で event ごとの開始通知と終了通知を再スケジュールする
- Cloud Tasks で `morning` / `night` / `close` の日次ジョブも自己再スケジュールし、ローカル時刻 `08:00` / `22:00` / `03:00` に実行する
- `notifyOnEnd: on` の event は、終了時点で未完了なら 15 分ごとに再通知し、22:00 以降は停止する
- Google Drive の `conversations/YYYY-MM-DD.json` に、`APP_TIMEZONE` / `TZ` に従う `localAt` 付きの日次会話履歴を保存する
- Google Drive の `record/timeline/days/YYYY-MM-DD.md` に、`03:00` 締めの日次記録を1日1ファイルで保存する
- Google Drive の `states/` 配下に通知状態、event 予約状態、Calendar 同期状態の JSON を保存する

アクション判定は、ユーザー入力に加えて処理直前に Google Calendar から取得した当日予定一覧を参照して行います。`modify_events` は Google Calendar event 一覧そのものを更新し、`list_events` はその一覧を返します。追加、編集、削除、完了報告、detail 更新はすべて同じ更新経路で処理され、更新用 LLM は現在の当日予定一覧とユーザー指示をもとに、その日の最終 event 一覧を JSON で返します。プログラム側はその event 一覧を検証して Google Calendar に直接リコンシリエーションします。`edit_soul` / `edit_user` は Google Drive 直下の `SOUL.md` / `USER.md` を対象に、会話履歴と両ファイルの現状を踏まえて全文更新と返信文生成を同じ LLM 呼び出しで行います。`memory` は Google Drive 上の `memory/index.md`、`memory/node-registry.yaml`、関連ノード本文を 2 段で探索し、必要な記憶だけを読んで返答します。アプリが更新した event の description には `status: todo|done` を先頭に保存し、当日の全項目を単一の event モデルで扱います。Google Calendar の読取スナップショットと同期失敗ログは Google Drive 上の `states/task-sync-state.json` に保存され、`03:00` close ジョブの成果物は `record/timeline/days/YYYY-MM-DD.md` の日次ログに一本化されています。

## 必須環境変数

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DEFAULT_USER_ID`
- `OPENAI_API_KEY`

任意:

- `APP_TIMEZONE`（既定: `America/Vancouver`。`TZ` は後方互換のフォールバックとしてのみ参照）
- `MORNING_JOB_TIME`（既定: `08:00:00`）
- `NIGHT_JOB_TIME`（既定: `22:00:00`）
- `CLOSE_JOB_TIME`（既定: `03:00:00`）
- `END_REMINDER_INTERVAL_MINUTES`（既定: `15`）
- `PORT`（既定: `8787`）
- `CRON_SECRET`（`/api/jobs/*` 保護用）
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_ACTION_MODEL`
- `OPENAI_TASK_MODEL`
- `OPENAI_SUMMARY_MODEL`
- `GOOGLE_DRIVE_ENABLED` / `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_DRIVE_MEMORY_FOLDER_NAME`（既定: `memory`）
- `GOOGLE_DRIVE_STATES_FOLDER_NAME`（既定: `states`）
- `GOOGLE_DRIVE_NOTIFICATION_STATE_FILE_NAME`
- `GOOGLE_DRIVE_NOTIFICATION_RETENTION_DAYS`（既定: `7`）
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` / `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_CALENDAR_ENABLED`（未指定時は `GOOGLE_DRIVE_ENABLED` を継承）
- `GOOGLE_CALENDAR_ID`（既定: `primary`）
- `GOOGLE_CALENDAR_EVENT_COLOR_ID`（既定: `1`）
- `GOOGLE_CALENDAR_SYNC_STATE_FILE_NAME`（既定: `task-sync-state.json`）
- `GOOGLE_CALENDAR_PULL_RETENTION_DAYS`（既定: `7`）
- `APP_BASE_URL` または `SECRETARY_BASE_URL`（Cloud Tasks の delivery endpoint を組み立てるために必要）
- `CLOUD_TASKS_PROJECT_ID` または `GOOGLE_CLOUD_PROJECT`
- `CLOUD_TASKS_LOCATION`
- `CLOUD_TASKS_QUEUE`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

補足:

- Google Calendar イベント同期を使う場合、現在の refresh token に Calendar scope が含まれている必要があります

## 起動

```bash
npm install
npm run dev
```

起動時にアプリは Cloud Tasks queue に次回の `morning` / `night` / `close` task を 1 本ずつ seed します。
各ジョブが完了すると翌日同時刻の task を自動作成するため、GitHub Actions や `node-cron` は不要です。
時刻は `APP_TIMEZONE` 基準で動作し、既定では毎日 `03:00`、`08:00`、`22:00` です。`MORNING_JOB_TIME`、`NIGHT_JOB_TIME`、`CLOSE_JOB_TIME` で上書きできます。

## エンドポイント

- `POST /webhook/line` LINE webhook
- `POST /api/jobs/morning` Cloud Tasks から叩かれる朝通知ジョブ
- `POST /api/jobs/night` Cloud Tasks から叩かれる22時のまとめ催促ジョブ
- `POST /api/jobs/close` Cloud Tasks から叩かれる03時の内部締めジョブ
- `POST /api/jobs/event-reminder-delivery` Cloud Tasks から叩かれる event 通知 delivery endpoint
- `GET /health` ヘルスチェック
