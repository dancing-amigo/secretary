# LINE専用AI秘書システム 詳細設計書（v1.1）

最終更新: 2026-03-04

## 1. 目的

LINEだけをインターフェースとして、以下を継続実行する「人間らしい秘書」を実現する。

- 毎朝: 今日やるべきタスクの提案（時刻・所要時間まで）
- 対話: ユーザー返信に応じて予定を追加/削除/更新し、最終版を表で提示
- 日中: 開始通知、終了確認、未完了または無応答への再通知（追い打ち）
- 毎晩: 実績・未完了・翌日候補のサマリ送信
- Googleカレンダー連携: 既存予定と衝突しない計画、必要に応じたイベント作成/更新
- LINE上の自然文だけで、秘書の記憶・提案方針・通知強度を柔軟に書き換え可能

## 2. 設計思想（OpenClawから取り入れる点）

注: ご依頼の「OpenCLow」は、調査上は `OpenClaw` を指す可能性が高いため、それを前提に設計へ反映する。

OpenClawの有効な考え方:

- メモリの真実はファイル（Markdown）に置く
- 短期（日次ログ）と長期（要約知識）を分離する
- セッション開始時に必須ファイルを読み、必要時だけ深掘り読みする
- メモリ検索（`memory_search`）と対象読み（`memory_get`）を使い分ける

この思想を本システムでは「階層化ファイルメモリ + エージェント判断」で実装する。

## 3. 非機能要件

- 可用性: 24/7稼働、通知遅延を最小化
- 冪等性: 同一Webhook/同一通知ジョブの重複処理防止
- 監査性: いつ何を提案/通知/更新したか追跡可能
- プライバシー: 最小権限OAuth、秘密情報分離、暗号化保管
- 拡張性: 将来のチャネル追加は可能だが、v1 UIはLINEのみ
- 可変性: ユーザーの指示で運用ルールを即時変更できること

## 4. 全体アーキテクチャ

## 4.1 コンポーネント

1. LINE Webhook API
- 受信: ユーザー発話、既読/イベント
- 送信: push/reply

2. Orchestrator API（本体）
- Webhook検証
- 会話ターン制御
- スケジュール実行トリガー
- ツール呼び出し（Calendar、FS、Queue）

3. Agent Runtime
- Planner Agent: 朝提案/再計画/夜サマリ
- Update Agent: ユーザー返信から意図抽出してタスク操作
- Reminder Agent: 通知文面と追い打ち判定

4. Memory Store（階層化ファイルシステム）
- `memory/` 以下にプロフィール、制約、履歴、日次ログを保持

5. Structured Store（RDB推奨: PostgreSQL）
- タスク、スケジュール、通知状態、ジョブ実行状態
- ファイルメモリのインデックス/参照先も保持

6. Scheduler/Queue
- 時刻実行（朝送信、開始通知、終了確認、再通知）
- 失敗時リトライ、重複排除

7. Google Calendar Connector
- FreeBusy取得
- Event作成/更新/削除

8. Adaptation Engine（ユーザー主導の自己更新）
- LINE発話を「覚える/忘れる/修正する/方針変更」に分類
- 変更パッチを生成し、ガードレール評価後に適用
- 差分履歴を保存し、必要時ロールバック

## 4.2 なぜ「完全ルールベース」ではなく「ハイブリッド」か

- 返信の意味解釈（追加/削除/優先度変更/曖昧な希望）はエージェントが担当
- ただし通知時刻実行だけは決定論エンジンで担保

理由: 提案品質はLLM依存、通知確実性はシステム依存に分離するため。

## 5. メモリ設計（ファイル階層）

