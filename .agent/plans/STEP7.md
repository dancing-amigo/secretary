# Step 7: Cloud Tasks ベースの時刻付き event 通知

## 目的
アプリ上の `modify_events` を唯一の event 更新経路とし、Google Calendar event の開始時刻通知と終了時刻通知を Cloud Tasks で正確に予約・取消できるようにする。

今回の前提は次のとおり。

- event の追加、編集、削除はすべてアプリ上で行う
- Google Calendar 上の手動追加、手動編集、手動削除は Step 7 の対象外とする
- 通知時刻の精度要件は「1 分前後」
- GitHub Actions や cron に通知精度を依存しない

## 仕様確定

### 1. event モデル
- task と予定は分離しない
- すべて Google Calendar event として管理する
- 開始時刻と終了時刻は event の `start` / `end` を使う
- 終日 event は Step 7 の通知対象外
- 時刻付き event は `allDay=false` かつ `startTime` / `endTime` を持つものとする

### 2. 開始通知
- 時刻付き event はすべて開始通知対象
- 開始時刻に 1 回だけ送る
- 開始通知に追加フラグは不要

### 3. 終了通知
- 終了通知は `notifyOnEnd: on` の event だけ対象
- 終了時刻時点で `status: todo` のときだけ送る
- 終了時刻時点で `status: done` なら送らない

### 4. metadata
- 既存の `status: todo|done` は維持する
- 終了通知用 metadata として `notifyOnEnd: on|off` を追加する
- 既定値は `off`

記述例:

```txt
status: todo
notifyOnEnd: on

先方レビューまでに初稿を出す
```

## 基本方針

### 1. `modify_events` を唯一のスケジューリング入口にする
- event の追加時に Cloud Tasks を新規作成する
- event の時刻変更、`notifyOnEnd` 変更、完了変更時に Cloud Tasks を再計算する
- event の削除時に既存 Cloud Tasks を削除する

### 2. Google Calendar 手動変更は無視する
- Step 7 では Google Calendar を通知スケジューリングのトリガー source にしない
- アプリ外で直接作られた event は通知対象外になりうる
- アプリ外で直接編集された event に対して、既存予約が stale になる可能性は受け入れる

この制約は Step 7 の仕様として明示する。

## 採用アーキテクチャ

### 1. Cloud Tasks を one-off scheduler として使う
- event ごとに開始通知 task と終了通知 task を必要に応じて作る
- task には実行時刻を設定し、到達時にアプリの HTTP endpoint を叩かせる
- 予約済み task は task name で管理する

### 2. delivery 時に再検証する
- Cloud Tasks の payload をそのまま信じて送信しない
- 実行時に Google Calendar の最新 event を取得し、まだ通知すべきか確認する
- これにより、以下を防ぐ
  - 完了済みなのに終了通知する
  - 削除済み event に通知する
  - 時刻変更後の古い予約が残っていた場合に誤通知する

## Cloud Tasks 設計

### 1. task 種別
- `start` 通知 task
- `end` 通知 task

### 2. task 名
- task 名は再作成・削除しやすい決定的命名にする
- 推奨:
  - 開始通知: `event-{eventId}-start`
  - 終了通知: `event-{eventId}-end`

補足:
- Cloud Tasks の task name は queue 内で一意
- 同じ event の予約を張り替えるときは、旧 task を delete してから新 task を create する

### 3. payload
- `eventId`
- `type` (`start` or `end`)
- `scheduledAt`
- `dateKey`

payload は最小限でよい。実データの正本は常に Google Calendar にある。

## state 設計

Google Drive の通知 state とは別に、event ごとの予約状態を保持する。

保持内容の例:

```json
{
  "eventSchedules": {
    "googleEventId123": {
      "startTaskName": "projects/.../tasks/event-googleEventId123-start",
      "startScheduledAt": "2026-03-07T13:00:00-08:00",
      "endTaskName": "projects/.../tasks/event-googleEventId123-end",
      "endScheduledAt": "2026-03-07T15:00:00-08:00",
      "notifyOnEnd": true,
      "status": "todo",
      "allDay": false,
      "updatedAt": "2026-03-07T12:00:00.000Z"
    }
  }
}
```

