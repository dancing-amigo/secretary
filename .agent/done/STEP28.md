# STEP28

## 目的

Step27 で導入した `owner` / `visitor` 分離を前提に、visitor へ返す read-only 情報を「誰が送ってきたか」と「その人にどこまで見せてよいか」に基づいて制限できるようにする。  
対象はまず LINE のみとし、LINE webhook で取得できる `source.userId` を memory 内の人物記憶 `people/*.md` と紐づけ、オーナーが人物記憶側で定義した役割・関係性・閲覧範囲をもとに、返答前の最終審査で情報公開可否を判定する。  
初期実装では Step27 の read 取得経路を大きく崩さず、「候補情報は一度集めるが、最終的にその visitor に見せてよい情報だけへ落とす」構成を採る。visitor の人物紐付けは完全自動推定ではなく、未登録 visitor を検知したら owner へ LINE で即時通知し、owner の自然文メッセージを LLM が `register_visitor` アクションとして解釈して承認登録する運用を前提にする。

## 実装内容

1. LINE visitor を memory の人物記憶へ対応付けるため、`people/*.md` の frontmatter に `identities.lineUserIds` を追加できる前提を定める。1 人が複数 LINE ID を持てる形は許容するが、初期版は 1 `lineUserId` -> 1 person node を一意に引けることを優先する。
2. 同じ人物記憶の frontmatter に、オーナー基準で定義する権限情報を保持する。最低でも `role`、`relationshipToOwner`、`allowedScopes` を持てる形にし、必要なら将来 `deniedScopes` を足せる構造にしておく。初期版は frontmatter 正本で統一し、本文側に同種の設定は持たせない。
3. `allowedScopes` は初期版では粗い単位でよく、たとえば `owner.today_agenda.basic`、`owner.today_agenda.detail`、`owner.memory.people`、`owner.memory.projects`、`owner.memory.general` のような read scope を定義する。未指定時は allow ではなく deny 扱いを基本にする。
4. visitor ルーティングの早い段階で、送信者 `userId` から対応する人物記憶を引く resolver を追加する。resolver は `people/*.md` の frontmatter を読んで `lineUserId` 一致を探し、結果を `registered visitor` / `unregistered visitor` / `ambiguous visitor` のいずれかへ正規化して後続処理へ渡す。初期版では `node-registry.yaml` を正本にせず、人物ノード側のみを正本とする。
5. resolver は毎回 memory を参照してもよいが、同一プロセス内では `lineUserId -> personId` の軽いキャッシュを持てる構造にしてよい。ただし source of truth は常に `people/*.md` とし、キャッシュ不整合時は markdown 再読込が勝つ前提にする。
6. 未登録 visitor を受けた場合、visitor 向けには owner 情報を返さず、「まだ案内可能な情報が設定されていない」旨の安全な拒否文面を返す。同時に owner へ LINE で即時通知し、`lineUserId`、最新メッセージ、必要なら LINE profile 由来の `displayName` を添えて「誰として登録するか」を確認できるようにする。
7. owner 向けには新しい専用アクション `register_visitor` を追加する。これは `modify_events` や `memory` と同列の owner-only mutation とし、owner の自然文メッセージを ActionClassifier がこのアクションへ分類する。固定コマンドは要求せず、たとえば「さっきの人は山本圭亮として登録して」「この userId は圭亮で、予定は概要だけ見せて」のような自然文を LLM が解釈する前提にする。
8. `register_visitor` の更新対象は `people/*.md` の frontmatter のみとし、少なくとも `identities.lineUserIds`、`role`、`relationshipToOwner`、`allowedScopes` を安全に設定または更新できるようにする。初回登録時は person の特定、既存 `lineUserId` 重複の検知、同名候補の曖昧さ解消を必須にする。
9. owner の登録依頼が曖昧な場合は `register_visitor` を失敗させず、owner に追加確認を返す。たとえば person 候補が複数ある、対象 visitor が特定できない、scope 指定が不足している場合は、その不足点だけを簡潔に聞き返す。
10. Step27 の `list_events` / `memory` / `others` は初期版では従来どおり owner 側 read-only 情報を材料として候補返答を作ってよいが、そのまま返さず、返答前に必ず permission review を通す。
11. permission review 用に、新しい LLM reviewer を追加する。入力には、`visitor` の人物記憶要約、`role` / `relationshipToOwner` / `allowedScopes`、候補返答、参照した owner 情報の要約、今回の user request を渡し、「この visitor に見せてよい内容だけ残して自然な最終返答へ書き直す」ことを担当させる。
12. reviewer は単なる文面調整ではなく、`allow` / `redact` / `deny` の判断主体として扱う。許可されない具体情報は削除または抽象化し、依頼全体が不可なら「その情報は案内できない」と返す。実行したふりや、存在を断定しすぎる漏洩は避ける。
13. `memory` アクションでは、どの memory node を参照したか、少なくともどの種類の owner 情報を使ったかを reviewer へ渡せるようにする。初期版では node 本文全体の厳密フィルタではなく、候補返答と参照ノード要約の審査で始めてよい。
14. `list_events` は reviewer の判定結果に応じて、予定そのものを出せる場合でもタイトルだけ、時間だけ、詳細なし、あるいは全面拒否にできるようにする。オーナーの予定を返す場合も、visitor の権限に応じて粒度を落とせることを前提にする。
15. `others` は一般質問経路として残すが、owner 固有情報に依拠する場合は reviewer を必須にする。owner 情報を使わずに完結する一般知識や雑談まで過度に拒否しない。
16. owner 自身は従来どおりフル権限のため Step28 の reviewer 対象外とし、既存 owner フローの挙動は変えない。今回の変更は visitor read-only フローと owner の `register_visitor` アクション追加に限定する。
17. 実装では、人物解決結果、登録判定、適用 scope、reviewer の判断結果をサーバーログで追えるようにしつつ、秘匿情報そのものはログへ出しすぎないようにする。未登録 visitor 通知では `lineUserId` をそのまま owner に見せてよいが、一般ログには必要以上の本文や owner 情報を残さない。
18. テストは、少なくとも以下を追加・更新する。
   - LINE `userId` と `people/*.md` の対応解決
   - 未登録 visitor が安全文面を受け取り、owner へ通知が飛ぶこと
   - owner の自然文承認が `register_visitor` に分類され、対象 person へ `lineUserId` と scope が保存されること
   - 登録済み visitor が許可 scope 内の予定/記憶だけ受け取れること
   - 同じ visitor が scope 外の detail を求めたとき redact または deny されること
   - 同じ `lineUserId` を別 person へ重複登録できないこと
   - owner フローに review 制限がかからず既存動作が非退行であること