```
memory/
  00_core/
    AGENT_POLICY.md              # 常時読む運用原則
    USER_PROFILE.md              # 人物像・働き方・価値観
    TIME_PREFERENCES.md          # 集中しやすい時間帯、睡眠、休憩
    TASK_ESTIMATION_RULES.md     # 見積もり癖、実測補正ルール
    COMMUNICATION_STYLE.md       # 口調、通知の強さ

  10_planning/
    GOALS_QUARTERLY.md
    GOALS_WEEKLY.md
    PRIORITY_STACK.md

  20_operations/
    SOP_MORNING.md               # 朝提案手順
    SOP_RESCHEDULE.md            # 返信時の再計画手順
    SOP_REMINDER_ESCALATION.md   # 追い打ち条件
    SOP_NIGHT_REVIEW.md          # 夜サマリ手順

  30_calendar/
    CALENDAR_INTEGRATION.md      # 連携方針
    CALENDAR_CONFLICT_POLICY.md  # 衝突時の扱い

  40_logs/
    daily/
      2026-03-04.md
      2026-03-05.md
    conversations/
      2026-03-04-thread-<id>.md

  50_knowledge/
    recurring_tasks.md
    projects/
      <project>.md

  60_adaptation/
    USER_EDITABLE_RULES.md       # ユーザーが直接上書き可能な運用方針
    MUTATION_GUARDRAILS.md       # 更新不可領域、要確認領域、危険操作
    CHANGELOG.md                 # 変更履歴（誰が/いつ/何を/なぜ）
    pending/
      <request-id>.md            # 確認待ち変更案

  MEMORY.md                      # 長期記憶の要約（厳選）
```

## 5.1 読み込み戦略（毎ターン）

1. 常時読み込み（軽量）
- `00_core/AGENT_POLICY.md`
- `00_core/USER_PROFILE.md`
- `00_core/TIME_PREFERENCES.md`
- `20_operations/SOP_*.md`（該当SOPのみ）
- `MEMORY.md`

2. 条件付き読み込み
- ユーザー返信に「新規案件」が出たら `50_knowledge/projects/*`
- 見積もり更新が必要なら `TASK_ESTIMATION_RULES.md` + 直近 `40_logs/daily/*`
- カレンダー衝突時は `30_calendar/*`

3. 深掘り探索
- まず検索（ベクトル+BM25）で候補ファイル抽出
- 次に対象ファイルのみ部分読み

## 5.2 書き込み戦略

- 日中の事実: `40_logs/daily/YYYY-MM-DD.md`
- 習慣化した事実/好み: `MEMORY.md` に昇格
- 推定作業時間の更新: `TASK_ESTIMATION_RULES.md` に反映
- 反映ルール: 「一時情報」と「長期情報」を混ぜない

## 5.3 LINEからの記憶・方針更新プロトコル（最重要）

目的:
- 「これ覚えて」「それは忘れて」「次からこうして」を、管理者操作なしで反映する

対応インテント:
- `remember`: 新しい嗜好/制約/ルールを追加
- `forget`: 既存記憶を無効化または削除
- `correct`: 既存記憶の修正
- `tune`: 通知強度・提案粒度・口調などの運用パラメータ調整
- `override_today`: 当日だけの一時ルール

変更適用フロー:
1. Update Agentが発話をインテント分類し、対象ファイル候補を特定
2. Adaptation Engineが構造化パッチを作成（`file`, `before`, `after`, `reason`）
3. ガードレール判定
4. 自動反映可（低リスク）なら即コミットし、差分要約をLINE返信
5. 要確認（高リスク）なら `pending/<request-id>.md` を作成し、LINEで承認確認
6. 承認後に適用し、`CHANGELOG.md` とDB履歴に記録

ロールバック:
- ユーザーが「さっきの変更を戻して」で直近リビジョンを復元
- ファイル実体は世代管理（オブジェクトバージョニング + revisionテーブル）

衝突解決:
1. 明示的な最新指示
2. `USER_EDITABLE_RULES.md`
3. 既存 `MEMORY.md`
4. デフォルト運用ルール

## 6. データモデル（DB）

主要テーブル:

- `users`
- `tasks`（title, status, priority, estimate_min, due_at, project_id）
- `task_schedule_blocks`（task_id, start_at, end_at, source=agent|user）
- `reminder_jobs`（block_id, type=start|end_check|nudge, scheduled_at, state）
- `message_events`（line_event_id, user_id, payload_hash, processed_at）
- `calendar_links`（task_id, gcal_event_id, sync_state）
- `daily_plan_snapshots`（date, plan_markdown, confirmed_at）
- `change_requests`（intent, risk_level, status, requested_at, applied_at）
- `memory_revisions`（file_path, revision_id, diff_summary, actor, created_at）
- `user_runtime_prefs`（notification_tone, nudge_policy, planning_depth）

