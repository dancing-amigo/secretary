# STEP29

## 目的

`03:00` close ジョブで作る daily log の入力に、Google Drive `record/audio` 配下の前日分 audio transcript `.txt` を追加する。  
この入力は将来の音声ファイル対応を見越して `audio processor` という前段責務で扱い、processor は transcript 内の内容が「ユーザー本人の行動、会話、考え、記憶更新に役立つ情報か」を文脈つきで判定して整理する。  
daily log 作成エージェントは従来の会話履歴と Calendar event に加えて、この processor 出力を受け取り、その日ユーザーが何を話し、何を考え、誰とどんなやりとりをしたかをより詳細に記録できるようにする。

## 実装内容

1. `03:00` close フローの前段に `audio file read -> audio processor -> daily log generation` を追加し、daily log 生成の入力強化として組み込む。
2. 入力元は Google Drive `record/audio` 配下の前日 1 ファイルを前提にし、`summaryDateKey` に対応する `YYYY-MM-DD.txt` 相当の命名で解決する。
3. Google Drive helper を拡張し、`record/audio` 配下の transcript テキスト読取と、processor 結果の保存先として `record/audio-processed/YYYY-MM-DD.json` 相当の永続パスを扱えるようにする。
4. `audio processor` 専用サービスを追加し、入力を transcript 本文、前日 business day の会話履歴、当日の予定一覧、`SOUL.md`、`USER.md` に固定する。
5. processor prompt では、transcript にユーザー本人の発話だけでなく、会話相手の声、周囲の音声、YouTube など外部コンテンツ由来の音声が混じり得ることを明示し、文脈から「ユーザーに帰属する内容」と「そうでない可能性が高い内容」を切り分けさせる。
6. processor は structured output + narrative summary を返す。少なくとも `summary`、`userActivities`、`userThoughts`、`conversations`、`memoryRelevantFindings`、`possibleNonUserContent`、`evidenceSnippets`、`confidenceNotes` を含むスキーマを定義する。
7. `memoryRelevantFindings` には、今後の memory 更新や日次振り返りに有用な事実候補だけを入れ、単なる雑音やユーザー非関連の断片を混ぜない方針を固定する。
8. daily log 作成 agent の入力契約を更新し、従来の `conversationContext` と `events` に加えて `audioProcessorResult` を受け取れるようにする。
9. daily log prompt では processor 出力を一次整理済みコンテキストとして扱い、「ユーザーが今日話したこと、考えていたこと、相手と交わした会話、印象的だった出来事」を詳細化する材料にする。
10. processor 出力は daily log へ渡すだけでなく Google Drive に保存し、後続 Step で memory 更新や再実行、デバッグに再利用できるようにする。
11. close notification state に audio 処理関連の状態を追加する。最低でも `audioInputPath`、`audioProcessedPath`、`audioProcessAttemptedAt`、`audioProcessStatus`、`audioProcessCompletedAt`、`audioProcessFailedAt`、`audioProcessError` を保持する。
12. 失敗時方針は、audio ファイル読取または processor 失敗時はその日の daily log をスキップし、close ジョブ全体は継続する構成にする。失敗内容は notification state とサーバーログへ残す。
13. 命名は `.txt` 固有に寄せず、サービス名、state 名、返り値名は `audio` ベースに統一する。将来 audio file の文字起こし前処理が別に入っても責務名を崩さない。
14. テストは少なくとも以下を追加・更新する。
    - 前日分 `record/audio/YYYY-MM-DD.txt` を close が読み、processor 結果を daily log 生成へ渡すこと
    - transcript に他者発話や動画音声由来らしい断片が含まれても、processor が `possibleNonUserContent` へ分離できること
    - `SOUL.md`、`USER.md`、会話履歴、予定が processor に注入されること
    - processor 結果が `record/audio-processed` に保存され、notification state に I/O 情報が残ること
    - audio ファイル未存在、読取失敗、processor 失敗時に daily log がスキップされ、close 全体は継続すること
15. 実装完了時には、daily log が会話履歴と Calendar だけを唯一入力とする旧前提の補助コード、古いテスト前提、不要な互換分岐が残っていないかを必ず確認し、不要なら削除する。

## 完了条件

1. `03:00` close ジョブが前日分 audio transcript `.txt` を読み、audio processor を daily log 生成の前段として実行する。
2. audio processor は transcript 内のユーザー関連情報と非ユーザー由来の可能性が高い内容を分離して出力できる。
3. daily log 作成 agent は `audioProcessorResult` を入力として受け取り、ユーザーの発話・思考・会話内容をより詳細に記録できる。
4. processor 出力は Google Drive 上に永続保存され、後続処理や再確認に使える。
5. audio 読取や processor が失敗した場合、その日の daily log はスキップされるが close ジョブ自体は継続し、失敗情報が state とログに残る。
6. 命名と I/O 契約が将来の本物の audio file 対応を阻害しない形になっている。
7. `npm test` が通る。
