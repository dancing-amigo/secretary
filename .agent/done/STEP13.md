# Step 13: Google Calendarイベント同期（時刻レンジ付きタスク）

## 目的
Google Tasks へ同期した「今日のタスク」に日付を必ず持たせる。
加えて、開始時刻と終了時刻を含むタスクは Google Calendar のイベントとしても同期し、
月表示や日表示で時間枠つき予定として見えるようにする。

## 固定方針
- タスクの正本は引き続き Google Drive 上の `tasks/YYYY-MM-DD.md`
- Google Tasks には全タスクを同期し、`due` には当日の日付を設定する
- Google Calendar には「時刻レンジを解釈できたタスク」だけを同期する
- 時刻レンジを解釈できないタスクは Google Tasks のみ同期し、Calendar イベントは作らない
- ローカル更新失敗時は当然停止するが、Google 側同期失敗時はローカル状態を優先して処理継続する

## 成功条件
- `modify_tasks` で追加した当日タスクが Google Tasks 上で `No date` ではなく当日の日付つきで表示される
- `detail` などから `14:00〜18:00` のような時間レンジが取れるタスクは Google Calendar イベントとしても作成される
- タイトル変更や時刻変更時に、同じ Calendar eventId へ更新される
- タスク削除時に対応する Google Calendar イベントも削除される
- 時刻レンジが消えたタスクは Calendar イベントを削除し、Tasks 側は残す

## 実装スコープ
1. Google Tasks 側の日付指定
- 同期時に `tasks/YYYY-MM-DD.md` の日付を `due` として Google Tasks へ送る

2. Google Calendar イベント同期
- `detail` 等から `HH:MM〜HH:MM` / `HH時〜HH時` を抽出する
- 抽出できた場合だけ、当日の日付と組み合わせて Google Calendar Event を作る
- 対応関係は `localTaskId <-> googleCalendarEventId` で保持する

3. state 管理
- 既存の Google 同期 state に Calendar eventId と calendarId を保持できるよう拡張する
- Calendar 同期失敗も同じ失敗ログへ残す

4. 運用メッセージ
- 既存の返信方針を維持し、必要時のみ外部同期失敗を補足する

## 非スコープ
- 予定参加者、場所、会議URLなどの高度なイベント情報
- タスクに時刻しかなく日付が別日になるケース
- 繰り返しイベント
