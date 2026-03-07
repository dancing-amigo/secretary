# Step 8: 終了後未完了 event の15分間隔再通知

## 目的
Step 7 の終了通知を拡張し、`notifyOnEnd: on` の時刻付き event が終了時刻を過ぎても `status: todo` のままなら、15 分ごとに再通知できるようにする。

今回の前提は Step 7 を引き継ぐ。

- event の追加、編集、削除はアプリ上の `modify_events` が唯一の更新経路
- Google Calendar 上の手動変更は Step 8 の対象外
- 通知配信は Cloud Tasks の one-off task を使う
- delivery 時には毎回 Google Calendar の最新 event を再取得して判定する

## 基本結論

Step 8 は「定期的に Google Calendar を見に行く」方式ではなく、終了通知 task が実行されたタイミングで次の 15 分後 task を 1 本だけ自己再スケジュールする方式で実現する。

つまり:

1. 終了時刻の task が発火する
2. 最新 event を取得する
3. `status: todo` なら通知を送る
4. 次の 15 分後がカットオフ前なら、次回の再通知 task を 1 本だけ作る
5. 次回 task でも同じ判定を繰り返す

この方式なら polling は不要で、Step 7 の Cloud Tasks 設計をそのまま拡張できる。

## 仕様確定

### 1. 対象
- `allDay=false` の時刻付き event
- `notifyOnEnd: on`
- 終了時刻到達後

### 2. 初回終了通知
- 終了時刻の task 実行時に最新 event を取得する
- `status: todo` なら通知を送る
- `status: done` なら何も送らず終了する

### 3. 再通知
- 初回通知または再通知送信後、その時点でまだ `status: todo` なら次の 15 分後 task を作る
- 次回 task も実行時に最新 event を取得し、再度同じ判定を行う
- `status: done` になった時点で再通知チェーンを止める

### 4. 22:00 カットオフ
- 自動通知はローカル時刻 22:00 まで
- 次回予定時刻が 22:00 以上になるなら、その次 task は作成しない
- 21:45 の通知までは許可し、22:00 以降の再通知は作らない

## Step 7 との差分

### Step 7
- 終了通知は 1 回だけ
- `modify_events` 時に終了 task を 1 本作る

### Step 8
- 終了通知は最大で複数回
- ただし常に「次の 1 本」だけを持つ
- `modify_events` は再通知チェーンの初期条件を更新する役割
- 実際の 15 分ループ継続は delivery endpoint 側で行う

## 採用アーキテクチャ

### 1. task 種別の整理
- `start` 通知 task
- `end-initial` 通知 task
- `end-repeat` 再通知 task

実装上は `type=end` と `attempt` や `repeat=true` を payload に持たせてもよい。

### 2. 常に次の 1 本だけを予約する
- 未来の 15 分刻み task をまとめて大量に作らない
- 送信した時点で次の 1 本だけ作る
- これにより、完了時や時刻変更時の cleanup が簡単になる

## state 設計

Step 7 の event schedule state を拡張する。

例:

```json
{
  "eventSchedules": {
    "googleEventId123": {
      "startTaskName": "projects/.../tasks/event-googleEventId123-start",
      "startScheduledAt": "2026-03-07T13:00:00-08:00",
      "endTaskName": "projects/.../tasks/event-googleEventId123-end",
      "endScheduledAt": "2026-03-07T15:00:00-08:00",
      "endRepeatTaskName": "projects/.../tasks/event-googleEventId123-end-repeat",
      "endRepeatScheduledAt": "2026-03-07T15:15:00-08:00",
      "notifyOnEnd": true,
      "status": "todo",
      "allDay": false,
      "updatedAt": "2026-03-07T12:00:00.000Z"
    }
  }
}
```

ポイント:
- `endRepeatTaskName` は「今ぶら下がっている次回 1 本」だけ保持する
- 再通知が送られて次の 15 分後を予約したら、その情報で上書きする
- 再通知チェーン停止時は `endRepeatTaskName` / `endRepeatScheduledAt` を消す

## `modify_events` 時のリコンシリエーション

### 1. 追加
- 時刻付き event なら開始 task を作成
- `notifyOnEnd:on` なら終了時刻 task を作成
- 再通知 task はまだ作らない

### 2. 編集
- 次のいずれかが変わったら終了系 task の再計算対象
  - `allDay`
  - `endTime`
  - `status`
  - `notifyOnEnd`
