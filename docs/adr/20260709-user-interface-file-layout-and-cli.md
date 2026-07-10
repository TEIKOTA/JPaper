# 2026/07/09 ユーザーインターフェース: ファイル配置（グローバル/論文ごと分離）・jpaper CLI・GUI は core の薄い皮

# Status
- accepted

# Situation
- JPaper は学術論文の和訳エージェント。設計（取り込み〜組版・用語・durable・プロバイダ）は先行 ADR 群で確定済み。実装に入る前に、ユーザーが触れる**ファイル配置**と**起動インターフェース**を決める必要が生じた。
- 要求: ①ファイル管理に透明性（ユーザーがアクセス・編集できる）。②最初は CUI でよい（`jpaper <input>` 形式）。③ゆくゆくはドラッグ&ドロップで和訳できる GUI（TS なのでレンダリングと相性が良い）。

# Context
- 透明性（ユーザーが触れる）と、cross-paper で1個だけ持つ**共有用語 DB**（[用語 ADR](./20260709-terminology-architecture-two-tier-classified-glossary.md) の global 層）は、置き場所の要求が異なる。前者は論文ごと可視フォルダ、後者は安定した1箇所。
- 先頭ドットの隠しフォルダ（`.jpaper`）は「隠し」であり「透明性・ユーザーアクセス」と部分的に矛盾する。
- GUI を後から足すとき、core が UI に依存していると作り直しになる。CLI と GUI は同じ翻訳ロジックを通すべき。
- durable の checkpoint は [durable 設計（メモ §11）](../design/translation-pipeline.md) で「論文の作業ディレクトリ配下」に置く方針。新レイアウトでは論文ごとフォルダ配下に移す。

# Material for decision
- [用語 ADR](./20260709-terminology-architecture-two-tier-classified-glossary.md)（global 共有 DB / per-paper 確定辞書）
- [durable 設計（メモ §11）](../design/translation-pipeline.md)（ファイル checkpoint・idempotent-skip）
- [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)（明示的失敗）
- 現行 `資料/` の「論文ごと1ディレクトリ・成果物はプレーンファイル」運用
- ユーザーの UX 要求（透明性・CUI 先行・DnD GUI・TS×レンダリング）

# Decision

## 決定 1: 「グローバル状態」と「論文ごと成果物」を分離
- **グローバル状態** = `~/.jpaper/`（環境変数 `JPAPER_HOME` で上書き可）。cross-paper で1個の共有用語 DB（`glossary.db`）・設定を置く。隠しフォルダ可（アプリ状態のため）。
- **論文ごと成果物** = 可視フォルダ **`./<paper>-ja/`**（`--out DIR` で変更可）。自己完結・透明・編集可能。既定レイアウト:
  ```
  <paper>-ja/
    source/         展開した TeX（or PDF-only 抽出のクリーン LaTeX）
    figures/        抽出した図
    glossary.md     per-paper 確定辞書（★ユーザーが訳語を直せる）
    translation/    訳文 chapters/*.tex
    main.pdf        成果物
    .run/           checkpoint・trace（durable。触らなくてよいが可視）
  ```

## 決定 2: 透明性 = すべてプレーンファイル、編集して再実行が主要ループ
- 成果物・中間物は LaTeX / Markdown / PDF / SQLite など**人間可読・編集可能な形式**で置く（不透明な blob にしない）。
- **`glossary.md` を編集 → 再実行**すると durable が未影響ステップを skip し、訳語だけ差し替わる。これをユーザーの主要な制御ループとする（[用語 ADR] の per-paper 層＋ユーザー制御の UI 化）。

## 決定 3: CLI 入口は `jpaper` bin、input は自動判定
- `jpaper <input> [--out DIR] [--provider local|cloud]` を bin として提供。開発中は `npm run dev -- <input>`。
- **`<input>` はパスを見て形態を自動判定**: TeX アーカイブ（zip/tar.gz/gzip-tar/.tex.gz）・`.tex`・ディレクトリ・PDF・arXiv ID（[取り込み（メモ §3）](../design/translation-pipeline.md) と直結）。判定不能なら明示的失敗。

## 決定 4: core-first アーキテクチャ（GUI は後付けの薄い皮）
- **core = 純 TS ライブラリ `translatePaper()`**。CLI はその薄いラッパ、将来の GUI も薄いラッパ。**core は UI を import しない**。
- ドラッグ&ドロップは「落ちたファイルパスを core に渡すだけ」で、CLI と同一経路を通る。
- GUI の実装技術（Electron / Tauri / ローカル web UI）は**実装フェーズで選ぶ。v1 では作らない**（CUI 先行）。

# Consequences
- 良い面
  - 共有用語 DB が1箇所（`~/.jpaper/`）に集約され、全論文・`資料/` からも横断共有できる（[用語 ADR] の「回すほど改善」を担保）。
  - 論文ごとフォルダが可視・自己完結・編集可能で透明。`glossary.md` 編集＋再実行という直感的な制御ループが durable と噛み合う。
  - core-first により GUI（DnD）が CLI と同じロジックを再利用でき、後付けでも作り直しにならない。
  - 入力形態の自動判定で、ユーザーは形式を意識せず1コマンド。
- トレードオフ
  - グローバルと論文ごとの2箇所を管理する（パス解決・`JPAPER_HOME` 上書き・共有 DB のロック競合に留意）。
  - `--out` 既定を invoke 位置の `./<paper>-ja/` にするため、実行場所により散らばりうる（明示 `--out` を推奨する運用でカバー）。
  - GUI 技術選定を先送りするため、core の API は UI 非依存で安定させておく必要がある（`translatePaper()` の入出力契約を早期に固定）。
- 本 ADR は durable の checkpoint 位置を「論文ごとフォルダ配下 `.run/`」に定める。設計メモ §11 の `output/runs/<id>/steps/` はこの位置へ読み替える（メモ側も更新）。
