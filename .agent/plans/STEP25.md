# STEP25

## 目的

`03:00` close ジョブに memory 更新を追加する。  
入力は前日分の `record/timeline/days/YYYY-MM-DD.md` のみとし、日次ログ保存と X 投稿試行の後に 1 日 1 回だけ memory を更新する。  
更新対象は Google Drive 上の `memory/` 配下で、既存ノード更新、新規ノード作成、`node-registry.yaml` 更新、必要な双方向リンク更新まで含める。

## 実装内容

1. `runCloseJob` の処理順を `prepareDailyClose -> X 投稿試行 -> memory 更新 -> close 完了記録` に固定し、`summaryDateKey` の日次ログを memory 更新の唯一の入力にする。
2. memory 更新専用サービスを追加し、`daily log 読み込み -> 更新計画生成 -> 必要ノード読取 -> 本文生成 -> Drive 反映 -> registry/index 更新 -> 実行結果返却` の流れを独立させる。
3. 更新計画は LLM の structured output で行い、`noChangesReason`、`updateNodeIds`、`createNodes`、`links` を持つ JSON スキーマを定義する。
4. `createNodes` の新規ノード種別は `person | place | object | organization | event | knowledge | skill | concept` に限定し、path はアプリ側で `type -> folder` マップから決定する。
5. frontmatter の `id`、`type`、`name`、`description`、`aliases`、`links` はアプリ側で決定的に更新し、LLM には本文全文のみを生成させる。既存 node の `id` と path は変えず、削除も行わない。
6. planner が返した `links` と `relatedNodeIds` を元に、対象ノードと相手ノードの frontmatter.links を重複なく双方向更新する。既存 registry にない id は無視して警告ログを残す。
7. `node-registry.yaml` はアプリ側で parse / merge / 書き戻しを行い、新規ノード作成時は `id`、`type`、`path`、`name`、`description`、`aliases` を追加し、既存ノード更新時も整合性を保つ。
8. `memory/index.md` は全面再生成せず、`## Recent Updates` セクション先頭の同日 1 行だけを追加または置換する。
9. Google Drive I/O を拡張し、`memory/` 配下の任意相対 path と `record/timeline/days/YYYY-MM-DD.md` を read/write できる helper を追加する。
10. close notification state に `memoryUpdateAttemptedAt`、`memoryUpdateStatus`、`memoryUpdateCompletedAt`、`memoryUpdateFailedAt`、`memoryUpdateError`、`memoryUpdatedNodeIds`、`memoryCreatedNodeIds`、`memoryUpdateSourcePath` を追加する。失敗時も close 全体は落とさず、Vercel log と state にだけ残す。
11. 将来 Step では memory 更新と同じ close 経路で scope registry と scope 付与/剥奪も扱えるようにするが、この Step では scope の作成・変更・剥奪までは含めない。Step30 で `memory/scopes.yaml` と `scopeOps` を導入できるよう、memory 更新サービスの責務は分離しておく。
12. 不要になった互換コード、使われなくなった補助関数、旧前提のテストケースは実装完了時に必ず削除する。

## 完了条件

1. `03:00` close ジョブが前日分 daily log を入力にして memory 更新を 1 回だけ試行する。
2. memory 更新は既存ノード更新、新規ノード作成、`node-registry.yaml` 更新、双方向リンク更新を行える。
3. `memory/index.md` は `Recent Updates` の同日 1 行だけが更新され、他セクションは崩さない。
4. memory 更新失敗時も日次ログ保存と X 投稿試行の結果を優先し、close ジョブ本体は継続する。
5. close notification state と Vercel log に memory 更新の成功 / no_changes / failed が記録される。
6. `npm test` が通る。
7. Step30 で scope 更新を追加できるよう、memory 更新サービスの責務境界が保たれている。
8. 実装後、不要なコードと不要なテストが残っていない。