- 既存の `endTaskName` と `endRepeatTaskName` を delete
- 新条件に応じて終了時刻 task を作り直す
- 再通知 task は delivery 時に必要になったときだけ再作成する

### 3. 完了
- `status: done` になったら `endTaskName` と `endRepeatTaskName` を delete
- state も終了系情報をクリアする

### 4. 削除
- `startTaskName` / `endTaskName` / `endRepeatTaskName` を delete
- state から event を削除する

## delivery endpoint の動作

### 1. 終了通知 task 実行時
1. payload を受ける
2. `eventId` で最新 event を取得する
3. event が存在しなければ成功終了
4. 終日なら成功終了
5. `notifyOnEnd:on` でなければ成功終了
6. `scheduledAt` が現在 event の終了系対象時刻と一致しなければ成功終了
7. `status: done` なら成功終了
8. 未送信なら通知を送る
9. 送信成功後、15 分後が 22:00 未満なら次の `end-repeat` task を作る

### 2. 再通知 task 実行時
1. payload を受ける
2. `eventId` で最新 event を取得する
3. event が存在しなければ成功終了
4. 終日なら成功終了
5. `notifyOnEnd:on` でなければ成功終了
6. `status: done` なら成功終了
7. payload の `scheduledAt` が state 上の `endRepeatScheduledAt` と一致しなければ成功終了
8. 未送信なら通知を送る
9. 次の 15 分後が 22:00 未満なら次の `end-repeat` task を作る

## 重要な設計ポイント

### 1. 「送ったら次を作る」でよい
あなたが言っている流れで問題ない。

- 終了通知時に最新 status を確認する
- `todo` なら送る
- 送った直後に次の 15 分後を予約する
- 次回も最新 status を確認する
- `done` ならそこで止める

これは Step 8 に最も合っている。

### 2. polling は不要
- 毎回 Cloud Tasks の配信時に最新 event を見ればよい
- 「アプリが定期的に Calendar を見に行く」必要はない
- 必要なのは「終了系 task が発火した瞬間に最新 event を確認する」ことだけ

### 3. stale task は delivery で弾く
- `modify_events` で `endTime` が変わった場合、旧 `endTaskName` / `endRepeatTaskName` は delete する
- もし delete 漏れがあっても、delivery 時に `scheduledAt` 不一致として捨てる

## 冪等性

- dedupe key は `eventId + type + scheduledAt`
- `type=end-initial` と `type=end-repeat` を分けてもよいが、通知上は両方 `end` 系として扱える
- 同一 scheduledAt の通知は 1 回だけ送る
- Cloud Tasks の再試行や重複配信があっても重複送信しない

## 22:00 カットオフ詳細

- ローカル時刻で次回予定が `22:00:00` 以上なら作らない
- 例:
  - 21:30 通知後 -> 21:45 を作る
  - 21:45 通知後 -> 22:00 は作らない

## 受け入れ条件
1. `endTime=15:00`、`notifyOnEnd:on`、`status: todo` の event は 15:00 に通知される
2. 15:00 通知後に `status: todo` のままなら 15:15 が予約される
3. 15:15 実行時も `status: todo` なら通知され、15:30 が予約される
4. 15:15 より前に `status: done` になったら 15:15 以降の通知は送られない
5. 15:10 に `endTime=17:00` へ変更したら、旧終了 task / 旧再通知 task は停止し、17:00 基準に切り替わる
6. 21:45 に通知が送られた場合、22:00 以降の再通知は作られない
7. delivery が重複しても同一 scheduledAt の通知は 1 回だけ
8. stale task が残っても `scheduledAt` 不一致なら送られない

## 非スコープ
- Google Calendar 手動変更追従
- 定期 polling
- 15 分以外の再通知間隔カスタマイズ
- 22:00 以降の夜間通知延長
- 通知文面の最適化

## 実装順
1. Step 7 の終了通知 delivery を実装する
2. event schedule state に `endRepeatTaskName` / `endRepeatScheduledAt` を追加する
3. 終了通知送信成功時に次の 15 分後 task を作る処理を追加する
4. `modify_events` の完了・削除・endTime変更・notifyOnEnd変更時に repeat task も cleanup する
5. 22:00 カットオフ判定を追加する
6. end-repeat 系の dedupe テストを追加する
