# Agent Workspace Notes

- プロジェクト固有の作業メモと計画は `.agent/` を参照すること。
- 作業開始時は、まず `.agent/README.md` を読んで `plans/` と `done/` の一覧・要約を把握すること。
- 実行計画は `.agent/plans/` 配下の Markdown ファイルを優先的に確認すること。
- 完了したプランの Markdown ファイルは `.agent/done/` に移動すること。
- プラン完了時の `.agent/plans/` から `.agent/done/` への移動は、常にエージェントが自分で実行すること。
- 新しいプランを `.agent/plans/` に追加したときは、必ず `.agent/README.md` に要約付きで追記すること。
- プランを `.agent/plans/` から `.agent/done/` に移動したときは、必ず `.agent/README.md` の一覧も同じターンで更新すること。
- `.agent/plans/` または `.agent/done/` の内容を変更した場合、必要に応じて `.agent/README.md` の要約も最新化すること。
- コードを変更した場合は、タスク完了時に変更前のコードで不要になった部分が残っていないか再確認し、不要な実装を削除すること。必要に応じて関連箇所やコードベース全体の整合性を保つリファクタリングも行うこと。