原則:

- ファイルは意味記憶、DBは実行状態
- どちらか片方に寄せない（可観測性と柔軟性の両立）

## 7. エージェント構成

## 7.1 Planner Agent（朝/再計画/夜）

入力:
- 今日の未完了タスク
- 期限・優先度
- Googleカレンダーのbusy時間
- ユーザーの時間帯嗜好

出力:
- タイムブロック化した日次計画案
- 各タスクの見積もり理由
- LINE送信用テキスト + 最終確定表

## 7.2 Update Agent（返信理解）

役割:
- 自由文から意図抽出（追加/削除/延期/短縮/優先度変更）
- 不明点がある場合のみ確認質問
- 変更をDB + ファイル記憶へ反映

## 7.3 Reminder Agent（日中追跡）

役割:
- 開始通知文面生成
- 終了確認時の分岐
- 無応答/未完了の追い打ちテンプレート生成

## 7.4 Adaptation Agent（自己更新）

役割:
- ユーザーの修正要求を構造化（変更対象、影響範囲、恒久/一時）
- 変更前後差分の説明文を生成し、誤更新を防ぐ
- 反映後に再計画が必要ならPlanner Agentを自動再実行

## 8. コア業務フロー

## 8.1 朝フロー（例: 07:30 JST）

1. Scheduler起動
2. Calendar FreeBusy取得（当日）
3. Planner Agentが計画案生成
4. LINEに提案送信
5. ユーザー返信ごとにUpdate Agentが再計画
6. 「確定」合図で日次計画を固定し、表を送信
7. 通知ジョブを一括登録

## 8.2 日中フロー

- 開始時刻: 「開始してください」通知
- 終了時刻: 「終わりましたか？」確認
- 分岐:
  - 終了: タスク完了処理、実績時間記録
  - 未終了: 延長提案（例: +15分 / 再配置）
  - 無応答: 段階的リマインド

## 8.3 追い打ち（エスカレーション）

例:
- Nudge1: 終了確認+10分
- Nudge2: +30分（短い再提案付き）
- Nudge3: +90分（今日中代替枠を提示）

上限:
- 1タスクあたり最大3回
- 深夜帯は抑制（ユーザー設定準拠）

## 8.4 夜フロー（例: 21:30 JST）

- 完了/未完了/持ち越しを集計
- 明日候補を3〜7件提案
- 見積もり誤差を学習データとして更新

## 8.5 LINE自己更新フロー（新規）

例1: 「今後、午前は深い作業を入れないで」
1. `tune` として解釈
2. `TIME_PREFERENCES.md` と `USER_EDITABLE_RULES.md` を更新
3. 翌朝提案から自動反映

例2: 「そのルール間違い。忘れて」
1. `forget` として対象記憶を特定
2. 影響範囲を提示（どの提案に効くか）
3. 即時無効化して `CHANGELOG.md` 記録

例3: 「この前の変更を戻して」
1. 直近 `memory_revisions` を取得
2. 差分ロールバック
3. 変更後計画を再生成

## 9. Googleカレンダー連携

実装方針:

- 参照: `freeBusy.query` で空き時間抽出
- 反映: タスク確定時に `events.insert`/`events.update`
- 同期キー: `extendedProperties.private` に内部 `task_id` を保持

衝突ポリシー:

- ミーティング（既存busy）と重なる枠にはタスクを置かない
- イベント手動変更を検知したら再計画候補をLINEで提案

## 10. LINEインターフェース設計

- 受信はWebhookで即ACKし、重い処理は非同期化
- 署名検証を必須
- 返信種別:
  - 定型コマンド（例: 「確定」「完了」「延長15分」）
  - 自由文（Update Agentで解釈）

メッセージUX:

- 朝: 「提案 + 理由 + 変更候補」
- 確定後: 表形式（時刻/タスク/見積もり/目的）
- 日中: 短文通知 + 1タップ相当の返信誘導文
- 夜: 実績サマリ + 明日の初期案

## 10.1 ユーザー編集インターフェース（自然文）

