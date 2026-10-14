# 翻訳パイプライン 設計メモ（計画フェーズ）

> これは**計画フェーズの設計メモ**。確定した決定は [`docs/adr/`](../adr/) に置き、ここには分析・計画・未決事項を置く（ADR より変わりやすく、合意できた時点で随時更新する）。
> 根拠: 現行の和訳リポジトリ `資料/` の静的調査と、サブエージェントによる 2 本のデモ（U-Net / Transformer, 2026-07-08）。
> 実装の契約（zod の I/O・SQLite の DDL・品質ループの値・トークン予算・CLI の終了コード）の正本は [契約付録](./contract-appendix.md)（会社B のレビューを受けて 2026-07-09 に確定。v1 は source-first に限定）。

## 1. 現行 `資料/` パイプラインの要約（参考）

- 実体: 専用のプログラムではなく、Claude Code と手順書（`資料/AGENTS.md`, `docs/agent/*.md`）による手作業の和訳。20 本以上の実績があり、"うまくいっている"。
- 取り込み: arXiv の LaTeX ソースがあれば、それを翻訳の入力にする。無ければ PDF を LLM が直接読む。
- 図: PDF のページを 300dpi でレンダリングし、`manifest.csv` の座標で手動でクロップして、`\includegraphics` で埋め込む（全図必須）。
- 組版: LuaLaTeX（`luatexja-preset`）で `main.tex` から `main.pdf` を作る。
- 用語: 論文ごとに `translation_glossary.md` をゼロから作る。
- 判明した非効率: 図の座標の手動クロップ / 用語集の毎回の作り直し / `.bbl` から引用番号を手で数えること / `\cit` マクロの再実装 / 節に分けると相互参照が切れること。

## 2. 責務分離の原則（基本方針）

**AI が担うのは本文の翻訳だけ。構造の抽出・図の検出と切り出し・数式・引用番号・組版は、決定的な処理（スクリプト・ツール）に寄せる。**

- AI に渡すのは座標付きの JSON ではなく、「クリーンな生の文」（クリーンな LaTeX または Markdown）。単語ごとの bbox や座標は、翻訳する LLM にとってノイズになり、文脈を乱す。位置のメタデータはスクリプト内部の中間表現に留める。
- 論文の LaTeX の構造（`\section` / 段落 / `\cite`）は標準的で、形が分かっている。構造を LaTeX / Markdown の形のまま持てば、そのまま組版（build）に使え、JSON→md→LaTeX の変換の往復を避けられる。
- この原則は JPaper の ADR（[配線=コード/判断=LLM](../adr/20260708-adopt-deterministic-agent-architecture.md)、[決定的処理はツール化](../adr/20260708-translation-pipeline-ingestion-and-figures.md)）と一致し、デモで実データでも確かめた。

## 3. 取り込み（ingestion）: source-first

- arXiv の LaTeX ソースがあれば最優先で使う。数式・表・構造・引用がすべて元のまま揃うので、再構成も OCR も要らない。「クリーンな第二の LaTeX」は元の LaTeX そのものになる。
- ソースが無い論文だけを、PDF-only の抽出経路（下記）に回す。多くの論文はソースがあるので解決でき、抽出の作り込みは少数の PDF-only の論文に向けた投資だと割り切る。
- 入力の形（source-first の受け口を広くする）: `ingest()` は次を受け付ける。
  - TeX ソースのアーカイブ（zip / tar.gz / arXiv の拡張子なし gzip-tar / 単体の .tex.gz）。明示された要件。展開して main.tex を見つけ、`\input` / `\include` と図のファイルを集めて、source の経路へ渡す。
  - arXiv ID（ソースの tarball を取得する）／ TeX ソースのディレクトリ・単一の .tex。
  - 上のいずれも無い場合だけ、PDF-only の経路に回す。
- main.tex の検出はヒューリスティック: `\documentclass` を含む・`\begin{document}` を持つ・`main.tex` や論文名 などの条件で、決定的に選ぶ。曖昧なら明示的に失敗する（誤ったファイルを黙って選ばない）。

