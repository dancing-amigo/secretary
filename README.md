# LINE Secretary MVP

LINEだけで使えるAI秘書MVPです。以下を実装しています。

- 朝の自動プラン提案
- LINE返信でタスク追加/削除/計画確定
- 開始通知・終了確認・再通知
- 夜のレビュー通知
- LINE自然文で記憶の `remember/forget/tune/rollback`
- ファイルベースメモリ + 変更履歴

## 1. セットアップ

```bash
npm install
cp .env.example .env
```

`.env` の必須:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

任意:

- `LINE_DEFAULT_USER_ID`（先にpush先を固定したい場合）
- `OPENAI_API_KEY`（意図解析をLLM強化）
- `GCAL_ENABLED=true` + `GCAL_ACCESS_TOKEN`（Google Calendar FreeBusy/イベント作成）

## 2. 起動

```bash
npm run dev
```

- Health check: `GET /health`
- LINE webhook endpoint: `POST /webhook/line`
- Local test endpoint: `POST /internal/chat` with JSON `{ \"userId\": \"U_demo\", \"text\": \"今日の計画\" }`

## 3. LINEで使うコマンド/自然文例

- `タスク追加: 提案書作成`
- `削除: 提案書作成`
- `今日の計画` / `今日やること`
- `確定`
- `完了` / `未完了`
- `延長15分`
- `覚えて: ミーティング直後は30分バッファ欲しい`
- `忘れて: 夜に重い作業を入れる`
- `これからは通知を強めにして`
- `前の変更を取り消して`
- `承認 cr_xxxxx`（高リスク変更の承認）

## 4. データ保存場所

- 実行状態: `data/state.json`
- 長期記憶: `memory/MEMORY.md`
- 編集可能ルール: `memory/60_adaptation/USER_EDITABLE_RULES.md`
- 変更履歴: `memory/60_adaptation/CHANGELOG.md`
- 会話/日次ログ: `memory/40_logs/`

## 5. スケジューラ

`.env` のcronで調整できます。

- `MORNING_PLAN_CRON`（既定 07:30）
- `NIGHT_REVIEW_CRON`（既定 21:30）
- `REMINDER_TICK_CRON`（既定 1分ごと）

## 6. 注意

- 本MVPは単一ユーザー寄りです。
- 承認付き変更（pending承認）は簡易プレースホルダ実装です。
- Google CalendarはOAuthトークン管理を本番向けに強化してください。
