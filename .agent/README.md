# .agent README

`.agent/` は、このプロジェクトでエージェントが参照する作業メモ・計画・補助ドキュメント・完了履歴のハブです。
この README は単なる構成説明ではなく、`docs/` `plans/` と `done/` の内容を素早く把握するための索引として維持します。

## 参照順

1. まずこの `README.md` を読んで、補助ドキュメント・進行中プラン・完了済みプランの全体像を把握する
2. 次に `docs/memory.md` を必ず読む
3. その後、必要な補助資料を `docs/` から確認する
4. 続けて、対象の詳細 Markdown を `plans/` または `done/` から開く
5. 実作業後、状態変化があればこの README の一覧も更新する

## ディレクトリ構成

- `plans/`: 進行中または未完了の計画書
- `docs/`: 作業時に参照する補助ドキュメント（特にメモリー関連のタスクをするときは `docs/memory.md` 必読）
- `done/`: 完了済みの計画書

## 進行中プラン一覧

### `STEP29.md`
- `03:00` close ジョブの daily log 入力に、Google Drive `record/audio` 配下の前日 transcript `.txt` を追加する
- transcript は将来の音声ファイル対応を見越した `audio processor` で処理し、ユーザー本人に関連する発話・思考・会話・記憶候補を抽出する
- processor 出力を daily log 作成エージェントへ渡し、結果も `record/audio-processed` に永続保存できるようにする

### `STEP30.md`
- scope の正本をコードから `memory/scopes.yaml` へ移し、`id` ベースで一元管理できるようにする
- `03:00` close の memory 更新に `scopeOps` を追加し、AI が scope の作成・更新・付与・剥奪を自動適用できるようにする
- person / organization の権限と各 memory node の所属 scope を registry 参照に統一し、permission review も registry 基準へ切り替える

### `STEP26.md`
- 朝ジョブの入力を前日 summary 依存から、前日分と直近3日分の `record/timeline/days/YYYY-MM-DD.md` 参照へ寄せる
- 当日 Calendar event と直近 daily record を材料に、確定計画ではなく「今日やる候補」を複数提案する朝メッセージへ再設計する
- `memory/` は使わず、持ち越し候補や未着手項目を daily record から拾う方針を固定する

### `STEP25.md`
- `03:00` close ジョブで、前日分 `record/timeline/days/YYYY-MM-DD.md` を入力にした memory 更新を 1 日 1 回追加する
- memory 更新は既存ノード更新、新規ノード作成、`node-registry.yaml` 更新、必要な双方向リンク更新まで含める
- scope 管理はこの Step には含めず、将来 Step30 で `memory/scopes.yaml` と `scopeOps` を追加できるよう責務を分けておく

## 完了済みプラン一覧

### `STEP23.md`
- `03:00` close ジョブの日次記録保存先を `log.md` から `record/timeline/days/YYYY-MM-DD.md` の日別ファイルへ移した
- 日次記録を `## 今日の予定` と `## ノート` の2部構成にし、予定詳細と会話由来の補足を保持する詳細ログへ切り替えた
- `recordUpdatedAt` による保存済み判定へ移行し、日次記録からカレンダー同期失敗などの内部エラー文言を除去した

### `STEP24.md`
- `03:00` close ジョブの `summaryContextText` を廃止し、日次ログ Markdown を唯一の close 成果物に寄せた
- 朝メッセージと X 投稿は notification state の内部サマリーではなく `record/timeline/days/YYYY-MM-DD.md` を直接読む構成へ切り替えた
- close record には重複防止と実行状態に必要な最小情報だけを残し、二重管理を解消した

### `STEP22.md`
- `22:00` 夜サマリー送信を廃止し、`22:00` 催促、`03:00` 内部締め、`08:00` 朝メッセージの3ジョブへ再編した
- 1日の定義を `03:00` 区切りに変更し、内部サマリーは `log.md` と notification state に保存するが LINE 会話履歴へは保存しないようにした
- 朝メッセージは前日会話ではなく、`03:00` で確定した前日サマリーと当日予定を使い、X 投稿も `03:00` ジョブへ移した

### `STEP21.md`
- Google Drive 上の `memory/` フォルダを探索する独立 `memory` アクションを追加した
- flow は `ActionClassifier -> primary 候補選定 -> primary 本文読取 -> secondary 候補選定 -> 最終返答生成` の段階型で実装した
- 初期版は `memory` アクション単体で閉じ、primary 3 / secondary 3 / 1-hop 上限と、情報不足時に推測しない返答方針を固定した

### `STEP27.md`
- LINE webhook で送信者を owner / visitor に分岐し、visitor には read-only 専用フローを追加した
- visitor は自分の会話履歴だけを使いながら、オーナーの今日の予定参照、`memory` 参照、一般質問応答だけを実行できる
- visitor の予定更新、`SOUL.md` / `USER.md` 更新、記憶更新などの mutation は固定文面で拒否し、OpenAI の profile 注入点も将来差し替え可能に整理した

### `STEP28.md`
- LINE webhook の `userId` を `people/*.md` の人物記憶へ紐づけ、未登録 visitor は owner へ LINE で即時通知して承認登録できるようにした
- owner の自然文メッセージを `register_visitor` アクションとして解釈し、人物記憶の frontmatter に LINE identity と visitor policy を保存できるようにした
- visitor 向け `list_events` / `memory` / `others` を permission review へ通し、scope 外の owner 情報は拒否またはマスクする構成へ切り替えた

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

### `STEP19.md`
- イベント開始/終了リマインダー文面を LLM 生成へ切り替え、送信対象 userId と当日の会話履歴を毎回文脈として渡す実装を追加した
- 固定の通知文面をベースにしつつ、必要なときだけ短い補足を足すシンプルな返信方針にした
- LLM 失敗時は従来の固定文面へフォールバックする安全策と、文面ヘルパーの自動テストを追加した

### `STEP20.md`
- 夜サマリー後に秘書アカウントから X へ日次サマリーを自動投稿する実装を追加した
- OAuth 1.0a の X API クライアント、X 向け専用文面生成、同日再投稿防止用の notification state 記録を追加した
- X 投稿失敗時は再試行せず、その日分だけ失敗記録を残して夜ジョブ本体は継続する構成にした

## 更新ルール

- 新しいプランを `plans/` に追加したら、この README に項目と要約を追記する
- プラン完了により `plans/` から `done/` へ移動したら、この README の該当項目も移動し、要約を最新状態に合わせて整える
- 既存プランの内容が大きく変わったら、README の要約も同じターンで更新する
- `plans/` や `done/` の実ファイルと、この README の一覧が不一致のまま作業を終えない
