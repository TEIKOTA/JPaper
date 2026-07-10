# 翻訳パイプライン 設計メモ（計画フェーズ）

> これは**計画フェーズの設計メモ**。確定した決定は [`docs/adr/`](../adr/) に置き、ここには分析・計画・未決事項を置く（ADR より流動的。合意でき次第、随時更新する）。
> 根拠: 現行和訳リポジトリ `資料/` の静的調査＋サブエージェントによる 2 デモ（U-Net / Transformer, 2026-07-08）。
> **実装契約（zod I/O・SQLite DDL・品質ループの値・トークン予算・CLI 終了コード）の正本は [契約付録](./contract-appendix.md)**（会社B レビューを受け 2026-07-09 に確定。v1=source-first 限定）。

## 1. 現行 `資料/` パイプラインの要約（参考）

- **実体**: 専用プログラムではなく、Claude Code＋手順書（`資料/AGENTS.md`, `docs/agent/*.md`）による手作業和訳。20 本以上の実績があり "うまくいっている"。
- **取り込み**: arXiv の LaTeX ソースがあればそれを翻訳入力。無ければ PDF を LLM が直読。
- **図**: PDF ページを 300dpi レンダリング → `manifest.csv` の座標で手動クロップ → `\includegraphics` で埋め込み（全図必須）。
- **組版**: LuaLaTeX（`luatexja-preset`）で `main.tex` → `main.pdf`。
- **用語**: 論文ごとに `translation_glossary.md` をゼロから作成。
- **判明した非効率**: 図の手動座標クロップ / 用語の毎回再作成 / `.bbl` からの引用番号手計数 / `\cit` マクロ再実装 / 節分割で相互参照断。

## 2. 責務分離の原則（北極星）

**AI は本文翻訳だけ。構造抽出・図検出/切り出し・数式・引用番号・組版は決定的処理（スクリプト/ツール）に寄せる。**

- **AI に渡すのは座標付き JSON ではなく「クリーンな生文」**（クリーンな LaTeX または Markdown）。単語ごとの bbox/座標は翻訳 LLM にはノイズ＝**コンテキスト汚染**になるので、位置メタデータはスクリプト内部の中間表現に留める。
- 論文の LaTeX 構造（`\section`/段落/`\cite`）は標準で既知。構造は**LaTeX/Markdown の形のまま**持てば、そのまま組版（build）に直結し、JSON→md→LaTeX の変換往復を避けられる。
- JPaper の ADR（[配線=コード/判断=LLM](../adr/20260708-adopt-deterministic-agent-architecture.md)、[決定的処理はツール化](../adr/20260708-translation-pipeline-ingestion-and-figures.md)）と一致。デモで実データ追認。

## 3. 取り込み（ingestion）: source-first

- **arXiv LaTeX ソースがあれば最優先**。数式・表・構造・引用がすべて元のまま揃う＝再構成も OCR も不要。「クリーンな第二 LaTeX」は**元 LaTeX そのもの**になる。
- **ソースが無い論文のみ PDF-only の抽出経路（下記）に回す**。多数派はソース有りで解決するため、抽出の作り込みは PDF-only の少数派向けの投資と割り切る。
- **入力形態（source-first の受け口を広くする）**: `ingest()` は次を受け付ける。
  - **TeX ソースアーカイブ（zip / tar.gz / arXiv の拡張子なし gzip-tar / 単体 .tex.gz）** ← 明示要件。展開して main.tex を検出し、`\input`/`\include` と図ファイルを回収 → source 経路へ。
  - arXiv ID（ソース tarball を取得）／ TeX ソースのディレクトリ・単一 .tex。
  - 上記いずれも無い場合のみ PDF-only 経路。
- **main.tex 検出はヒューリスティック**: `\documentclass` を含む・`\begin{document}` を持つ・`main.tex`/論文名 等で決定的に選ぶ。曖昧なら明示的失敗（黙って誤ったファイルを選ばない）。

## 4. PDF-only から取れる4層（実測）と抽出ツールの役割分担

| 層 | 手段（この環境で可） | 取れるもの | 信頼度 |
|---|---|---|---|
| ページ画像 | Read 目視 / `pdftocairo` | 本文・図・数式・レイアウトを人間同様に判読 | 高（要書き起こし） |
| テキスト | `pdftotext -layout` / `-bbox-layout` | 段落・著者・引用番号・URL・座標 | 中 |
| 埋め込みラスタ | `pdfimages -png` | 埋め込み画像を**元解像度で無劣化抽出** | 高（ラスタ図のみ） |
| メタ/フォント | `pdfinfo` / `pdffonts` | ページ数・寸法・生成元・数式フォント有無 | 高 |

