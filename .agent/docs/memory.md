# LINE Agent向け Memory システム説明

このファイルは、LINE Agent がこのメモリーを読むための説明書です。  
LINE Agent 自体はこのディレクトリ構造や各ファイルの役割を知りません。なので、まずこのファイルを読めば、どこに何があり、どう探索すればよいかが分かるようにしています。

## 1. このメモリーの概要

このディレクトリは、ユーザーの人物・場所・モノ・組織・出来事・知識・スキル・概念を、Markdownファイル単位のノードとして保存した個人メモリーです。

- 各ノードは 1 ファイル = 1 エンティティです
- 各ノードは YAML frontmatter を持ちます
- ノード同士は `links` で接続されます
- 全ノードの一覧は `node-registry.yaml` にあります
- 全体の入口と運用ルールは `index.md` にあります

現在の主な種別は次の8種類です。

- `person`
- `place`
- `object`
- `organization`
- `event`
- `knowledge`
- `skill`
- `concept`

## 2. ディレクトリ構造

このメモリーのトップレベルは概ね次のようになっています。

```text
memory/
  index.md
  node-registry.yaml
  line-agent-memory-guide.md
  people/
  places/
  objects/
  organizations/
  events/
  knowledge/
  skills/
  concepts/
```

実際の現在のファイル例:

```text
people/takeshi-hashimoto.md
people/keisuke-yamamoto.md
places/home.md
objects/macbook-pro.md
organizations/ubc.md
organizations/laplace.md
events/laplace-mtg-2026-03-06.md
knowledge/cpsc418.md
skills/programming.md
concepts/honesty.md
```

## 3. `index.md` は何か

`index.md` は全件一覧ではなく、メモリー全体の案内ページです。

役割は次の通りです。

- このメモリーが何のためのものかを説明する
- ノードタイプの一覧を示す
- 主要ノードへの入口を示す
- 最近の更新をざっくり記録する
- ノードのたどり方や更新原則を書く

つまり、`index.md` は「このメモリーの地図とルール」です。

## 4. `node-registry.yaml` は何か

`node-registry.yaml` は全ノードの索引です。  
LINE Agent がノード名や別名から、どのファイルを読むべきかを判断するための最重要ファイルです。

構造は次のようになっています。

```yaml
nodes:
  - id: ubc
    type: organization
    path: ./organizations/ubc.md
    name: The University of British Columbia
    description: カナダのブリティッシュコロンビア州バンクーバーにある公立大学。ユーザーの現在の所属機関。
    aliases:
      - UBC
      - ブリティッシュコロンビア大学
      - 大学
```

各項目の意味:

- `id`: ノードの一意ID
- `type`: ノード種別
- `path`: 実ファイルのパス
- `name`: 正式名称
- `description`: 短い説明
- `aliases`: 呼び方の揺れ

LINE Agent はまず `node-registry.yaml` を見て、

1. 名前や別名から該当ノードを特定し
2. `path` から対象ファイルを開き
3. 詳細本文や `links` を読む

という順で探索するのが基本です。

## 5. 個別ノードの基本フォーマット

各ノードの Markdown は、だいたい次の形です。

```markdown
---
id: takeshi-hashimoto
type: person
name: Takeshi Hashimoto
description: ユーザー本人。UBCの学生であり、日本自動化技術の創業者。
aliases:
  - 橋本武士
  - Takeshi

links:
  - id: ubc
    type: organization
    label: The University of British Columbia
  - id: japan-automation-technology
    type: organization
    label: 日本自動化技術
---

# Takeshi Hashimoto

本文...
```

重要なのは、各ノードが

- YAML frontmatter
- 見出し
- 本文

の3層になっていることです。

## 6. frontmatter の意味

個別ノードの先頭にある YAML frontmatter には、機械的に読みやすい情報が入っています。

- `id`: 一意ID
- `type`: ノード種別
- `name`: 表示名
- `description`: 短い要約
- `aliases`: 別名、呼び名、日本語表記ゆれ
- `links`: 関連ノード

特に `links` は重要です。  
現在の実データでは、`links` は以下のような「配列形式」で入っているノードが多いです。

```yaml
links:
  - id: takeshi-hashimoto
    type: person
    label: Takeshi Hashimoto
  - id: university
    type: place
    label: 大学
```

つまり LINE Agent は、`links` の中の `id` を見て、必要なら `node-registry.yaml` で対応するファイルを引き直して辿ります。

## 7. 個別ノードの実例

### 例1: 人物ノード

`people/takeshi-hashimoto.md` はユーザー本人のノードです。