## 4. PDF-only から取れる 4 層（実測）と抽出ツールの役割分担

| 層 | 手段（この環境で可） | 取れるもの | 信頼度 |
|---|---|---|---|
| ページ画像 | Read 目視 / `pdftocairo` | 本文・図・数式・レイアウトを人間同様に判読 | 高（要書き起こし） |
| テキスト | `pdftotext -layout` / `-bbox-layout` | 段落・著者・引用番号・URL・座標 | 中 |
| 埋め込みラスタ | `pdfimages -png` | 埋め込み画像を**元解像度で無劣化抽出** | 高（ラスタ図のみ） |
| メタ/フォント | `pdfinfo` / `pdffonts` | ページ数・寸法・生成元・数式フォント有無 | 高 |

- `pdftotext` は数式を正しく取り出せない（Attention の式で、√ の中身 `d_k` と分母が抜け落ちた）。PDF は `Tagged: no`（構造タグが無い）。
- 環境: poppler 系の CLI（pdftotext/pdftocairo/pdfimages/pdffonts/pdfinfo）と PIL は使える。PyMuPDF・pdfplumber・nougat は入っていない。

PDF-only の論文で、対象ごとに最もよい手段（役割分担）は次のとおり。

| 対象 | 最良手段 | 理由 |
|---|---|---|
| 数式 | Nougat（後述） | pdftotext は数式を正しく取り出せない。Nougat は PDF→LaTeX の数式が高精度 |
| 本文（散文） | native 抽出（pdftotext） | テキスト層は正確。Nougat は視覚の OCR で、幻覚・繰り返しの弱点があり、散文はむしろ劣化しうる |
| 表 | 専用の抽出（pdfplumber / camelot） | born-digital の表はセルの構造ごと取れる。Nougat の表の再構成は崩れうる |
| 図 | pdfimages / render→crop | §6 |

## 5. 数式の入手経路

| 状況 | 数式の入手 |
|---|---|
| ソース有り（多数派） | 元の LaTeX がそのまま使え、完璧。何もしない |
| PDF-only | Nougat（PDF→LaTeX の数式・高精度）。※`pdftotext` は不可 |

## 6. 図を取る 3 段の戦略

1. ソースのベクタ図（source があれば）が最良（無劣化・座標不要）
2. `pdfimages` で埋め込みラスタを無劣化で抽出（PDF-only でも、図がラスタの実体を持つ場合）
3. render→crop（ベクターや複合図にも使える汎用の fallback。座標の当たり外れは、bbox の自動検出で減らす）

## 7. PDF-only の抽出方針: Nougat（数式）＋ native（本文/表）

- Nougat は、Meta の学術 PDF 用のニューラル OCR。ページ画像を Markdown と LaTeX の数式（`.mmd`）へ変換する。数式を LaTeX にする手段として、現状で最良。
- その出力（クリーンな Markdown と LaTeX の数式）は、そのまま §2 の「AI へ渡すクリーンな生の文」になる（座標の JSON は要らない）。
- 範囲は PDF-only に限る。source がある論文には Nougat は要らない。
- 代償: ①幻覚・繰り返しのループ（レビューか、native との突き合わせで減らす）②重く、**GPU を推奨**（モデル ~1.4GB、CPU では遅い）③出力が Markdown なので、md→LaTeX の変換段が要る（数式は既に LaTeX）④「数式=Nougat＋本文=native＋表=専用」を 1 つに揃える **alignment（継ぎ目）のコスト**。
- 段階方針: まず whole-page の Nougat 単体で始めて出力をレビューする。本文や表の幻覚が問題になったら、本文=pdftotext / 表=pdfplumber を混ぜるハイブリッドへ細かく詰める。

## 8. 自動化ロードマップ（ROI 順・**未確定の計画**）

