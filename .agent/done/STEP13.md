# Step 13: Google Calendar event を唯一の正本として扱う

## 目的
当日タスクと当日予定の二重管理をやめ、Google Calendar event を唯一の正本として扱う。
アプリが扱う「やること」「予定」はすべて Calendar event に保存し、読み取りも編集も Calendar 起点で行う。

## 背景
- 現状は Google Drive の `tasks/YYYY-MM-DD.md` がタスク正本で、Google Calendar は同期先になっている
- さらにユーザーが手動で追加した会議や予定も Google Calendar に存在する
- そのため、AI に渡す文脈が「タスク情報」と「予定情報」に分かれ、実態としては同じ日の行動情報が二重化している
- ユーザー要望として、Calendar 上にすべての情報を集約し、AI にも予定一覧だけを渡す方針へ寄せたい

## 固定方針
- Google Calendar event を唯一の読取元・更新先にする
- Google Drive の `tasks/YYYY-MM-DD.md` は新規更新を止め、以後の判断には使わない
- kind / status は Calendar event の description 先頭に埋め込む
- description 先頭の管理メタデータ例:
  - `kind: task|schedule`
  - `status: todo|done|confirmed`
- metadata の後ろには、人間が読める補足本文を置く
- 手動作成された会議も AI が編集対象にしてよい
- 一覧表示では task と schedule を無理に分離せず、当日の行動一覧としてまとめて返す

## 今回の成功条件
- LINE入力処理時に、Google Calendar だけを読めば当日文脈がそろう
- ActionClassifier と更新用 LLM に渡す文脈が「当日予定一覧」だけになる
- `modify_tasks` は Google Drive の task ファイルではなく、Calendar event 一覧を直接更新する
- 新規作成イベントには description 先頭の `kind` / `status` metadata が入る
- 既存の手動イベントも必要に応じて AI が更新・削除できる
- 夜サマリーは task ファイルではなく、その日の Calendar event 一覧を使って生成できる

## 実装スコープ（Step 13）
1. Calendar event モデルの定義
- Google Calendar 取得イベントを、アプリ共通の当日 event モデルへ正規化する
- `description` 先頭から `kind` / `status` を読み取る
- metadata がない event は既定で `kind=schedule`、`status=confirmed` とみなす
- 補足本文は metadata を除いた description 本文として保持する

2. 更新経路の置換
- `modify_tasks` の内部実装を、task ファイル全文書き換えから「当日 Calendar event 全体の再構成」へ置き換える
- 更新用 LLM には、当日 event 一覧の最終状態を JSON で返させる
- 不変 event を残しつつ、追加・編集・削除を 1 回の差分適用で Calendar へ反映する

3. 表示経路の置換
- `list_tasks` は task ファイルではなく、当日 Calendar event 一覧を読み上げる
- task / schedule / status / 時刻を1つの一覧として自然に整形する
- 「今日のやること」系の問い合わせでも、予定を含めた当日行動一覧として返す

4. 夜サマリーの入力置換
- 夜サマリー生成の入力を task ファイルから当日 Calendar event 一覧へ切り替える
- 会話履歴と当日 event 一覧から、完了・継続・制約・示唆を要約する

5. 既存 task ファイル依存の停止
- `assistantEngine` から task ファイル読み書き依存を外す
- 必要なら Google Drive 側の task 関連関数は残してもよいが、実行経路からは外す
- README と `.agent` の説明も Calendar 正本前提に更新する

## エラー処理
- Calendar 読取失敗時は、既存方針どおり処理継続しつつ失敗を明示する
- Calendar 更新失敗時は、どの event 操作が失敗したかログへ残す
- 一部更新失敗時も LINE 返信は返し、部分失敗であることを明示する

## 受け入れテスト（最小）
1. 新規タスク追加要求で、Google Calendar に event が作成され、description 先頭に `kind` / `status` が入る
2. 既存手動イベントの編集要求で、その event が Calendar 上で更新される
3. 「今日のタスクは？」で、task ファイルではなく Calendar event 一覧ベースの返信が返る
4. 夜サマリー生成で、task ファイル未参照でも event 一覧ベースで要約できる
5. Google Drive の task ファイル更新がなくても、主要フローが成立する

## 非スコープ（Step 13時点）
- 過去日の task ファイル整理や削除
- 繰り返し予定や参加者情報の高度利用
- Calendar 以外の外部ソースとの双方向統合

## 完了後の期待効果
- 当日の行動情報が Google Calendar に一本化される
- AI に渡す文脈が単純になり、手動予定とアプリ管理タスクを同じ地平で扱える
- 二重管理によるズレや競合の説明コストが減る
