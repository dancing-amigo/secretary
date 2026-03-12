# STEP27

## 目的

LINE 公式アカウントへオーナー以外のユーザーがメッセージを送ったとき、オーナー本人向けのフル権限フローとは分離した read-only 応答ルートで処理できるようにする。  
今回の Step では、非オーナーはオーナーの「今日の予定」と `memory` を使った知識参照、および一般質問への応答までは行えるようにする一方、Google Calendar 更新、`SOUL.md` / `USER.md` 更新、将来の memory 更新のような mutation は一切実行できないようにする。  
次の権限設定 Step で情報公開範囲を細かく絞れるよう、送信者の識別、処理ルート、実行主体の分離を先に設計へ入れる。

## 実装内容

1. LINE webhook の受信処理で、送信者 `userId` が `LINE_DEFAULT_USER_ID` と一致するかどうかを判定し、`owner` と `visitor` の 2 系統へ分岐する routing 層を追加する。
2. 既存の `processUserMessage` 相当のフル権限フローは `owner` 専用として維持し、非オーナーは別の `visitor` 向け関数で処理する構造へ整理する。
3. `visitor` フローでは、会話主体と情報主体を分離し、会話履歴は送信者本人の `userId` で読み書きしつつ、参照対象の予定や memory はオーナー側の read-only 情報として扱う。
4. `visitor` 用 action 判定は、既存の `modify_events` / `edit_soul` / `edit_user` を含む分類器とは分け、`list_events` / `memory` / `others` / `forbidden_action` のような read-only 専用候補へ絞る。
5. 非オーナーが予定追加、予定変更、完了操作、`SOUL.md` 更新、`USER.md` 更新、記憶の保存や変更など mutation 系を依頼した場合は、実行したふりをせず、「その操作はできない」と自然な日本語で返す拒否経路を追加する。
6. 非オーナーの `list_events` は、オーナーの当日予定を read-only で返す。返答文面は「このアカウントのオーナーの予定」であることが分かる形に調整する。
7. 非オーナーの `memory` は既存 memory agent を再利用するが、会話文脈にはオーナーとの private 会話履歴を混ぜず、送信者本人との会話履歴だけを使う。
8. 非オーナーの `others` は一般質問、雑談、確認依頼に使い、read-only 範囲で答えられる内容だけを返す。別アクションが必要なことを実行したふりはしない。
9. 今回の Step では、非オーナーへの read 公開範囲は「現行 owner 向け AI が参照している read-only 情報を mirror する」前提にする。ただしオーナーとの過去会話履歴は共有しない。
10. 次の権限設定 Step で公開範囲や返答ポリシーを差し替えやすくするため、LLM へ注入する owner 情報と sender 情報の境界を整理し、呼び出し側から制御できる差し込み点を用意する。
11. テストは、owner と visitor の routing、visitor の read-only action 分類、禁止アクション拒否、visitor 会話履歴の分離、owner 側既存動作の非退行を検証できる形へ追加・更新する。
12. 実装完了時には、owner 前提でしか使えない命名や境界が不要に残っていないか見直し、将来の権限設定実装を阻害する暫定ロジックがあれば整理する。

## 完了条件

1. LINE 送信者が owner か visitor かで処理ルートが分かれる。
2. owner は従来どおり予定更新、一覧取得、`SOUL.md` / `USER.md` 更新、`memory` 参照、その他応答を使える。
3. visitor はオーナーの今日の予定参照、`memory` 参照、一般質問応答だけを使え、mutation 系は実行できない。
4. visitor の mutation 系依頼では、実行したふりをせず、操作不可であることを自然に返す。
5. visitor の返答生成では、送信者本人の会話履歴は使えても、オーナーとの private 会話履歴は混ざらない。
6. owner 向け既存フロー、scheduler、reminder、close/morning job の前提が壊れていない。
7. 今後の権限設定 Step で、公開範囲と実行可否を差し替えやすい構造になっている。
8. `npm test` が通る。