| # | 内容 | 依存 | 難易度 |
|---|---|---|---|
| 1 | source-first 取り込み（ソース検出→元 LaTeX 節を AI へ） | 既存 | 低（最も効果が大きい） |
| 2 | `pdfimages` で図を無劣化自動抽出 | poppler（導入済） | 低 |
| 3 | PDF-only: Nougat で Markdown＋LaTeX 数式化（中間表現） | nougat-ocr（GPU 推奨） | 中 |
| 4 | PyMuPDF で図 bbox 自動算出 → `manifest.csv` 自動生成 | pymupdf | 中 |
| 5 | 訳文 → LaTeX 自動合成（クリーン生文＋manifest → tex） | 1–4 | 中〜高 |

- 必要な追加の依存（未導入）: `nougat-ocr`, `pymupdf`, `pdfplumber`（PoC の前に導入するかを判断する）。

## 9. JPaper への落とし込み（スタック）

- JPaper は TS。PDF の処理は、TS のワークフローが poppler / nougat / python のヘルパを外部ツールとして呼び出す形にする（PDF の処理を外部に任せる方針と合う）。
- スクリプトの構成のイメージ:
  - `extract-source`（arXiv のソースを検出→クリーンな LaTeX の節）
  - `extract-pdf`（PDF-only: Nougat → md+LaTeX、native で本文/表を補う）
  - `detect-figures`（pdfimages ＋ bbox → `manifest.csv` を自動で作る）
  - `render-pdf-pages` / `crop-figures`（既存を流用）
  - `assemble-latex`（訳文＋manifest → `chapters/*.tex`, `main.tex`）※レイアウトの方針は [組版レイアウト ADR](../adr/20260710-typesetting-layout-original-first-hybrid.md)。既定では元のプリアンブルを残し（§3 の「元の LaTeX そのもの」を活かして、レイアウトを忠実に保つ）、日本語で組めない論文だけ、共通の luatexja テンプレートへ明示的にフォールバックする（§9 の共通テンプレートは、ベースライン／フォールバックとして位置づけ直す）。元→テンプレートへの切り替えは `RunSummary.layout` に記録して利用者に見せる。

## 11. 再エントリ設計（durable = ファイルの checkpoint。ライブラリは使わない）

長い論文の翻訳では、「用語集の構築＋節ごとの翻訳×多数＋評価ループ＋組版」で、高コストな LLM の呼び出しが多数走る。途中で落ちても（crash / Ctrl-C / 再起動 / スリープ / API のタイムアウト）**完了済みの高コストなステップを再実行しない**ことを、durable の中心に置く。

- 方式は「状態はファイル」。durable 実行のライブラリ（Temporal / Restate / DBOS）も常駐サーバーも使わない。素の TS と `fs` で、checkpoint を**エージェントの呼び出しの境界に人手で置く**。
  - Flue の「Workflow は非 durable」は、「任意のコードを**自動では** checkpoint しない」という意味であって、checkpoint そのものは置ける。境界を自分で決めるこの形は、「独立して読めるワークフロー」という要件とも両立する（イベントログと manifest で状態を持つ設計と同じ形）。
  - 常駐サーバーの案は採らない: ディスクに永続化するなら本方式の作り直しになり、メモリだけなら「サーバーが落ちたら全部失う」ことになって、再起動にも耐える本方式より弱い。サーバーが要るのは、複数のクライアントや並行のオーケストレーションが必要になったときで、単発の CLI での翻訳には当たらない。
- 保存先: 論文ごとのフォルダの下の `article/<paper>-ja/.run/steps/<step>.json`（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) 決定 1。見えるが触らなくてよい trace の領域）。書き込みは tmp→rename の原子的な更新で行う。
- 再開: 同じ `run-id` で再実行する。各ステップを checkpoint で包み、「出力が既にあり、zod のスキーマで妥当なら、読んで skip する」（idempotent-skip）。
- 編集による無効化: ユーザーが `glossary.md`／`brief.md`／`style.md` を編集して再実行したときは、これらを注入する**下流の翻訳ステップの checkpoint を無効化**して訳し直す（checkpoint のキーに、注入するコンテキストのハッシュを含める）。取り込み・用語の収集など、影響を受けないステップは skip のまま。
- リトライは一時的なエラーだけ（API のタイムアウト・429・瞬断を、数回バックオフして）。ビルドの失敗・図の欠落・品質の未達など、タスク自体の失敗はリトライせず、明示的にエラーにする（境界は [品質ゲート ADR](../adr/20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) 決定 3）。
- 実装のイメージ:

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

