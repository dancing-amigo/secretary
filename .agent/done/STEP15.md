# STEP15

## 目的

Google Drive の `states/` 配下にある固定 JSON ファイルで、古い日付キーが無制限に残り続けないようにする。

## 対象

- `notification-state.json` の `notifications[slot:dateKey]`
- `task-sync-state.json` の `pulls[dateKey]`
- `task-sync-state.json` の `failures[]`

## 方針

1. 保存時に古い日付キーを自動で prune する
2. 保持期間はコード上で明示し、必要なら環境変数で上書きできるようにする
3. 失敗ログ `failures` も保持期間で prune しつつ、件数上限 200 件は維持する

## 完了条件

- 古い `notifications` が保持期間外なら保存時に削除される
- 古い `pulls` が保持期間外なら保存時に削除される
- 古い `failures` が保持期間外なら保存時に削除される
- 既存挙動を壊さずに lint が通る
