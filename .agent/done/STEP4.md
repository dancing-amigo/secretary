# Step 4: Google Calendar連携（`modify_tasks` の外部同期）

## 実施内容
`modify_tasks` で確定した当日タスク一覧を、Google Calendar のイベントへ片方向同期する実装を追加した。
当初は Google Tasks 同期も試したが、最終的には Google Calendar event のみを正とする構成へ整理した。

## 最終仕様
- タスクの正本は引き続き Google Drive の `tasks/YYYY-MM-DD.md`
- `modify_tasks` で保存した当日タスク全体を、そのまま Google Calendar にリコンシリエーションする
- `detail` または `title` に `14:00〜18:00` / `14時〜18時` のような時刻レンジがあるタスクは時間付きイベントとして作成する
- 時刻レンジがないタスクは終日イベントとして作成する
- `status=done` のタスク、およびローカルから削除されたタスクは、対応する Google Calendar イベントを削除する
- 同期失敗時もローカル更新結果を優先し、LINE 返信には必要時のみ「Google同期で一部失敗」または「一部再試行予定」を補足する

## 実装詳細
1. Google Calendar同期基盤
- OAuth refresh token を使って Google Calendar API を呼ぶ同期サービスを追加した
- 同期先カレンダー ID とイベント色 ID は環境変数で設定可能にした
- イベント色は `colorId` で指定できるようにした

2. イベント生成ルール
- 時刻レンジあり:
  - `start.dateTime` / `end.dateTime` を RFC3339 で生成して時間付きイベントを作成
- 時刻レンジなし:
  - `start.date` / `end.date` を使って終日イベントを作成
- 完了・削除:
  - 対応するイベントを Google Calendar から削除

3. 同期状態管理
- Google Drive 上の `task-sync-state.json` に以下を保持する構成にした
  - `localTaskId`
  - `googleCalendarEventId`
  - `calendarId`
  - `dateKey`
  - `lastSyncedAt`
- 同期失敗ログも同じ state ファイルに保持する

4. ログと障害調査
- Google Calendar 同期失敗時は、Vercel の function log にも `operation`、対象 ID、payload、エラー内容を出すようにした
- Google Drive 上の state と Vercel log の両方から失敗原因を追える構成にした

## 実装中に方針変更した点
- Google Tasks API では時刻付きタスクを API 経由で安定的に扱えないため、Google Tasks 同期は最終的に廃止した
- そのため、外部表示は Google Calendar event のみへ一本化した
- 時間指定のあるタスクと時間指定のないタスクを、どちらも Google Calendar 上で見られるようにした

## 完了時点の到達点
- LINE で追加・編集・削除・完了した当日タスクが Google Calendar に反映される
- 時間指定ありタスクは時間付きイベント、時間指定なしタスクは終日イベントとして表示される
- 同一タスクの再編集時も、既存 eventId に対して更新される
- 同期失敗時もアプリ全体は止まらず、原因調査に必要なログが残る

## 非スコープ
- Google Calendar 側での手動編集の逆方向同期
- 参加者、場所、会議URL、繰り返し予定などの高度なイベント属性
- 複数 Google カレンダーへの同時同期