- **`pdftotext` は数式を壊す**（Attention 式で √ の中身 `d_k` と分母が脱落）。PDF は `Tagged: no`（構造タグ無し）。
- 環境: poppler 系 CLI（pdftotext/pdftocairo/pdfimages/pdffonts/pdfinfo）＋ PIL は可。PyMuPDF・pdfplumber・nougat は未導入。

**PDF-only での対象別・最良手段（役割分担）**:

| 対象 | 最良手段 | 理由 |
|---|---|---|
| 数式 | **Nougat**（後述） | pdftotext は壊す。Nougat は PDF→LaTeX 数式が高精度 |
| 本文（散文） | **native 抽出（pdftotext）** | テキスト層は正確。Nougat は視覚 OCR で幻覚・繰り返しの弱点あり、散文はむしろ劣化しうる |
| 表 | **専用抽出（pdfplumber / camelot）** | born-digital の表はセル構造ごと取れる。Nougat の表再構成は崩れうる |
| 図 | pdfimages / render→crop | §6 |

## 5. 数式の入手経路

| 状況 | 数式の入手 |
|---|---|
| **ソース有り**（多数派） | 元 LaTeX がそのまま＝**完璧**。何もしない |
| **PDF-only** | **Nougat**（PDF→LaTeX 数式・高精度）。※`pdftotext` は不可 |

## 6. 図取得の3段戦略

1. **ソースのベクタ図**（source があれば）＝最良（無劣化・座標不要）
2. **`pdfimages` で埋め込みラスタを無劣化抽出**（PDF-only でも図がラスタ実体を持つ場合）
3. **render→crop**（ベクター/複合図の万能 fallback。座標の当たり外れ → bbox 自動検出で軽減）

## 7. PDF-only 抽出方針: Nougat（数式）＋ native（本文/表）

- **Nougat** = Meta の学術 PDF 用ニューラル OCR。**ページ画像**を Markdown＋LaTeX 数式（`.mmd`）へ変換。数式の LaTeX 化が現状最良。
- **その出力（クリーンな Markdown＋LaTeX 数式）は、そのまま §2 の「AI へ渡すクリーン生文」になる**（座標 JSON 不要）。
- **スコープは PDF-only 限定**。source 有りは Nougat 不要。
- **正直な代償**: ①幻覚・繰り返しループ（要レビュー／native と突き合わせで軽減）②重い・**GPU 推奨**（モデル ~1.4GB、CPU は遅い）③出力は Markdown なので md→LaTeX 変換段が要る（数式は既に LaTeX）④「数式=Nougat＋本文=native＋表=専用」を1つに揃える **alignment（継ぎ目）コスト**。
- **段階方針**: まず **whole-page Nougat 単体**で始めて出力をレビュー → 本文/表の幻覚が問題化したら **本文=pdftotext / 表=pdfplumber を混ぜるハイブリッド**へ精緻化。

## 8. 自動化ロードマップ（ROI 順・**未確定の計画**）

| # | 内容 | 依存 | 難易度 |
|---|---|---|---|
| 1 | source-first 取り込み（ソース検出→元 LaTeX 節を AI へ） | 既存 | 低（最も効く） |
| 2 | `pdfimages` で図を無劣化自動抽出 | poppler（導入済） | 低 |
| 3 | PDF-only: Nougat で Markdown＋LaTeX 数式化（中間表現） | nougat-ocr（GPU 推奨） | 中 |
| 4 | PyMuPDF で図 bbox 自動算出 → `manifest.csv` 自動生成 | pymupdf | 中 |
| 5 | 訳文 → LaTeX 自動合成（クリーン生文＋manifest → tex） | 1–4 | 中〜高 |

- 必要な追加依存（未導入）: `nougat-ocr`, `pymupdf`, `pdfplumber`（PoC 前に導入可否を判断）。

## 9. JPaper への落とし込み（スタック）

- JPaper は TS。PDF 処理は **TS ワークフローが poppler / nougat / python ヘルパを外部ツールとして叩く**形（PDF 処理を外部委譲する方針と整合）。
- スクリプト構成イメージ:
  - `extract-source`（arXiv ソース検出→クリーン LaTeX 節）
  - `extract-pdf`（PDF-only: Nougat → md+LaTeX、native で本文/表を補完）
  - `detect-figures`（pdfimages ＋ bbox → `manifest.csv` 自動）
  - `render-pdf-pages` / `crop-figures`（既存を流用）
  - `assemble-latex`（訳文＋manifest → `chapters/*.tex`, `main.tex`）

## 11. 再エントリ設計（durable = ファイル checkpoint。ライブラリ不使用）

長い論文の翻訳は「用語集構築＋節ごとの翻訳×多数＋評価ループ＋組版」で高コストな LLM 呼び出しが多数走る。途中で落ちても（crash / Ctrl-C / 再起動 / スリープ / API タイムアウト）**完了済みの高コストステップを再実行しない**ことを durable の本体とする。

