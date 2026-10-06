# 2026/10/07 論文ごとの既定の出力先を CWD 配下の article/ にまとめる

# Status
- accepted

# Situation
- 個人利用で、jpaper はリポジトリの直下で実行することが多い。
- 2026-10-07 時点で、repo の直下に論文ごとの出力フォルダが 9 個（`1810.11953-ja/` と、ローカルモデルの実験用の `1810.11953-lmstudio-*-ja/`）溜まっていた。

# Context
- [UI・ファイル配置 ADR](./20260709-user-interface-file-layout-and-cli.md) は、論文ごとの成果物を実行した場所の `./<paper>-ja/` に置くと決め、「実行場所により散らばりうる」をトレードオフとして記録していた。実際に repo 直下へ散らばった。
- `.gitignore` は中の `.run/` だけを除外しており、出力フォルダ自体（`glossary.md`・`main.pdf` など）は未追跡ファイルとして git status に出続けていた。

# Material for decision
- 2026-10-07 の repo 直下の状態（出力フォルダ 9 個、すべて未追跡）。
- ユーザー判断（2026-10-07）: 実行した場所が基準、フォルダ名は `article/<paperId>-ja/`、`article/` は git で追跡しない、既存の 9 個は `article/` へ移す。
- 比較した代替: repo のルートに固定する（jpaper をコマンドとして使うとき repo の場所を知る仕組みが要る）、`~/.jpaper/articles/` に置く（成果物が隠しフォルダに入り見つけにくい）。

# Decision
- `--out` を指定しない場合の出力先を、実行した場所の **`./article/<paperId>-ja/`** にする（`src/config.ts` の `paperOutDir`）。`--out` を指定した場合は従来どおりその場所に出す。
- `article/` は `.gitignore` で除外する。論文の本文・訳文・成果物は実行時の生成物として扱い、repo に入れない。
- 出力フォルダの中のレイアウト（`source/`・`glossary.md`・`translation/`・`.run/` など）は変えない。
- [UI・ファイル配置 ADR](./20260709-user-interface-file-layout-and-cli.md) の決定 1 のうち、「論文ごと成果物の既定の置き場所 `./<paper>-ja/`」だけを置き換える。グローバル状態（`~/.jpaper/`）と、論文ごとフォルダの中身・`--out` の扱いは存続する。

# Consequences
- 良い面: 実行した場所の直下に出力フォルダが散らばらず、`article/` の下にまとまる。git status に出力フォルダが出なくなる。
- トレードオフ:
  - 出力先が 1 階層深くなる。既存のフォルダを移すと、中の checkpoint が絶対パスを持っているため、次の再実行は取り込みからやり直しになる（訳文・PDF・`glossary.md` はそのまま読める）。
  - repo 以外の場所で実行した場合は、その場所に `article/` ができる（実行した場所が基準のまま）。