## 12. 決定と明示的な保留（2026-07-08 決着）

旧「未決事項」を解消した。6 項目は、「1 つの戦略の分岐と、それに従う項目」にまとまった。

### 決定

- 実装の順は「用語 DB v1 が先」。[翻訳パイプライン ADR](../adr/20260708-translation-pipeline-ingestion-and-figures.md) の「用語 DB を最優先・実装の第一歩」をあらためて認めた（§12 で「未決」としていたのは記載ミス）。
- 場所とスタックは「JPaper(TS) で新しく組む」。用語 DB は `node:sqlite`。ただし SQLite のファイルと CLI の設計にして `資料/` からも呼び出せるよう共有し、既存の翻訳作業からもすぐ使える形にする。`資料/` は参照・検証用に置いておく（追跡対象外）。基盤 ADR（JPaper/TS）の前提と一致する。

### 明示的に保留（未成熟な段階で固定しない、という決定）

以下は PDF-only の抽出の PoC の論点。source-first で多くの論文が解決するので後回しにする投資で、しかも**一度実際に走らせないと妥当に決められない**。PoC に着手したときに、PoC の中で決める。

- PDF-only: Nougat 単体で割り切るか、本文=native / 表=pdfplumber のハイブリッドにするか。
- Nougat の実行環境: Docker を前提にするか（GPU とモデルの配布の都合）。
- 依存の導入: `nougat-ocr` / `pymupdf` / `pdfplumber` を入れるか。
- インライン数式の分離の精度（ディスプレイ数式は分けやすく、インラインは難しい）。

### 別途、実装の着手前に議論するもの → §13 で決着

- ランタイムの実装の細部（system prompt の部品化・サブエージェントの使い分け・決定性の回帰テスト）。

## 13. ランタイムの実装の細部（2026-07-09 決着。汎用エージェントの機構を JPaper 向けに絞る）

用語のモデルは [用語アーキテクチャ ADR](../adr/20260709-terminology-architecture-two-tier-classified-glossary.md) で確定した。ここでは薄いランタイムの 3 点を詰める。方針は「汎用エージェントの機構をそのまま持ち込まず、JPaper に要る分だけにする」。

### A. system prompt の組み立て: 3 つの部品を固定の順で合成する
汎用エージェントの system prompt は 5 つの部品で構成されがちだが、JPaper に要るのは 3 つ。**固定の順で部品を合成する薄いビルダー**を持つ（出力は決定的で、スナップショットテストができる）。

1. 役割の定義: translator / evaluator / glossary-builder それぞれが何をする役か（「本文だけ訳す」など）
2. 共通の規約: 責務の境界（構造・数式・図・引用はコードが持ち、AI は本文だけ）と、出力の契約（zod に載る JSON）。全 agent で重複させず、1 か所に置く。
3. run-context: 論文のメタ情報と、**論文ごとの確定辞書・rendering のルール・文書ブリーフ(`brief.md`)・文体契約(`style.md`)**を動的に注入する（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定 1。並列に翻訳しても、主張の強さと文体を文書全体で揃えるための元になる）。

落とす 2 つ: 日時（論文の翻訳に関係なく、YAGNI）、skill の段階的な読み込み（用語 DB の retrieval がその役割を果たすので、汎用の skill の仕組みは当面要らない）。

### B. サブエージェント/ツールの形: 事前注入・純粋な変換器
「サブエージェントをツールにする方式」と「別プロセスへ dispatch する方式」の使い分けは、素の TS のワークフローを選んだ JPaper には当たらない。

