# STEP30

## 目的

scope の正本をコード内固定値から Google Drive 上の `memory/` へ移し、AI が `03:00` close 時の memory 更新と同時に scope を作成・更新・付与・剥奪できるようにする。  
初期版では owner の明示操作は作らず、scope 変更は close memory 更新の一部としてのみ自動適用する。  
scope 名は長い文字列ラベルではなく `id` を正本にし、person / organization の閲覧権限と各 memory node の所属 scope をその `id` 参照で管理する。

## 実装内容

1. `memory/scopes.yaml` を追加し、scope registry の唯一の正本にする。最低でも `scopes` 配列と `systemBindings` を持てる形にし、各 scope は `id`、`name`、`description`、`status`、`createdAt`、`updatedAt` を持つ。
2. `systemBindings` には、コードが参照するシステム scope の ID を置く。少なくとも `ownerTodayAgendaBasicScopeId` と `ownerTodayAgendaDetailScopeId` を持たせ、agenda source は literal 文字列ではなくここから解決する。
3. person node と organization node の frontmatter に `scopePolicy.allowedScopeIds` を持たせる。既存の `allowedScopes` は移行対象とし、最終的な正本は `id` 配列に寄せる。
4. 各 memory node の frontmatter には `access.scopeIds` を持たせる。node 本文や description による暗黙推論ではなく、registry に存在する scope ID のみ有効扱いにする。
5. close memory 更新 planner の structured output に `scopeOps` を追加する。対象 op は `create_scope`、`update_scope`、`deprecate_scope`、`attach_scope_to_node`、`detach_scope_from_node`、`grant_scope_to_subject`、`revoke_scope_from_subject` に限定する。subject は初期版では `person | organization` のみとする。
6. `scopeOps` は memory node 更新と同じ close transaction 内で app 側が決定的に適用する。適用順は `scopes.yaml` 更新 -> node `access.scopeIds` 更新 -> subject `scopePolicy.allowedScopeIds` 更新に固定する。
7. scope の削除は物理削除ではなく `deprecated` 化に統一する。`systemBindings` で参照中の scope は deprecate 不可とし、参照が残る deprecated scope は registry に残す。
8. permission review と visitor resolver は `memory/scopes.yaml` を読み、未知 scope ID や deprecated scope ID の扱いを app 側で正規化する。未知 ID は deny 扱い、deprecated は既存参照の読取りだけ許可し、新規付与先としては使わせない。
9. Step28 で入れた `register_visitor` は人物紐付けだけに責務を絞り、scope 変更は行わない。scope 変更は close memory 更新に一本化する。
10. close notification state とログに `scopeOpsApplied`、`scopeIdsCreated`、`scopeIdsUpdated`、`scopeIdsDeprecated`、`scopeAssignmentsChanged` を追加し、close 本体失敗とは分離して追えるようにする。
11. 既存データ移行方針を定める。`scopePolicy.allowedScopes` / `access.scopes` が残っている場合は、初期移行時に `allowedScopeIds` / `scopeIds` へ吸い上げ、以後は新フィールドだけを書き戻す。

## 完了条件

1. `memory/scopes.yaml` が scope registry の唯一の正本として読める。
2. agenda basic / detail を含むシステム scope が `systemBindings` 経由で解決される。
3. close memory 更新が `scopeOps` を返し、scope の作成・更新・付与・剥奪を自動適用できる。
4. person と organization の権限は `scopePolicy.allowedScopeIds`、memory node の所属は `access.scopeIds` で管理される。
5. permission review は未知 scope ID を deny 扱いし、registry と frontmatter の不整合を安全に扱える。
6. `npm test` が通る。