19. 初期版の非目標も明示する。memory の探索段階でノードごとに厳密 deny する仕組み、LINE displayName からの自動確定登録、owner 以外による visitor 権限変更まではこの Step では必須にせず、まずは「未登録検知 -> owner 承認登録 -> 候補生成 -> 最終審査」の境界を成立させることを優先する。

## 完了条件

1. LINE visitor の `userId` から、対応する `people/*.md` の人物記憶を解決できる。未登録や曖昧一致も明示的に扱える。
2. 未登録 visitor が来たとき、visitor には owner 情報を返さず、owner には LINE で即時通知が届く。
3. owner は自然文メッセージ経由で `register_visitor` を実行でき、対象 person へ `lineUserId` と role・関係性・閲覧可能範囲を登録できる。
4. visitor 向け `list_events` / `memory` / `others` の返答は、候補生成後に permission review を通らなければ外へ出ない。
5. 許可されていない owner 情報は、返答から除去、抽象化、または拒否される。
6. 同じ `lineUserId` の重複登録や曖昧な人物紐付けは安全に拒否または再確認される。
7. owner 向け既存フローの権限、会話履歴、scheduler 系挙動は壊れない。
8. reviewer を後から差し替えたり、retrieval 側 filter を追加したりできるよう、人物解決・承認登録・権限定義・最終審査の境界がコード上で分かれている。
9. `npm test` が通る。