用途:
- 旧 task の delete 対象を知る
- 変更時に差分比較する
- 削除時に cleanup する

## `modify_events` 時のリコンシリエーション

### 1. 追加
- 新規 event が時刻付きなら開始 task を create
- `notifyOnEnd:on` なら終了 task も create
- state に task 名と scheduledAt を保存

### 2. 編集
- 対象 event の旧 state を読む
- 次のいずれかが変わったら再スケジュール対象
  - `allDay`
  - `startTime`
  - `endTime`
  - `status`
  - `notifyOnEnd`
- 旧 start task / old end task を必要に応じて delete
- 新条件に応じて start task / end task を create
- state を上書き

### 3. 削除
- 対象 event の start task / end task を delete
- state から該当 event を削除

### 4. 完了
- `status` が `done` になったら終了通知 task は delete する
- 開始通知 task が未来に残っているケースも安全側で delete してよい

## delivery endpoint の動作

### 1. endpoint
- `POST /api/jobs/event-reminder-delivery`

### 2. 実行時フロー
1. Cloud Tasks から payload を受ける
2. payload の `eventId` で Google Calendar の最新 event を取得する
3. event が存在しなければ何も送らず成功終了する
4. `type=start` のとき:
- 時刻付き event か
- 終日ではないか
- 開始時刻が payload の `scheduledAt` と一致するか
- すでに送信済みでないか
5. `type=end` のとき:
- 時刻付き event か
- 終日ではないか
- `notifyOnEnd:on` か
- `status: todo` か
- 終了時刻が payload の `scheduledAt` と一致するか
- すでに送信済みでないか
6. 条件を満たしたときだけ LINE push
7. 送信後、通知 sent state を記録

### 3. 冪等性
- delivery は少なくとも 1 回以上で飛ぶ可能性を前提にする
- 送信 dedupe は `eventId + type + scheduledAt` で管理する
- 既送信なら何もせず成功終了する

## キャンセル戦略

### 1. 原則
- 予約変更時は「古い task を delete -> 新しい task を create」の順

### 2. delete 失敗時
- 404 は「すでにない」とみなして続行
- 一時失敗なら処理全体を失敗にしてよい
- 中途半端な状態を避けるため、state 更新は Cloud Tasks 操作成功後に行う

### 3. 誤配信防止の最後の砦
- 仮に古い task が delete できずに残っても、delivery 時の `scheduledAt` 再検証で弾く

## 受け入れ条件
1. 時刻付き event 追加時、開始通知 task が作成される
2. `notifyOnEnd:on` の event 追加時、終了通知 task も作成される
3. `notifyOnEnd:off` の event 追加時、終了通知 task は作成されない
4. event の開始時刻変更時、旧開始 task は削除され、新開始 task に張り替わる
5. event の終了時刻変更時、旧終了 task は削除され、新終了 task に張り替わる
6. `notifyOnEnd:on -> off` 変更時、終了 task は削除される
7. event 削除時、開始 task / 終了 task が削除される
8. `status: done` 変更時、終了通知は送られない
9. delivery が重複実行されても同じ通知は 1 回しか送られない
10. 古い task が残っても、最新 event と `scheduledAt` が不一致なら誤通知しない

## 非スコープ
- Google Calendar 上の手動変更追従
- watch webhook
- 定期 repair sync
- 複数日跨ぎ event の精密サポート
- 通知文面の高度な最適化

## 実装順
1. description metadata に `notifyOnEnd` を追加できるようにする
2. Google Calendar event 単体取得 API を追加する
3. Cloud Tasks client と create/delete wrapper を追加する
4. event schedule state の read/write を追加する
5. `modify_events` 後の差分から start/end task を reconcile する
6. delivery endpoint を追加する
7. sent dedupe を `eventId + type + scheduledAt` 単位で追加する
8. テストを追加する
