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

- なし

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

### `STEP6.md`
- Step 5 で同期済みの Google Calendar event を `log.md` に記録する実装を追加した
- 予定取得は既存同期処理を再利用し、責務を `log.md` 更新に限定した
- 夜サマリーで予定と実績の関係を Calendar event ベースで参照できる前提を整えた

### `STEP7.md`
- Cloud Tasks を使って時刻付き event の開始通知と終了通知を予約・取消する実装を追加した
- `notifyOnEnd: on|off` metadata を Calendar description に保存し、`modify_events` 後に event ごとの通知スケジュールを再計算する
- delivery 時に最新 event と `scheduledAt` を再検証し、古い task が残っても誤通知しない構成にした

### `STEP8.md`
- `notifyOnEnd` 対象 event の終了後未完了状態に対し、15 分ごとに自己再スケジュールする再通知を実装した
- 再通知は delivery 時に最新 event を確認し、未完了なら送信して次の 1 本だけを予約する
- 完了、削除、`endTime` 変更、22:00 到達で再通知チェーンを停止する

### `STEP9.md`
- 当日会話履歴を ActionClassifier、TaskChangePlanner、NightSummaryGenerator の全 LLM 呼び出しへ共通注入した
- 対象範囲を前日 22:00 から実行時点までに統一し、同一フォーマットの会話コンテキストを再利用するようにした
- LINE受信時の会話保存失敗では LLM 実行へ進まず、安全停止するようにした

### `STEP10.md`
- Google Drive ルートの `SOUL.md` / `USER.md` を全 LLM 呼び出しごとに毎回読み込み、OpenAI クライアントで共通注入する実装を追加した
- 注入順は `SOUL.md` → `USER.md` を固定し、その後段で既存の会話履歴と最新入力を扱う構成に統一した
- 共通クライアント経由のため、既存の ActionClassifier、TaskChangePlanner、NightSummaryGenerator すべてへ一括適用される

### `STEP11.md`
- `SOUL.md` / `USER.md` を編集する専用アクション `edit_soul` / `edit_user` を追加した
- ActionClassifier を 5 分類へ拡張し、編集指示と単なる相談を分ける優先順位をプロンプトへ明記した
- 編集用 LLM が会話履歴と両ファイル内容を入力に、更新後全文生成、Google Drive 反映、ユーザー向け結果出力まで一貫して担当する実装を追加した

### `STEP12.md`
- `others` アクションで、固定の `OK` ではなく実質的な返答を返す実装を追加した
- `SOUL.md` / `USER.md` / 当日会話履歴 / 最新メッセージを入力にした対話応答プロンプトを導入した
- 外部更新を伴わない安全な応答経路として、質問、雑談、相談に自然な返信を返せるようにした

### `STEP13.md`
- Google Calendar event を唯一の正本にし、Google Drive の当日 task ファイル依存を主要フローから外した
- event description 先頭の `kind` / `status` metadata で task と schedule を同じ event モデルとして管理するようにした
- `modify_tasks` / `list_tasks` / 夜サマリーを Calendar event ベースへ置き換え、AI への入力も当日予定一覧へ一本化した

### `STEP14.md`
- Google Calendar 上の当日項目を `event` 単一モデルへ整理し、`kind` / `confirmed` / `managed` / `external` を廃止した
- action 名を `modify_events` / `list_events` へ改め、分類と文言を event 中心へ揃えた
- Calendar description の管理 metadata を `status: todo|done` のみに簡素化した

### `STEP15.md`
- Google Drive の `states/*.json` に対して保持期間ベースの prune を追加した
- `notification-state.json` と `task-sync-state.json` の古い日付キー、および失敗ログを保存時に自動削除する
- 保持期間は環境変数で上書き可能とし、既定値は 7 日にした

### `STEP16.md`
- `morning` / `night` の定時起動を GitHub Actions から Google Cloud Tasks へ移した
- 毎日ローカル時刻 `08:00` と `22:00` に 1 回だけ Cloud Tasks で起動するようにした
- 朝夜ジョブ向け window 重複防止ロジックを起動経路から外した

### `STEP17.md`
- 朝ジョブの文面を固定文字列から LLM 生成へ切り替え、前日会話と当日予定を踏まえた朝メッセージを送る実装を追加した
- `SOUL.md` / `USER.md` / 前日会話履歴 / 当日予定を入力にして、挨拶、予定確認、元気づける一言を生成するようにした
- 朝通知送信後の会話履歴保存と、朝ジョブ失敗時の notification state 記録も追加した

### `STEP18.md`
- `modify_events` の新規 event ID を LLM の候補選択から外し、アプリ側で後付け採番する実装へ変更した
- LLM には `isNew` と既存 `id` のみを返させ、既存 event の参照と新規 event の追加を明確に分離した
- 候補外 ID による更新失敗をなくし、この境界を担保する自動テストを追加した

## 更新ルール

- 新しいプランを `plans/` に追加したら、この README に項目と要約を追記する
- プラン完了により `plans/` から `done/` へ移動したら、この README の該当項目も移動し、要約を最新状態に合わせて整える
- 既存プランの内容が大きく変わったら、README の要約も同じターンで更新する
- `plans/` や `done/` の実ファイルと、この README の一覧が不一致のまま作業を終えない
