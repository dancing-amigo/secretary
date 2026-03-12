# STEP28

## 目的

Step27 で導入した `owner` / `visitor` 分離を前提に、visitor へ返す read-only 情報を「誰が送ってきたか」と「その人にどこまで見せてよいか」に基づいて制限できるようにする。  
対象はまず LINE のみとし、LINE の `userId` を memory 内の人物記憶 `People/*.md` と紐づけ、オーナーが人物記憶側で定義した役割・関係性・閲覧範囲をもとに、返答前の最終審査で情報公開可否を判定する。  
初期実装では Step27 の read 取得経路を大きく崩さず、「候補情報は一度集めるが、最終的にその visitor に見せてよい情報だけへ落とす」構成を採る。

## 実装内容

1. LINE visitor を memory の人物記憶へ対応付けるため、`People/*.md` の frontmatter へ `identities.lineUserIds` のような構造化フィールドを追加できる前提を定める。1 人が複数 LINE ID を持てる形でもよいが、初期版は 1 visitor -> 1 person node を一意に引ける方針を優先する。
2. 同じ人物記憶の frontmatter か本文内の構造化セクションに、オーナー基準で定義する権限情報を保持する。最低でも `role`、`relationshipToOwner`、`accessPolicy`、`allowedScopes`、必要なら `deniedScopes` を表せる形にする。
3. `allowedScopes` は初期版では粗い単位でよく、たとえば `owner.today_agenda.basic`、`owner.today_agenda.detail`、`owner.memory.people`、`owner.memory.projects`、`owner.memory.general` のような read scope を定義する。未指定時は allow ではなく deny 扱いを基本にする。
4. visitor ルーティングの早い段階で、送信者 `userId` から対応する人物記憶を引く resolver を追加する。結果は `registered visitor` / `unregistered visitor` / `ambiguous visitor` のいずれかへ正規化し、後続処理へ渡す。
5. Step27 の `list_events` / `memory` / `others` は初期版では従来どおり owner 側 read-only 情報を材料として候補返答を作ってよいが、そのまま返さず、返答前に必ず permission review を通す。
6. permission review 用に、新しい LLM reviewer を追加する。入力には、`visitor` の人物記憶要約、`role` / `relationshipToOwner` / `allowedScopes`、候補返答、参照した owner 情報の要約、今回の user request を渡し、「この visitor に見せてよい内容だけ残して自然な最終返答へ書き直す」ことを担当させる。
7. reviewer は単なる文面調整ではなく、`allow` / `redact` / `deny` の判断主体として扱う。許可されない具体情報は削除または抽象化し、依頼全体が不可なら「その情報は案内できない」と返す。実行したふりや、存在を断定しすぎる漏洩は避ける。
8. `memory` アクションでは、どの memory node を参照したか、少なくともどの種類の owner 情報を使ったかを reviewer へ渡せるようにする。初期版では node 本文全体の厳密フィルタではなく、候補返答と参照ノード要約の審査で始めてよい。
9. `list_events` は reviewer の判定結果に応じて、予定そのものを出せる場合でもタイトルだけ、時間だけ、詳細なし、あるいは全面拒否にできるようにする。オーナーの予定を返す場合も、visitor の権限に応じて粒度を落とせることを前提にする。
10. `others` は一般質問経路として残すが、owner 固有情報に依拠する場合は reviewer を必須にする。owner 情報を使わずに完結する一般知識や雑談まで過度に拒否しない。
11. `unregistered visitor` または権限定義がない visitor には、owner に紐づく情報を原則返さない。初期版は「まだ案内可能な情報が設定されていない」旨の安全な拒否文面でよい。
12. owner 自身は従来どおりフル権限のため Step28 の reviewer 対象外とし、既存 owner フローの挙動は変えない。今回の変更は visitor read-only フローに限定する。
13. 実装では、人物解決結果、適用 scope、reviewer の判断結果をサーバーログで追えるようにしつつ、秘匿情報そのものはログへ出しすぎないようにする。
14. テストは、少なくとも以下を追加・更新する。
   - LINE userId と `People/*.md` の対応解決
   - 登録済み visitor が許可 scope 内の予定/記憶だけ受け取れること
   - 同じ visitor が scope 外の detail を求めたとき redact または deny されること
   - 未登録 visitor が owner 情報へアクセスできないこと
   - owner フローに review 制限がかからず既存動作が非退行であること
15. 初期版の非目標も明示する。memory の探索段階でノードごとに厳密 deny する仕組みまではこの Step では必須にせず、まずは「候補生成 -> 最終審査」の境界を成立させることを優先する。将来 Step では retrieval 時点の pre-filter へ発展できる構造にする。

## 完了条件

1. LINE visitor の `userId` から、対応する `People/*.md` の人物記憶を解決できる。未登録や曖昧一致も明示的に扱える。
2. 人物記憶側に、その visitor の role・関係性・閲覧可能範囲をオーナーが定義できる。
3. visitor 向け `list_events` / `memory` / `others` の返答は、候補生成後に permission review を通らなければ外へ出ない。
4. 許可されていない owner 情報は、返答から除去、抽象化、または拒否される。
5. 未登録 visitor には owner に紐づく予定や memory を返さない。
6. owner 向け既存フローの権限、会話履歴、scheduler 系挙動は壊れない。
7. reviewer を後から差し替えたり、retrieval 側 filter を追加したりできるよう、人物解決・権限定義・最終審査の境界がコード上で分かれている。
8. `npm test` が通る。
