# 2026/10/07 成果物 PDF の名前を「ID＋短い英語名」にし、短い英語名はタイトルの翻訳と同時に決めさせる

# Status
- accepted

# Situation
- 個人利用で、論文ごとの出力先（`article/<paperId>-ja/`）から PDF を取り出して読む・人に渡すことが多い。
- 2026-10-07 時点で、和訳 PDF は `translation/build/main.pdf`、対訳 PDF は `translation/bilingual/main.pdf` にあった。どの論文の PDF も同じ `main.pdf` という名前で、組版の作業ディレクトリの奥にある。

# Context
- ファイルを出力先の外へ持ち出すと、どの論文の PDF か名前から分からない。和訳と対訳も同じ名前なので、並べると区別できない。
- [UI・ファイル配置 ADR](./20260709-user-interface-file-layout-and-cli.md) の既定レイアウトは成果物を出力先の直下の `main.pdf` としていたが、実装は組版ディレクトリの `main.pdf` をそのまま成果物として返していた。
- 論文タイトルは既に title 節（[対訳 PDF ADR](./20261006-bilingual-side-by-side-pdf.md)・契約付録 §8「論文タイトルの翻訳」）として translator に 1 回だけ通しているので、同じ呼び出しで論文を表す英語名も得られる。

# Material for decision
- ユーザー判断（2026-10-07）: 「pdf を main.pdf にするのをやめてください。title の和訳と同時にどういう pdf 名にするかも決めさせていいかも」。名前の形は選択肢から「ID＋短い英語名」を選んだ（例: `2507.17845_pathorob-ja.pdf`・`2507.17845_pathorob-bilingual.pdf`・`2306.15350_cellvit-ja.pdf`）。
- 比較した代替: ID だけ（`2507.17845-ja.pdf`。どの論文か ID を引かないと分からない）、訳題そのもの（日本語・記号・長さでファイル名として扱いにくい）、原題から機械的に作る（長く、手法名を選べない）。
- 短い英語名を出させる方法の比較: title 節の translator に 1 行足させる（追加の呼び出し 0 回）、別の小さな呼び出しにする（1 run に 1 回呼び出しが増え、checkpoint も別に持つ）。

# Decision
- 利用者向けの成果物 PDF は出力先の**直下**に置き、名前を **`<ID>_<slug>-ja.pdf`（和訳）／`<ID>_<slug>-bilingual.pdf`（対訳）** にする。`Result.pdfPath`・`RunSummary.bilingual.pdfPath`・CLI の表示はこちらを指す。組版ディレクトリの `main.pdf`（`translation/build/`・`translation/bilingual/`）は内部の生成物として残す。
- `<ID>` は paperId をファイル名に使える形（英数字・`.`・`_`・`-`、先頭の `.` は `_`）に整えたもの。
- `<slug>` は **title 節の translator にタイトルの訳と同時に出させる**。訳文の囲みの中の最後の行に TeX の行コメント `% pdf-name: <name>` を 1 行足させ、コードが形式検査・evaluator・組版に渡す前に取り外す（囲みの外に書かれた行も拾う）。追加の LLM 呼び出しはしない。訳文の形式（```tex の囲み・平文）は変えない。
- 取り外した値は英小文字・数字・ハイフンだけに整え（小文字化・区切りをハイフンに畳む・40 文字まで）、何も残らなければ使わない。タイトルが `absent` / `failed` の run と、整えて空になった run は **ID だけ**（`<ID>-ja.pdf`）にする。
- 名前は title 節の checkpoint に含め、再実行で同じ名前を使う。
- 古い名前の成果物 PDF は残さない: 和訳 PDF を置いた run は他の名前の和訳成果物を消し、対訳を置かなかった run（`--no-bilingual`・対訳の組版失敗・中断）は対訳の成果物も消す。和訳 PDF を組めなかった run は前回の成果物を壊さない。別の論文が出力先へ来たら成果物 PDF も落とす。
- [UI・ファイル配置 ADR](./20260709-user-interface-file-layout-and-cli.md) の既定レイアウトの `main.pdf` だけを置き換える。

# Consequences
- 良い面: 出力先の外へ持ち出しても、どの論文の和訳か対訳かが名前で分かる。出力先を開くと成果物が直下に並ぶ。名前のために LLM 呼び出しは増えない。
- トレードオフ:
  - 短い英語名はモデルが選ぶので、同じ論文でも title 節を訳し直すと名前が変わりうる（checkpoint が有効な間は変わらない）。
  - title 節の translator の指示が 1 文長くなる（本文の節のプロンプトは変わらない）。モデルが行を書かなければ ID だけになる。
  - 出力先の直下で `-ja.pdf` / `-bilingual.pdf` で終わるファイルは jpaper の成果物として扱い、古い名前のものは消す。利用者が同じ形の名前のファイルを出力先の直下に置くと消える。
  - 既存の title 節の checkpoint は名前を持たないので、この変更の後の最初の run でタイトルだけ 1 回訳し直す。
