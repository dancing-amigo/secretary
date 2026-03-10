# Step 18: event ID 付与責務をアプリ側へ戻す

## 目的
`modify_events` で新規 event を追加・更新する際の ID 不整合を解消し、LLM が event ID を直接生成・選択しない設計へ改める。

## 背景
- 現状はアプリが `draft-event-*` の候補を事前生成し、LLM にその中から選ばせている
- 実運用では LLM が候補外の ID を返すことがあり、ローカル検証で `新規 event の id が許可された候補に含まれていません。` となって更新全体が失敗する
- この失敗は Google Calendar API の都合ではなく、LLM に識別子の厳密一致まで担わせている境界設計の問題である

## 固定方針
- 既存 event の識別には引き続き既存の `eventId` を使う
- 新規 event については、LLM に stable な ID を選ばせない
- LLM には「既存 event の参照」か「新規 event」であることだけを返させ、アプリ側で必要数に応じて ID を後付けする
- 新規 event 件数の上限は事前候補数ではなく、モデル出力配列の件数で自然に決まるようにする
- LLM の出力揺れを抑えるため、schema とプロンプトを「既存 eventId は必須、新規は空でよい」方向へ寄せる

## 実装スコープ
1. `assistantEngine` の event rewrite schema / prompt / normalization を見直す
2. 新規 event をアプリ側で採番するロジックを追加する
3. `googleCalendarSync` の許可 ID 前提を簡素化し、新規 create 判定をアプリ側採番済みデータ前提に寄せる
4. この境界に対する最小限の自動テストを追加する

## 成功条件
- 新規予定を複数追加しても、事前候補不足や表記揺れで失敗しない
- 既存予定の更新・削除は従来どおり `eventId` を維持して扱える
- LLM が候補外 ID を返した場合でも、既存 event のなりすまし以外では落ちずに処理継続できる
- `.agent/README.md` の索引が今回のプランを反映している
