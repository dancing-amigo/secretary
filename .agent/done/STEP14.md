# Step 14: event 単一モデル化と action 命名整理

## 目的
Google Calendar 上の当日項目をすべて単一の event として扱い、`task` / `schedule` / `managed` / `external` の内部区分を廃止する。
あわせて action 名も `modify_events` / `list_events` へ変更し、実装と文言を event 中心に揃える。

## 背景
- 現状は `kind: task|schedule` と `status: todo|done|confirmed` を持たせているが、`confirmed` は schedule 側のためだけに追加された不自然な状態である
- `managed` / `external` も通知対象の暫定区分であり、今後は LINE 経由で別途設定する方針のため不要
- ユーザー要望として、Google Calendar では event だけを扱い、task という概念自体をアプリの主要モデルから外したい

## 固定方針
- 当日項目はすべて Google Calendar event として扱う
- event の status は `todo` / `done` のみとする
- `kind` と `confirmed` は廃止する
- `managed` / `external` も廃止する
- Calendar description の管理 metadata は `status` のみ保存する
- 既存の `kind:` metadata は読み取り互換として無視し、更新時には再出力しない
- action 名は `modify_events` / `list_events` / `others` にする
- 終了通知の対象判定は今回は実装しない

## 今回の成功条件
- ActionClassifier が `modify_events` / `list_events` / `others` を返す
- 更新用 LLM の event schema から `kind` と `confirmed` が消える
- 一覧表示は event 種別を出さず、当日の全 event を表示する
- Google Calendar の pull snapshot から `managed` / `external` と `linkedLocalTaskId` が消える
- README と `.agent` の索引説明が event 単一モデル前提になる

## 実装スコープ
1. `assistantEngine` の action enum、プロンプト、schema、整形文言を更新する
2. `googleCalendarSync` の metadata 解析と description 生成を `status` のみにする
3. pull snapshot 正規化から `source` / `linkedLocalTaskId` を削除する
4. README と今後参照される active plan の action 名を更新する

## 非スコープ
- LINE から通知対象を設定する新仕様
- 終了通知ロジックの追加や再設計
- 過去データの一括マイグレーション