想定発話:
- 「覚えて: ミーティング直後は30分バッファ欲しい」
- 「忘れて: 夜に重い作業を入れるルール」
- 「これからは通知をもう少し強めに」
- 「この情報は今日だけ有効で」
- 「前の変更を取り消して」

返信ポリシー:
- 変更反映時は必ず「何を変更したか」を1〜3行で明示
- 高リスク変更は必ず確認を挟む
- 反映失敗時は理由と代替案を返す（無言失敗禁止）

## 11. 実行基盤/ホスティング

推奨（v1）:

- App: Cloud Run（API + Agent Runtime）
- DB: Cloud SQL(PostgreSQL)
- Queue/Scheduler: Cloud Tasks + Cloud Scheduler
- Memory files: Cloud Storage（バージョニング有効）
- 検索インデックス: pgvector または軽量ローカル索引

代替:

- Fly.io + Volume + Postgres
- VPS（Docker Compose）

選定理由:
- 定時実行とWebhook常時待受が必要
- 通知再送、遅延実行、監視をマネージド化しやすい

## 12. セキュリティ

- LINE webhook signature 検証
- OAuthトークンはSecret Manager保管
- 最小スコープ（Calendar readonly + events更新）
- PIIを含むログはマスキング
- ファイル記憶の暗号化（at-rest）とアクセス制御
- 変更可能範囲の制限（`MUTATION_GUARDRAILS.md` で強制）
- システム安全方針ファイルはユーザー指示でも直接上書きしない

## 13. 障害時設計

- Webhook重複: `line_event_id` で冪等制御
- 通知失敗: 指数バックオフ再試行 + dead-letter
- LLM失敗: フォールバック文面で最低限通知
- Calendar API失敗: 当該ターンは「暫定計画」で提示し復旧後再同期

## 14. 観測性

- メトリクス:
  - 通知成功率
  - 応答遅延
  - 無応答率
  - タスク完了率
  - 見積もり誤差(MAPE)
  - ユーザー修正反映率（手戻りの少なさ）
  - 修正要求から反映までの時間
- 監査ログ:
  - どのファイルを読んだか
  - どの根拠で提案したか
  - どの変更要求をどう適用/却下したか

## 15. MVPスコープ（最短）

- 朝提案
- 返信で再計画
- 確定表送信
- 開始通知/終了確認/再通知（最大2回）
- 夜サマリ
- Googleカレンダー参照 + タスクイベント作成
- ファイル階層メモリ + `MEMORY.md` 昇格処理
- LINE自然文による `remember/forget/correct/tune` 反映
- 直近変更のロールバック

## 16. 段階リリース

- Phase 1（2〜3週）: MVP
- Phase 2（+2週）: 見積もり学習、追い打ち最適化
- Phase 3（+2週）: プロジェクト別計画戦略、週次レビュー自動化

## 17. OpenClaw調査要点（設計への反映）

- メモリはMarkdownがソースオブトゥルース
- `memory/YYYY-MM-DD.md` と `MEMORY.md` の2層構造
- セッション/キュー/リトライを分離して運用

本設計ではこれを「LINE秘書運用」に合わせて拡張し、
- 2層を5層以上に分解（core/planning/operations/calendar/logs）
- ただし昇格先は `MEMORY.md` に統一
- 通知実行はQueue/Schedulerに切り出して信頼性を確保

## 18. 参考資料（一次情報）

- OpenClaw Memory: https://docs.openclaw.ai/concepts/memory
- OpenClaw Agent Workspace: https://docs.openclaw.ai/concepts/agent-workspace
- OpenClaw Session Management: https://docs.openclaw.ai/concepts/session
- OpenClaw Command Queue: https://docs.openclaw.ai/concepts/queue
- OpenClaw Retry Policy: https://docs.openclaw.ai/concepts/retry
- LINE Webhook Signature Verification: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- LINE Messaging API Reference: https://developers.line.biz/en/reference/messaging-api/nojs/
- Google Calendar FreeBusy API: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google Calendar Events Update API: https://developers.google.com/calendar/api/v3/reference/events/update
- Google Calendar Create Events Guide: https://developers.google.com/workspace/calendar/api/guides/create-events
- Google Calendar Extended Properties: https://developers.google.com/workspace/calendar/api/guides/extended-properties