- **方式は「状態はファイル」**。durable 実行ライブラリ（Temporal / Restate / DBOS）も常駐サーバーも使わない。素の TS ＋ `fs` で、checkpoint を**エージェント呼び出しの境界に人手で置く**。
  - Flue の「Workflow は非 durable」は「任意コードを**自動**では checkpoint しない」という意味であって、checkpoint 自体は置ける。境界を自分で決めるこの形が「独立して読めるワークフロー」要件とも両立する（イベントログ＋manifest で状態を持つ設計と同型）。
  - 常駐サーバー案は不採用: ディスク永続するなら本方式の再発明、メモリのみなら「サーバー落ち＝全ロスト」で再起動すら耐える本方式より弱い。サーバーが要るのは複数クライアント／並行オーケストレーションが必要になったときで、単発 CLI 翻訳には該当しない。
- **保存先**: 論文ごとフォルダ配下 `<paper>-ja/.run/steps/<step>.json`（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) 決定 1。可視だが触らなくてよい trace 領域）。書き込みは **tmp→rename の原子的更新**。
- **再開**: 同じ `run-id` で再実行。各ステップは checkpoint でくるみ、「出力が既にあり zod スキーマに妥当なら読んで skip」＝ idempotent-skip。
- **編集による無効化**: ユーザーが `glossary.md`／`brief.md`／`style.md` を編集して再実行したときは、これらを注入する**下流の翻訳ステップの checkpoint を無効化**して再訳する（checkpoint キーに注入コンテキストのハッシュを含める）。取り込み・用語収集など未影響ステップは skip のまま。
- **リトライは一時エラーのみ**（API タイムアウト・429・瞬断を数回バックオフ）。ビルド失敗・欠図・品質未達などタスク自体の失敗はリトライせず明示的に上げる（境界は [品質ゲート ADR](../adr/20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) 決定 3）。
- 実装イメージ:

```ts
// 各ステップを checkpoint でくるむ。完了済みなら読んで skip（＝durable）
async function checkpoint<T>(runDir, stepId, schema, fn: () => Promise<T>): Promise<T> {
  const path = `${runDir}/steps/${stepId}.json`;
  const cached = tryReadValid(path, schema);            // あって妥当なら再利用
  if (cached) return cached;
  const result = await withRetry(fn, { retries: 3, on: isTransient }); // 一時エラーのみ
  writeAtomic(path, result);                            // tmp→rename で原子的永続
  return result;
}
```

## 12. 決定と明示的保留（2026-07-08 決着）

旧「未決事項」を解消。6 項目は「1 つの戦略分岐＋その従属項目」に集約された。

### 決定

- **実装順 = 用語 DB v1 が先**。[翻訳パイプライン ADR](../adr/20260708-translation-pipeline-ingestion-and-figures.md) の「用語 DB を最優先・実装の第一歩」を追認（§12 で「未決」としていたのは記載ミス）。
- **場所/スタック = JPaper(TS) で新規に組む**。用語 DB は `node:sqlite`。ただし **SQLite ファイル＋CLI 設計にして `資料/` からも叩けるよう共有**し、既存の翻訳作業からもすぐ使える形にする。`資料/` は参照・検証用に留置（追跡対象外）。基盤 ADR（JPaper/TS）の前提と一致。

### 明示的に保留（＝未成熟な段階で固定しない、という決定）

以下は **PDF-only 抽出 PoC の論点**。source-first が多数派を解くため後回し投資であり、かつ **一度実際に走らせないと妥当に決められない**。PoC 着手時に PoC の中で決める。

- **PDF-only**: Nougat 単体で割り切るか、本文=native / 表=pdfplumber のハイブリッドにするか。
- **Nougat 実行環境**: Docker 前提か（GPU/モデル配布の都合）。
- **依存導入**: `nougat-ocr` / `pymupdf` / `pdfplumber` を入れるか。
- **インライン数式**の分離精度（ディスプレイ数式は隔離容易、インラインは難所）。

### 別途、実装着手前に議論するもの → §13 で決着

- ランタイム実装の細部（system prompt 部品化・サブエージェント使い分け・決定性回帰テスト）。

## 13. ランタイム実装細部（2026-07-09 決着。汎用エージェント機構を JPaper 向けに絞る）

用語モデルは [用語アーキテクチャ ADR](../adr/20260709-terminology-architecture-two-tier-classified-glossary.md) に確定。ここは薄いランタイムの3点を詰める。方針は「汎用エージェントの機構をそのまま持ち込まず、JPaper に要る分だけ」。

