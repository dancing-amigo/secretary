# STEP24

## 目的

`03:00` close ジョブが notification state に持っている `summaryContextText` を廃止し、  
朝メッセージ生成と X 投稿生成が `record/timeline/days/YYYY-MM-DD.md` の日次 Markdown を直接参照する構成へ寄せる。  
人間向けログと後続ジョブ向け入力を二重管理せず、日次記録を唯一の close 成果物にする。

## 実装内容

1. close ジョブから `summaryContextText` / `summaryGeneratedAt` / `summarySource` への依存を整理し、notification state には重複防止や実行状態に必要な最小情報だけを残す。
2. Google Drive 上の `record/timeline/days/YYYY-MM-DD.md` を読み出すヘルパーを追加し、朝ジョブと X 投稿生成が前日分の日次 Markdown を直接入力に使うよう変更する。
3. 朝メッセージ生成プロンプトと X 投稿生成プロンプトの入力名・説明を、内部サマリー前提から日次ログ前提へ更新する。
4. `prepareDailyClose` の返り値、notification state の保存項目、関連 README / `.agent` 文書を新しい責務に合わせて整理する。
5. `summaryContextText` 前提のテストを置き換え、close -> daily log -> morning / X の参照経路を自動テストで担保する。
6. 内部サマリー廃止後に不要になる関数、state 項目、分岐、互換コード、旧前提のテストファイル/テストケースを必ず洗い出して削除し、置き換えだけで古い実装を残さない。

## 完了条件

1. `03:00` close ジョブ完了後、notification state に `summaryContextText` が保存されない。
2. `08:00` 朝ジョブは前日分の `record/timeline/days/YYYY-MM-DD.md` を読んで文面生成できる。
3. X 投稿生成は前日分の `record/timeline/days/YYYY-MM-DD.md` を読んで文面生成できる。
4. 日次ログが存在すれば、朝ジョブと X 投稿は close record 内の内部サマリーに依存しない。
5. `summaryContextText`、`summaryGeneratedAt`、`summarySource` など内部サマリー前提でしか使われないコードとテストがコードベースから除去されている。
6. `npm test` が通る。
