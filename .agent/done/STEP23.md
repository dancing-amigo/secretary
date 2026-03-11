# STEP23

## 目的

`03:00` close ジョブが保存する日次記録を、Google Drive 直下の単一 `log.md` から `record/timeline/days/YYYY-MM-DD.md` の日別ファイルへ移す。  
記録内容も短い要約ではなく、後から追える詳細ログとして `## 今日の予定` と `## ノート` の2部構成で残す。

## 実装内容

1. Google Drive の多段フォルダを必要に応じて自動作成し、`record/timeline/days/YYYY-MM-DD.md` に Markdown を保存する実装へ切り替えた。
2. close ジョブの日次記録フォーマットを `# 日付`、`## 今日の予定`、`## ノート` に再設計し、予定詳細と会話由来の補足をできるだけ保持するようにした。
3. LLM の close summary スキーマを `notes` と `eventNotes` に拡張し、event ごとの補足事情と汎用ノートを分けて抽出できるようにした。
4. 日次記録から `カレンダー同期失敗` のような内部エラー文言を除去し、障害情報は state とサーバーログのみに残すようにした。
5. notification state の日次記録保存済みキーを `recordUpdatedAt` に改め、既存 `logUpdatedAt` は互換読み取りだけ残すようにした。
6. README とテストを新しい保存先と記録フォーマットに合わせて更新した。

## 完了条件

1. `03:00` close ジョブが `record/timeline/days/YYYY-MM-DD.md` を更新し、`log.md` を使わない。
2. Google Drive 上で `record` / `timeline` / `days` が未作成でも自動で作成される。
3. 日次ファイルが `## 今日の予定` と `## ノート` の2部構成で、要約ではなく詳細ログとして読める。
4. `カレンダー同期失敗` などの内部エラーが日次ファイル本文に出ない。
5. 朝メッセージと X 投稿は従来どおり close record の `summaryContextText` を参照できる。