先頭部分は次のようになっています。

```markdown
---
id: takeshi-hashimoto
type: person
name: Takeshi Hashimoto
description: ユーザー本人。UBCの学生であり、日本自動化技術の創業者。AI秘書と個人知識グラフの開発を行っている。
aliases:
  - 橋本武士
  - Takeshi
links: []
---
```

このあと本文で、

- 何者か
- 役割
- 興味
- 経歴
- 外部リンク

が書かれています。

### 例2: 組織ノード

`organizations/laplace.md` は、開発中のボードゲーム `Laplace` のノードです。

```markdown
---
id: laplace
type: organization
name: Laplace
description: 開発中のボードゲーム。
aliases:
  - Laplace
  - ラプラス

links:
  - id: takeshi-hashimoto
    type: person
    label: Takeshi Hashimoto
  - id: keisuke-yamamoto
    type: person
    label: Keisuke Yamamoto
  - id: hazuki-wakayama
    type: person
    label: Hazuki Wakayama
  - id: laplace-mtg-2026-03-06
    type: event
    label: 2026年3月6日 Laplace mtg
---
```

このノードから、

- 関係者は誰か
- 関連イベントは何か
- 何を開発しているのか

を辿れます。

### 例3: イベントノード

`events/laplace-mtg-2026-03-06.md` はミーティング記録です。

```markdown
---
id: laplace-mtg-2026-03-06
type: event
name: 2026年3月6日 Laplaceミーティング
description: コマとパッケージのデザインについての議論
aliases:
  - 2026-03-06 Laplace Meeting

links:
  - id: takeshi-hashimoto
    type: person
    label: Takeshi Hashimoto
  - id: keisuke-yamamoto
    type: person
    label: Keisuke Yamamoto
  - id: hazuki-wakayama
    type: person
    label: Hazuki Wakayama
  - id: laplace
    type: organization
    label: Laplace
---
```

イベントノードには、

- いつの出来事か
- 誰が関与したか
- 何が議論されたか

が書かれます。

## 8. 本文の読み方

frontmatter の下には、人間向けの本文があります。ここに本質的な記憶の中身があります。

本文には例えば次のような内容が入ります。

- 人物なら経歴、役割、関心、最近の状況
- 組織なら目的、現状、関係者、外部リンク
- イベントなら日時、話題、決定事項
- 場所なら滞在情報、位置づけ
- 概念なら価値観や考え方

つまり、

- 検索と参照には frontmatter
- 詳細理解には本文

という分担です。

## 9. LINE Agent が探索するときの実用ルール

LINE Agent は次の順で読むと安定します。

1. まずこの `line-agent-memory-guide.md` を読む
2. 次に `index.md` で全体の意図と主要ノードを把握する
3. `node-registry.yaml` で対象ノードを探す
4. 該当する `.md` ファイルを開く
5. frontmatter の `links` を見て、必要なら関連ノードへ移動する
6. 本文を読んで詳細を理解する

名前が曖昧なときは、まず `aliases` を見るのが重要です。  
たとえば「大学」「UBC」「ブリティッシュコロンビア大学」は、同じ `ubc` ノードを指す可能性があります。

## 10. このメモリーの現在の実態

2026年3月時点では、少なくとも次のような構成です。

- `person`: 9件
- `place`: 4件
- `object`: 2件
- `organization`: 5件
- `event`: 3件
- `knowledge`: 4件
- `skill`: 1件
- `concept`: 1件

この数は今後増える前提です。  
したがって LINE Agent は、固定のファイル名を前提にするより、常に `node-registry.yaml` を基準に対象を見つけるべきです。

## 11. 重要な注意点

このメモリーには、説明上の理想形と実ファイルのフォーマットに少し差がある可能性があります。  
たとえば `index.md` 内のサンプルでは `links` がカテゴリ別のマップ形式に見える箇所がありますが、実際の現在のノードでは配列形式の `links` が使われています。

なので LINE Agent は、

- `index.md` は方針書として読む
- 実際の解析は各 `.md` の現物と `node-registry.yaml` を優先する

という方針で扱うのが安全です。

## 12. まとめ

このメモリーを理解するための優先順位は次の通りです。

1. `line-agent-memory-guide.md`: この説明書
2. `index.md`: 全体方針と入口
3. `node-registry.yaml`: ノード検索の主索引
4. 各ノード `.md`: 実際の記憶内容

最短で言うと、

- `index.md` は地図
- `node-registry.yaml` は索引
- 各 `.md` は実データ

です。