### A. system prompt の組み立て — 3部品を固定順で合成
汎用エージェントの system prompt は5部品で構成されがちだが、JPaper に要るのは3つ。**固定順で部品合成する薄いビルダー**を持つ（出力は決定的＝スナップショットテスト可能）。

1. **役割定義** — translator / evaluator / glossary-builder それぞれの正体（「本文だけ訳す」等）
2. **共通規約** — 責務境界（構造・数式・図・引用はコードが持つ / AI は本文のみ）・出力契約（zod に載る JSON）。全 agent で重複させず1箇所。
3. **run-context** — 論文メタ＋**per-paper 確定辞書＋rendering ルール＋文書ブリーフ(`brief.md`)＋文体契約(`style.md`)**を動的注入（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定1。並列翻訳でも主張強度・文体の大域一貫を保つ源）。

落とす2つ: **日時**（論文翻訳に無関係・YAGNI）、**skill 段階開示**（用語 DB の retrieval がその役割を果たすので汎用 skill 機構は当面不要）。

### B. サブエージェント/ツールの形 — 事前注入・純変換器
「サブエージェントをツール化する方式 vs 別プロセスへ dispatch する方式」の使い分けは、素の TS ワークフローを選んだ JPaper には非該当。

- エージェント呼び出しは `session.run(agent, input)` を**ワークフロー TS が直接配線**（glossary-builder → translator → evaluator）。エージェント同士は互いを知らない（委譲先の選択はコード）。
- 用語は **retrieval-then-inject（事前注入）**。エージェントは**ツール無しの純変換器**（入力→zod 出力）に保つ。薄いランタイムに tool 実行ループを入れない。
- 理由: cloud=公式 CLI subprocess では LLM のツール制御が難しく、事前注入なら local/cloud 両対応で同一 IF。将来 tool-calling が要れば足す。

### C. 決定性回帰テスト — FakeLlmClient で配線を検証
`LlmClient` を差し替え可能にした恩恵で、テストは **`FakeLlmClient`（固定/スクリプト応答）を注入**して配線を LLM 抜きで決定的に vitest（CLAUDE.md「`npm test`=LLM 非含有」を実現）。

- **決定的にテスト**: セグメント分割 / アセンブル(訳文+manifest→tex) / 用語 DB クエリ・write-back / zod 検証 / `\ref`・全図の形式検査 / checkpoint の idempotent-skip（`brief.md`/`style.md`/`glossary.md` 編集で下流のみ無効化）/ system prompt ビルダー出力（brief/style 注入込み）/ 品質ゲートのループ回数・`MAX_REVISIONS` 超過で failed / **rendering 適用（`Value` が全文 `値(Value)` に統一されているか）** / **訳注の採否（trigger の決定的規則: paper-defined preserve・低確信=DB に confirmed 無し・warn）・文書初出のみ脚注**。
- **テストしない**: 翻訳品質・evaluator 判定・**文書ブリーフ／文体契約／訳注の文面**（いずれも LLM 生成で非決定的。実行時の品質ゲートに委ねる）。

## 14. 翻訳一貫性: 文書ブリーフ・文体契約・訳注（2026-07-10 決着）

学術翻訳の実務レポート（deep-research）を現 spec と突き合わせ、**用語以外の3次元**の欠落を [翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) で確定した。いずれも「節を並列・独立に訳す」現アーキテクチャの局所最適／大域不整合への手当て。値・スキーマの正本は [契約付録](./contract-appendix.md)。

- **文書ブリーフ＋文体契約（決定1）**: glossary-builder の**全文1回パスの副産物**として `brief.md`（主張構造・記法規約）と `style.md`（既定=である調・常体）を確定・ロックし、全 translator の run-context に注入。両者は `<paper>-ja/` に**可視・編集可**。研究の「試訳で先に文体を固定」を新ステージなしで実現する。
- **evaluator 軸の明文化（決定2）**: 主張強度・hedging・統計語（`significantly`=有意）・単位表記を評価軸に追加。
- **訳注（決定3）**: 採否=決定的 trigger（paper-defined preserve／低確信=DB に confirmed 無し／evaluator warn）、文面=LLM。データ生成は (A) の `notes.json`＋`glossary.md` 印、PDF 描画は (B) の**文書初出のみ脚注＋巻末「訳注一覧」**。PDF しか読まない運用に届ける。
- **言語整合 lint（決定4）**: 単位/略語初出/表記ゆれの決定的検査を (B) 全文ゲートへ（PerfectIt 相当まで）。
- **落とし穴 skill（決定5）**: 統計語・SI・false friend の注意リストを [`.agents/skills/translation-pitfalls`](../../.agents/skills/translation-pitfalls/SKILL.md) に置き、**evaluator のみ**に段階開示。DB は空スタートを維持。