- エージェントの呼び出しは、`session.run(agent, input)` を**ワークフローの TS が直接つなぐ**（glossary-builder → translator → evaluator）。エージェント同士は互いを知らない（委譲先を選ぶのはコード）。
- 用語は retrieval-then-inject（事前注入）。エージェントは**ツールを持たない純粋な変換器**（入力→zod の出力）に保つ。薄いランタイムに tool の実行ループを入れない。
- 理由: cloud（公式 CLI を子プロセスで動かす）では LLM のツールを制御しにくく、事前注入なら local と cloud の両方で同じインターフェースにできる。将来 tool-calling が要れば足す。

### C. 決定性の回帰テスト: FakeLlmClient で配線を検証する
`LlmClient` を差し替えられるようにしたので、テストでは **`FakeLlmClient`（固定またはスクリプトの応答）を注入**し、配線を LLM 抜きで決定的に vitest で検証する（CLAUDE.md の「`pnpm test` は LLM を含めない」を実現する）。

- 決定的にテストするもの: セグメントの分割 / 組み立て(訳文+manifest→tex) / 用語 DB のクエリ・書き戻し / zod の検証 / `\ref`・全図の形式検査 / checkpoint の idempotent-skip（`brief.md`/`style.md`/`glossary.md` の編集で下流だけを無効化）/ system prompt のビルダーの出力（brief/style の注入を含む）/ 品質ゲートのループの回数・`MAX_REVISIONS` 超過で failed / rendering の適用（`bilingual` は文書の初出のセグメントだけ `値(Value)`、以降は `値`／`keep-original` はすべての出現で原形。契約付録 §8）/ 訳注の採否（trigger の決定的な規則: paper-defined の preserve・低確信=DB に confirmed が無い・warn）・文書の初出だけ脚注にすること。
- テストしないもの: 翻訳の品質・evaluator の判定・**文書ブリーフ／文体契約／訳注の文面**（いずれも LLM が生成し、非決定的。実行時の品質ゲートに任せる）。

## 14. 翻訳の一貫性: 文書ブリーフ・文体契約・訳注（2026-07-10 決着）

学術翻訳の実務のレポート（deep-research）を今の spec と突き合わせ、**用語以外の 3 つの次元**が欠けていたことを [翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) で確定した。いずれも、「節を並列・独立に訳す」今のアーキテクチャで、節ごとには良くても文書全体では揃わない問題への手当て。値・スキーマの正本は [契約付録](./contract-appendix.md)。

- 文書ブリーフと文体契約（決定 1）: glossary-builder が全文を 1 回読むときの副産物として、`brief.md`（主張の構造・記法の規約）と `style.md`（既定=である調・常体）を確定・ロックし、すべての translator の run-context に注入する。両者は `<paper>-ja/` にあり、見えて編集できる。研究にある「試訳で先に文体を固定する」ことを、新しいステージなしで実現する。
- evaluator の評価軸の明文化（決定 2）: 主張の強さ・hedging・統計語（`significantly`=有意）・単位の表記を評価軸に加える。
- 訳注（決定 3）: 採否は決定的な trigger（paper-defined の preserve／低確信=DB に confirmed が無い／evaluator の warn）、文面は LLM。データは (A) の `notes.json` と `glossary.md` の印で作り、PDF には (B) で**文書の初出だけ脚注にし、巻末に「訳注一覧」**を描く。PDF しか読まない使い方でも訳注が届く。
- 言語整合の lint（決定 4）: 単位・略語の初出・表記ゆれの決定的な検査を (B) の全文ゲートへ入れる（PerfectIt 相当まで）。
- 落とし穴の skill（決定 5）: 統計語・SI・false friend の注意リストを [`.agents/skills/translation-pitfalls`](../../.agents/skills/translation-pitfalls/SKILL.md) に置き、**evaluator だけ**に段階的に読ませる。DB は空で始める方針を保つ。
