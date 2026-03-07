# .agent README

`.agent/` は、このプロジェクトでエージェントが参照する作業メモ・計画・完了履歴のハブです。
この README は単なる構成説明ではなく、`plans/` と `done/` の内容を素早く把握するための索引として維持します。

## 参照順

1. まずこの `README.md` を読んで、進行中プランと完了済みプランの全体像を把握する
2. 次に対象の詳細 Markdown を `plans/` または `done/` から開く
3. 実作業後、状態変化があればこの README の一覧も更新する

## ディレクトリ構成

- `plans/`: 進行中または未完了の計画書
- `done/`: 完了済みの計画書

## 進行中プラン一覧

### `STEP6.md`
- Step 5 で同期済みの Google Calendar event を `log.md` に記録する計画
- 予定取得そのものは持たず、`log.md` 更新責務に限定する
- 夜サマリーに Calendar event ベースの進捗と予定の関係を反映する前提

### `STEP7.md`
- Calendar event ごとの `startTime` / `endTime` に基づく通知仕様の計画
- 開始通知と、終了時点で未完了なら送る通知を定義
- 時刻変更時の再スケジュールや重複通知防止も含む

### `STEP8.md`
- `endTime` 超過後の未完了タスクへ 15 分間隔で再通知する強化計画
- 完了時または `endTime` 変更時に再通知を止める
- 22:00 以降は時刻トリガー通知を打ち切る

### `STEP9.md`
- 当日会話履歴を全 LLM 呼び出しへ共通注入する計画
- 対象は ActionClassifier、TaskChangePlanner、NightSummaryGenerator
- 前日 22:00 からの履歴を共通フォーマットで渡し、取得失敗時は安全停止する

### `STEP10.md`
- Google Drive ルートの `SOUL.md` / `USER.md` を全 LLM 呼び出しの先頭に毎回注入する設計
- 順序は `SOUL.md` → `USER.md` → 当日会話履歴 → 最新入力で固定
- 実装ではなく、今後の全 LLM 経路に適用する規約定義が中心

### `STEP11.md`
- `SOUL.md` / `USER.md` を編集する専用アクション `edit_soul` / `edit_user` を追加する計画
- ActionClassifier を 5 分類へ拡張する
- 編集用 LLM が変更計画、実行、結果出力まで一貫して担当する前提

### `STEP12.md`
- ActionClassifier を複数アクション出力へ拡張し、最終返信を OutputComposer に統一する計画
- 複合意図を 1 ターンで順次処理できるようにする
- `others` も専用エージェント化して無処理経路をなくす

## 完了済みプラン一覧

### `STEP1.md`
- 自由文入力を LLM で解釈し、`save_tasks` / `list_tasks` / `others` を判定する基盤
- `save_tasks` 時のみ別 LLM でタスク分割し、Google Drive の `tasks/YYYY-MM-DD.md` に保存する方針
- 各タスクへ `localTaskId` を付与し、後続の編集や外部同期の土台を作る

### `STEP2.md`
- 当日タスク更新を `modify_tasks` に統合し、追加、編集、削除、完了、詳細更新を単一アクションで扱えるようにした
- `modify_tasks` 用 LLM が当日ファイルの現状とユーザー指示から、更新後の `tasks/YYYY-MM-DD.md` 全文を直接返す構成へ切り替えた
- `list_tasks` は Markdown から `title` / `status` を読み出して返す

### `STEP3.md`
- 夜ウィンドウ `21:30-22:30` で、会話履歴と当日タスクを元にした日次サマリーを1回だけ生成・送信する実装を追加した
- `notifications` は単一 JSON に集約し、`summaryGeneratedAt` / `logUpdatedAt` / `sentAt` を保持する構成に整理した
- 会話履歴は `conversations/YYYY-MM-DD.json` に日単位で蓄積し、Google Drive 直下の `log.md` は日次セクション単位で更新するようにした

### `STEP4.md`
- `modify_tasks` 後に当日タスク全体を Google Calendar event へリコンシリエーションする実装を追加した
- 時刻レンジがあるタスクは時間付きイベント、時刻レンジがないタスクは終日イベントとして同期する構成にした
- `task-sync-state.json` に `localTaskId` と `googleCalendarEventId` の対応関係、および同期失敗ログを保持し、失敗時は Vercel log にも詳細を出すようにした

### `STEP5.md`
- LINE受信時、朝通知前、夜サマリー前に当日 Google Calendar event を読取同期する実装を追加した
- 取得した予定を `task-sync-state.json` に日付単位スナップショットとして保存し、同期失敗時も処理継続する構成にした
- ActionClassifier と task 更新 LLM に当日予定一覧を注入し、手動追加・編集された予定も判断材料に含めるようにした

### `STEP13.md`
- Google Calendar event を唯一の正本にし、Google Drive の当日 task ファイル依存を主要フローから外した
- event description 先頭の `kind` / `status` metadata で task と schedule を同じ event モデルとして管理するようにした
- `modify_tasks` / `list_tasks` / 夜サマリーを Calendar event ベースへ置き換え、AI への入力も当日予定一覧へ一本化した

### `STEP14.md`
- Google Calendar 上の当日項目を `event` 単一モデルへ整理し、`kind` / `confirmed` / `managed` / `external` を廃止した
- action 名を `modify_events` / `list_events` へ改め、分類と文言を event 中心へ揃えた
- Calendar description の管理 metadata を `status: todo|done` のみに簡素化した

## 更新ルール

- 新しいプランを `plans/` に追加したら、この README に項目と要約を追記する
- プラン完了により `plans/` から `done/` へ移動したら、この README の該当項目も移動し、要約を最新状態に合わせて整える
- 既存プランの内容が大きく変わったら、README の要約も同じターンで更新する
- `plans/` や `done/` の実ファイルと、この README の一覧が不一致のまま作業を終えない
