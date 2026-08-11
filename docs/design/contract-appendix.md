# 契約付録（実装契約の正本）— source-first コア v1

> 会社B（実装ベンダー）へ渡す**実装契約の正本**。ADR が「なぜ」を、本書が「何を・どの形で・どの値で」を固定する。zod は実装時に `src/` へ写し、ここを唯一の参照元とする。乖離は変更管理の対象。
> スコープ: **v1 = source-first（arXiv LaTeX ソース有り）に限定**。PDF-only 抽出（Nougat/GPU/Docker/Python 依存）は **Phase2（別フェーズ・T&M）**。関連 ADR: [基盤](../adr/20260708-adopt-deterministic-agent-architecture.md) / [品質ゲート](../adr/20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) / [2層化](../adr/20260709-quality-gate-two-layer-and-build-error-triage.md) / [用語](../adr/20260709-terminology-architecture-two-tier-classified-glossary.md) / [プロバイダ](../adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) / [UI/配置](../adr/20260709-user-interface-file-layout-and-cli.md)。

## 1. エージェント I/O（zod スキーマ）

純変換器（ツール無し・入力→JSON テキスト出力→zod 検証）。LLM 出力はプロンプトで JSON を指示し、`result` テキストを zod で検証、壊れていたら形式検査で弾いて再訳。

```ts
// 用語（per-paper 確定辞書の1エントリ。translator へ注入する形）
const TermClass    = z.enum(["established", "paper-defined", "proper-noun", "do-not-translate"]);
const Rendering    = z.enum(["translate", "bilingual", "keep-original"]);
const ResolvedTerm = z.object({
  src: z.string(),
  form: z.string(),                 // 確定訳/表記（例: "アテンション" / "値(Value)" / "Transformer"）
  class: TermClass,
  rendering: Rendering,
  firstOccurrence: z.boolean(),     // このセグメントで初出か（決定的インデクサが算出）
  note: z.string().optional(),      // 訳注の文面（LLM 生成）。preserve/低確信の理由。trigger 該当時に surface
});

// translator: 入力→出力。priorJa/issues は再訳(revise)時のみ埋める
const TranslatorIn  = z.object({
  segmentId: z.string(),
  latex: z.string(),                // クリーンな原文 LaTeX（当該セグメント）
  glossarySlice: z.array(ResolvedTerm),
  priorJa: z.string().optional(),   // 再訳時: 前回の訳
  issues: z.array(z.string()).optional(), // 再訳時: evaluator の指摘
});
const TranslatorOut = z.object({ segmentId: z.string(), ja: z.string() });

// evaluator: 品質判定。数値閾値は持たない（品質は LLM の verdict）
const EvalIssue   = z.object({
  severity: z.enum(["error", "warn"]),
  message: z.string(),
  span: z.string().optional(),
});
const EvaluatorIn  = z.object({ segmentId: z.string(), srcLatex: z.string(), ja: z.string() });
const EvaluatorOut = z.object({
  verdict: z.enum(["pass", "revise", "fail"]),  // pass=抜ける / revise=issuesで再訳 / fail=即failed
  issues: z.array(EvalIssue),
});

// glossary-builder: 収集済み候補→per-paper 確定辞書（全文1回でロック）
const GlossaryBuilderIn  = z.object({
  paperId: z.string(),
  candidates: z.array(z.object({    // 収集[決定的]の結果＋global 候補の retrieval
    src: z.string(),
    globalCandidates: z.array(z.object({ ja: z.string(), domain: z.string().optional(), description: z.string().optional() })),
    definedInPaper: z.boolean(),    // "we define/call", \newcommand, 強調初出 で検出
  })),
});
const GlossaryBuilderOut = z.object({
  resolved: z.array(ResolvedTerm.omit({ firstOccurrence: true })), // note は残す（訳注の文面）
  brief: DocumentBrief,             // 決定1: 全文パスの副産物（全 translator に注入）
  style: StyleContract,             // 決定1: 文体契約（既定=である調・常体）
});
// firstOccurrence は翻訳配線側の決定的インデクサが後付け（translator に判定させない）

// 文書ブリーフ（brief.md の正本。可視・編集可）
const DocumentBrief = z.object({
  thesis: z.string(),                                        // 論文の主張の核
  sectionRoles: z.array(z.object({ id: z.string(), role: z.string() })), // 各節の役割
  notationConventions: z.array(z.string()),                  // 記法規約（変数・記号の使い方）
  claimStrengthNotes: z.array(z.string()).default([]),       // 主張強度/hedging の注意
});
// 文体契約（style.md の正本。可視・編集可。既定は register=plain=である調・常体）
const StyleContract = z.object({
  register: z.enum(["plain", "polite"]).default("plain"),    // plain=である調・常体
  tensePolicy: z.string(),                                   // 時制方針（例: 結果=過去）
  headingStyle: z.string(),                                  // 見出し訳の方針
  numberStyle: z.string(),                                   // 数字・単位表記
  notes: z.array(z.string()).default([]),
});

// 訳注（uncertainties）。採否=trigger は決定的 / 文面=LLM（heading-untranslated のみ決定的）。data=(A) / render=(B)
const NoteTrigger    = z.enum(["paper-defined-preserve", "low-confidence", "evaluator-warn", "heading-untranslated"]);
const TranslatorNote = z.object({
  id: z.string(),
  trigger: NoteTrigger,
  src: z.string().optional(),       // 対象語（term 系 trigger のとき）
  segmentId: z.string(),
  firstOccurrence: z.boolean(),     // 文書全体で初出か（脚注はここだけ・巻末は1エントリ）
  text: z.string(),                 // 文面（LLM 生成: term=ResolvedTerm.note / warn=EvalIssue.message。heading-untranslated のみ決定的テンプレ）
});
```

## 2. 用語 DB（SQLite / `node:sqlite`）

- 置き場: グローバル共有 `~/.jpaper/glossary.db`（`JPAPER_HOME` で上書き可）。
- **実装は `node:sqlite`。これは Node 22.5+ を要するため `package.json` の `engines` は `>=22.5`**（node:sqlite を維持し追加依存ゼロを保つ判断。2026-07-09 確定）。
- global term テーブル（`src` に UNIQUE を張らない＝1語=複数候補を許す）:

```sql
CREATE TABLE term (
  id          INTEGER PRIMARY KEY,
  src         TEXT NOT NULL,
  ja          TEXT,
  class       TEXT NOT NULL,          -- established|paper-defined|proper-noun|do-not-translate
  rendering   TEXT NOT NULL,          -- translate|bilingual|keep-original
  domain      TEXT,
  description TEXT,
  aliases     TEXT,                   -- JSON 配列
  status      TEXT NOT NULL CHECK(status IN ('confirmed','proposed')),
  source      TEXT                    -- 初出/追記元の paperId
);
CREATE INDEX idx_term_src ON term(src);
-- dedup キー = (src, ja, domain)。書き戻しは status='proposed' で追記、既存(src,ja,domain)は再追記しない。
```

- per-paper 確定辞書は人間可読・編集可能な `./<paper>-ja/glossary.md`（正本）＋ `.run/` 内の派生キャッシュ。ユーザーが `glossary.md` を編集→再実行すると durable が未影響ステップを skip し訳語だけ差し替わる。
- **機械出力の md は run が最後まで到達したときだけ outDir へ確定する**（`glossary.md` / `brief.md` / `style.md`）。中断・例外で抜けた run の中間物を残すと、人間が一度も見ていない機械出力が次の run の正本になり、入力を直しても差し替わらなくなる。**組版に失敗した run（exit 5）でも確定しない**（確定は組版の後に置く）。翻訳自体が失敗して組版へ進まなかった run は最後まで到達しているので確定する。LLM の成果は `.run/steps` の checkpoint に残るため、確定を見送っても再実行のコストは増えない。確定時に `<outDir>/.paper-id` へ論文 ID を記録し、**別の論文が同じ outDir を使うときは既存 md を採用しない**（警告を出して作り直す）。採用しないと、論文 A の brief が論文 B の全 translator プロンプトへ注入される。印が無い出力先（旧版が作ったもの）はこれまでどおり採用する。
- 初期シード: **v1 は空で開始**し、翻訳のたびに `proposed` を蓄積して育てる（同梱シードなし）。`input/` は空のまま（`.gitkeep` のみ）。人間が `proposed`→`confirmed` に昇格。

## 3. 品質ループ（値の正本）

- 単位: セグメント（節）。2層＝[節ループ軽検査＋evaluator] と [全文組版ゲート]（[2層化 ADR](../adr/20260709-quality-gate-two-layer-and-build-error-triage.md)）。
- `MAX_REVISIONS`: セグメントサイズ連動 **小=3 / 中=4 / 大=5**（下限3・上限5）。区分は**絶対トークン閾値**（プロバイダ非依存＝決定的テストのゴールデン値が揺れない）: 小 `<1500` / 中 `<3500` / 大 `>=3500`（§4 の自前推定器で計測）。超過→failed。形式検査の差し戻しもカウント。
- evaluator の合否は**不変条件**で決める（`verdict` 単独では決めない）: **出版可能＝`verdict≠fail` かつ `error` 級 `issue` が無い**。この時のみ pass（`warn` は非ブロッキングで訳注へ流す）。それ以外は `issues` を translator の再訳入力へ回し、`verdict=fail` は即 failed（再訳しない）・`MAX_REVISIONS` 超過も failed。`error` 級 issue があれば `pass` verdict でも通さない（重大問題の素通しを防ぐ）。**severity の正しい割当は evaluator の責務**（下の rubric で規定）で、意味反転など地の文の意味的欠陥に対する決定的検出器は存在しないため、決定的ハードゲートは §7 の形式検査に限る。実装が持つ検査は `math` / `graphics` / `label` / `paragraph` / `keep-original` / `bilingual` / `untranslated` / `unsafe-command` の 8 種（正本は `src/workflows/quality-gate.ts`）。`unsafe-command` は訳文が持ち込んだ危険コマンド、`untranslated` は原文のままの残留を捕まえるが担う。`untranslated` の判定に使う「地の文」からは**訳す対象でない環境**（`thebibliography` / `verbatim` / `lstlisting` / `minted` / `alltt`）を除く。除かないと、参考文献やコード片の英字が地の文として数えられ、本文を丸ごと未訳のまま残した訳文が未訳率の閾値を下回って pass する（除去は線形走査で行う。正規表現で環境を畳むと入れ子・未閉じで二次になる）。**地の文の抽出は行コメントを先に落とす**（`%` でコメントアウトした `\begin{verbatim}` に反応すると、囲まれた英語＝PDF には出る本文が地の文から消える）。**判定の入口は原文側の地の文の量**にする（訳文側の語数を入口にすると、訳文で地の文を消すだけで検査ごと無効化できる。実測: 訳文「あ」1 文字とコメント囲みの 2 通りで 8 種すべて `[]`・exit 0）。原文に `MIN_PROSE_WORDS` 以上の地の文があるとき、訳文の日本語が原文 1 語あたり 0.5 文字を下回れば `untranslated` とする（実訳は 1 語 ≒ 1.5〜2.5 文字。下限は目標値ではなく床として大きく余裕を取る）。
- **evaluator 応答の上限**: `EvalIssue.message` / `span` は `MAX_ISSUE_CHARS`（500 文字）、`issues` は `MAX_ISSUES`（20 件）。プロンプト膨張（＝コスト増幅）と指示文の埋め込みを抑えるため（[信頼できない文字列は指示にしない ADR](../adr/20260811-untrusted-text-never-becomes-instructions.md)）。正本は `src/runtime/untrusted.ts`。
- **evaluator rubric（明示軸・[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定2）**: 従来の「自然さ・専門用語妥当性・原意保持」に加え ①**主張強度・hedging の保持**（断定/限定/推量を原文どおり）②**統計語の忠実**（`significantly`=有意・p 値の含意）③**単位・記法の正しさ**（SI＝立体・`°K`→`K`・数値と単位の間隔）を判定する。②③の一部で決定的に落とせるものは §7 (B) の言語整合 lint に回す。
- **warn→訳注の連動**: pass に至ったセグメントに残った `warn` の `issue` は、`TranslatorNote{ trigger: "evaluator-warn", text: issue.message }` として §8 の訳注に流す（`verdict` が `pass`/`revise` いずれでも、`error` を含まず上の不変条件で pass すれば warn を可視化）。品質は落とさず読者に見せる。
- 全文ゲート失敗の分類: 翻訳起因の LaTeX 文法ミス→失敗スニペット＋エラー行のみで再訳 / 構造・テンプレ起因→明示的失敗。

## 4. セグメント分割・トークン予算（モデル非依存）

- 境界: `\section`/`\subsection` を第一境界。1セグメントがトークン予算超過なら段落境界で再分割。分割は決定的関数（テスト対象）。
- 予算はモデルのコンテキスト窓 `CW` から逆算:
  - 原文セグメント上限 `segmentBudget ≈ 0.30 × CW`
  - 訳出予約 `= 1.5 × segmentBudget`、思考余白 `= max(2_000, 0.15 × CW)`、残りを システム/辞書オーバーヘッド＋安全に充てる。
  - `CW` は**プロバイダ設定の定数**（claude subprocess はモデルを渡さないので保守的に既定 `200_000`、Ollama はモデルの context を設定に明記）。実行時に設定から取得。
- **トークン計測は JPaper 自前の決定的推定器**（プロバイダのトークナイザに依存しない固定実装＝分割・MAX 判定が決定的でテスト可能）。プロバイダを変えても分割結果は変わらない。
- glossary-builder の「全文1回」も同 30% ルール。超える論文は候補集合を共有したまま確定パスを分割。**分割時の合流規則（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定1 の大域一貫を守る）**: ①`resolved` の語衝突は**初出パス優先**で確定（後続パスは既確定語を再確定しない）／②`brief`/`style` は**最終統合パスで1回だけ確定**（各分割パスは `resolved` のみ返し brief/style を出さない）。これにより長い論文でも文書ブリーフ・文体契約が1つに定まる。

## 5. プロバイダ・CLI 契約

- v1 実装 = **2つ**: `ollama`（local, オンデマンド daemon）/ `claude`（cloud, `claude -p --output-format json` の `result` を抽出）。codex/OpenRouter/API キーは将来。
- `--provider {ollama|claude}` は **必須（既定なし）**。省略はエラー（終了コード §6）。**受理値の正本は `ollama|claude`**（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) の例示 `local|cloud` は概念軸。CLI 実値は本付録が正本）。
- claude CLI は純変換器化して使う: `--append-system-prompt` で役割注入、`--max-turns 1`、内蔵ツール無効化（`--tools none`。`--allowedTools ""` はツールを無効化できずモデルが tool_use を試みて `error_max_turns` になるため不可。SHOW 検収で判明）。対応 CLI バージョンはレンジ指定し、出力 JSON 形式は統合テストで回帰検知。
- モデル ID: claude(subprocess) は CLI のログインセッションのモデルを使うため JPaper から渡さない。ollama は設定でモデル ID 明示（例 `llama3.1:8b`、変更可）。
- CLI: `jpaper <input> --provider {ollama|claude} [--out DIR]`。`<input>` は zip/tar.gz/gzip-tar/.tex.gz/.tex/ディレクトリ/arXiv ID を自動判定（判定不能は明示的失敗）。配布は `package.json` の `bin.jpaper = dist/cli.js`。

## 6. CLI 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（main.pdf 生成・全ゲート通過） |
| 1 | 想定外エラー（`internal`）／実行環境の障害（`infra`＝権限・容量・パス衝突。コードのバグと区別するため `kind` で分ける） |
| 2 | 入力形態の判定不能 / `--provider` 未指定・不正（`input`）／出力先が使用中（`conflict`）／上限超過（`too-large`）／一時的な過負荷（`busy`）／外部サービス障害（`upstream`）／LLM プロバイダ利用不能（`provider`） |
| 3 | 節ループの形式検査が MAX_REVISIONS 内に通らず failed |
| 4 | 品質未達（evaluator が pass に至らず MAX_REVISIONS 超過 or `fail`） |
| 5 | 全文組版ゲート失敗（構造・テンプレ起因のビルド/欠図/未解決参照） |
| 6 | 呼び出し側の中断（`AbortSignal`＝`canceled`。web の切断）／run 全体の期限超過（`timeout`） |

- stdout: 最終成果パスとサマリ JSON。stderr: 進捗・エラー。

## 7. 見積りスコープ（2段構成・2026-07-09 確定）

新B レビューを受け、v1 を2段で発注する。

- **(A) 固定価格 = コア**: 用語 DB（`node:sqlite`）／薄いランタイム＋エージェント配線／節ループ品質ゲート（形式検査＋evaluator＋再訳）／durable checkpoint／CLI・プロバイダ。§1–6・§8 の契約で確定。
- **(B) 上限付き T&M = 組版・図・引用レイヤ**: `assemble-latex`（訳文＋manifest→`main.tex`/chapters。**既定は原プリアンブル温存＝レイアウト忠実、日本語で組めない論文は共通 luatexja テンプレへ明示的フォールバックし `RunSummary.layout` に記録**。[組版レイアウト ADR](../adr/20260710-typesetting-layout-original-first-hybrid.md)）／共通プリアンブル・引用マクロ・日本語フォント設定は原プリアンブルへ注入する共有部品／全文組版ゲートのビルドエラー分類＋エラー行→セグメント逆引き／`.bbl` 番号順パース＋`\cite`→番号対応表／図 manifest／**言語整合 lint（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定4: 単位 SI 表記・略語初出定義・glossary 外の訳語表記ゆれ・数字表記を決定的に検査。PerfectIt 相当まで許容）**／**訳注レンダリング（決定3: `notes.json`→本文の文書初出のみ `\footnote`＋巻末「訳注一覧」）**。工数の幅が大きいため実費上限方式。
- **Phase2（別フェーズ）**: PDF-only 抽出（Nougat/GPU/Docker/`nougat-ocr`/`pymupdf`/`pdfplumber`）／`.bbl` 著者年スタイル／`glossary.db` 並行実行。

## 7.5 (A) コアの受け入れ条件（(B) 非依存で定義）

(A) は組版=(B) を持たないため「main.pdf 生成（終了コード0・`buildOk`・`pdfPath`）」に単体で到達できない。(A) の完成を (B) から切り離して定義する（R1 解消）。

- **(A) の成果**: 節ループ品質ゲートを通過した**訳文セグメント群**（`translation/chapters/*` 相当の中間物）＋ per-paper 確定辞書（`glossary.md`）＋ **文書ブリーフ `brief.md`・文体契約 `style.md`**（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定1）＋ **訳注データ `notes.json`**（決定3。PDF 描画は (B)）＋ `RunSummary`。**組版・PDF は含まない**。
- **(A) 単体の終了コード**: `0`=全セグメントが節ループ通過（翻訳完了・組版前）／`2`=入力・プロバイダ／`3`=形式検査が MAX 内に通らず failed／`4`=品質未達 failed。`5`（全文組版ゲート）・`pdfPath`・`buildOk` は **(B) 結合後に評価**（(A) 単体では `RunSummary.buildOk = null`）。
- **(A) の検収**: ①`FakeLlmClient` 注入で配線・段階遷移・checkpoint の idempotent-skip・`MAX_REVISIONS` 到達 failed が決定的に再現（**両プロバイダの配線とも Fake で検収**）、②**実 LLM 検収は `claude` プロバイダ**（会社A の claude code CLI ログインセッション）で訳文セグメント＋`glossary.md`＋`brief.md`/`style.md`＋`notes.json`＋`RunSummary` が生成されること。組版通過は (B) 検収項目。
- **プロバイダ別の (A) 完了範囲（A-1 決着）**: `ollama` プロバイダの**実装（`LlmClient` 実装・オンデマンド daemon・設定契約）は (A) に含む**が、**実機（実モデル）検証は後回し**（別途）。`claude` を実 LLM 検収の基準プロバイダとする。両者の配線の決定的検収（①）は (A) 必須。

## 8. 追加契約（新B レビュー反映）

- **core API**: `translatePaper(input: JpaperInput, opts: TranslateOptions, deps?: TranslateDeps): Promise<Result>`。`TranslateOptions = { provider; outDir?; ollama?; concurrency?; signal?; timeoutMs? }`、`TranslateDeps` は web が差し替える依存（`client` / `trace` / `cacheKey` / `db` / `dbPath` / `ingest` / `limits` / `work` / `gate` / `onError` / `onProgress` / `latexRunner`）。`Result = { status: "ok"|"failed"; pdfPath?: string; exitCode: number; error?: RunError; summary: RunSummary }`。CLI・GUI はこの1関数を呼ぶ薄い皮（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) 決定4）。例外は投げず `status/exitCode` で表現（§6 と対応）。
- **stdout サマリ JSON**: `RunSummary = { paperId, outDir, segments: {total, passed, failed}, revisions: {max, used}, glossary: {proposedAdded}, notes: {total, byTrigger}, layout: "original"|"template"|null, buildOk: boolean|null, sharedDefaults: ("db"|"cacheKey"|"outDir"|"limits"|"work")[], llmCalls, exitCode }`（zod 定義を実装時に写経）。`layout` は採用した組版モード（[組版レイアウト ADR](../adr/20260710-typesetting-layout-original-first-hybrid.md)。`original`=原プリアンブル温存／`template`=共通テンプレへフォールバック）。組版は (B) のため **(A) 単体では `layout=null`**（`buildOk=null` と同様）。`notes` は §1 `TranslatorNote` の件数集計（本体は `notes.json`）。`byTrigger` は `paper-defined-preserve|low-confidence|evaluator-warn|heading-untranslated` 別の件数。
- **訳注の生成契約（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定3・採否=決定的 / 文面=LLM）**: trigger を次の決定的規則で採る。①`paper-defined` で `rendering∈{keep-original,bilingual}` に確定した語 ②**低確信=`class="established"` かつ global DB に `status="confirmed"` の一致が無く `proposed` のみ or 未ヒットで preserve に倒した語**（DB 状態から決定的に判定）③evaluator の `warn` issue ④**heading-untranslated=見出し（`\section` 等）の可視テキストが未訳の可能性（`untranslatedHeadings` の決定的検査。非ブロッキングで再訳ゲートには載せない）**。文面 `text` は term 系＝`ResolvedTerm.note`、warn 系＝`EvalIssue.message`、heading 系＝決定的テンプレ（LLM 非依存）。`firstOccurrence`（文書全体基準）で本文脚注は初出1回のみ、巻末一覧は語ごと1エントリ。④の決定は [見出し未訳検査 ADR](../adr/20260721-heading-untranslated-nonblocking-note.md)。
- **run-context 注入（brief/style）**: `DocumentBrief`＋`StyleContract` は全 translator へ渡すが、**載せる先は system ではなく user メッセージ**である。論文由来・LLM 由来の文字列は指示にしてはならないため（[信頼できない文字列は指示にしない ADR](../adr/20260811-untrusted-text-never-becomes-instructions.md)）。system は run をまたいで固定の文字列だけで構成し、それがキャッシュ prefix の安定化を担う（[プロンプトキャッシュ再利用 ADR](../adr/20260722-prompt-cache-reuse-stable-system-prompt.md)）。per-segment の確定用語ブロック（rendering 指示）も user 側。トークン予算は §4 の 30% 圏内で管理する。**超過時の圧縮は「要約」ではなく切り詰め**（`MAX_BRIEF_CHARS` / `MAX_BRIEF_ITEMS` でスキーマ側から縛る。要約は LLM 呼び出しを増やすうえ、圧縮結果が非決定になる）。
- **リトライ（`isTransient`）**: 対象＝ネットワーク瞬断・タイムアウト・HTTP 429/5xx・Ollama 一時的接続不可。回数3・指数バックオフ（初期 1s, ×2, 上限 10s）。それ以外（タスク失敗）はリトライせず surface。
- **形式検査の合否規則（節ループ内・決定的）**: 数式保全＝原文と訳文で `$...$`／`\[...\]`／`\begin{equation|align|...}` の**個数一致**（中身は問わない）。段落欠落なし＝**訳文段落数 ≤ 原文段落数**（日本語で複数段落を自然に統合するのを許容。分割・水増しは不可）。ただし訳文段落数が原文の **50% 未満**なら明らかな欠落として error。`keep-original` 一貫＝当該語が全出現で原形のまま。zod 適合＝§1 スキーマ。（大セグメント `>=3500` がトークン予算 `0.30×CW` を超える場合の段落境界での再分割は §4 の core 実装＝(A) に含む。）
- **Ollama 設定契約**: 設定に `model`（例 `llama3.1:8b`）・`contextWindow`・`keepAlive`・`port`。`ollama serve` はオンデマンド起動、起動/モデル未 pull 失敗は明示案内＋**終了コード 2**（プロバイダ利用不能）。
- **claude CLI**: **基準バージョンは会社A（発注元）指定の特定版で pin** し、その版の `--output-format json` 出力（`result` フィールド）を契約スナップショットとして統合テストで回帰検知する。**以後の CLI 更新による破壊的変更への追随は (A) 固定価格スコープ外**（変更管理＝別 T&M で対応）。抽出は `result` フィールド固定。
- **arXiv ID 取得（(A) スコープに含む）**: `<input>` が arXiv ID のときソース tarball を取得。取得先は `export.arxiv.org` の source エンドポイント、**明示的な User-Agent を付与**し、**3 秒間隔以上**のレート制限を守る（arXiv の robots/レート方針準拠）。標準値は会社B が実装しレビューで確定。ネットワーク不可/取得失敗は明示的失敗（終了コード 2）。
- **`LlmClient` 境界の型（正本）**: `type LlmClient = { complete(req: { model?: string; system: string; user: string; meta?: LlmCallMeta; jsonMode?: boolean; signal?: AbortSignal }): Promise<string> }`。`model` は claude(subprocess) では未使用＝optional、Ollama/将来 API では必須。`meta`（`{role, phase?, segmentId?, pass?}`）は呼び出し文脈でトレース専用＝変換結果に影響しない optional。`signal` は呼び出し側の中断で、プロバイダは進行中の I/O（fetch / subprocess）を中止する。`jsonMode` は JSON 出力要求で、ネイティブ構造化出力を持つプロバイダ（Ollama＝`format:"json"`）だけが強制に使い claude CLI は無視（プロンプト指定に委ねる）＝[構造化出力 ADR](../adr/20260723-provider-branched-structured-output.md)。戻り値は**JSON テキスト文字列**（呼び出し側が extractJson→zod.parse）。system は §13A のビルダー出力（role固有＋COMMON＋brief/style。確定用語は user 側＝[プロンプトキャッシュ再利用 ADR](../adr/20260722-prompt-cache-reuse-stable-system-prompt.md)）。
- **LLM 呼び出しトレース（[LLM トレース ADR](../adr/20260722-llm-call-trace-local-jsonl.md)）**: プロバイダは成功呼び出しごとに応答の usage/コスト/latency に `meta` を添えた `LlmCallEvent` を DI された `TraceSink` へ emit する（`complete` の戻り値・純変換器契約は不変＝副作用チャネル）。run 層が runId を stamp し `<outDir>/.run/llm-trace.jsonl` へ 1 行 1 レコードで追記（**メタのみ・本文/訳文は含めない**・runtime 生成物＝gitignore）。Langfuse は不採用、schema 安定化で将来の opt-in exporter の door を残す。
- **`JpaperInput` 型（正本）**: `type JpaperInput = { kind: "path"; path: string } | { kind: "arxiv"; id: string }`。CLI の `<input>` 文字列を判定してこの discriminated union に正規化。判定不能は終了コード 2。
- **`paper-defined`/`bilingual` の厳守も機械検査に含む**（rendering 別に規則を分ける。用語ADR決定2 の「bilingual=初出のみ併記」を正とし、旧 §13C 例の「全文統一」は誤りとして訂正）:
  - `keep-original`（および `paper-defined` で keep-original 確定の語）＝**全出現で原形**が保たれているか。
  - `bilingual`＝**文書全体で初出のセグメントでは併記形 `form`（例 `値(Value)`）、以降のセグメントでは日本語部分のみ（例 `値`）**が使われているか。初出判定は `firstOccurrence`（文書全体基準の決定的インデクサ）に一致させる。
  - いずれも「form が全出現で一致」ではなく上記の rendering 別規則で判定する（決定的テスト可）。
- **組版へ渡す LaTeX の安全検査**: 論文プリアンブルは翻訳されず verbatim に持ち越されるため、節ループの品質ゲートでは一切検査されない。取り込み直後に**原文全体**（プリアンブル含む）を走査し、読み出し・Lua 実行・書き込みプリミティブ（`\openin` / `\read` / `\directlua` / `\openout` / `\write` 等。正本は `src/tools/tex-safety.ts`）を含むなら `kind="input"` で拒否する。LLM を呼ぶ前に弾く。組立後の main.tex も latexmk へ渡す前に再検査する（多層防御）。`^^` 記法と `\csname` による綴りの組み立ては展開してから照合する。`\usepackage` は正規の用途があるため対象外。**読み込みコマンド（`\input` / `\include` / `\InputIfFileExists` / `\import` 等）は名前では落とせないので、引数の形で判定する**: 引数が絶対パス・`~`・`..` を含むもの、および `\csname` で綴りを組み立てたものを拒否する（`\csname input\endcsname{/abs}` は `expandInputs` の正規表現に一致せずプリアンブルに残り、latexmk が実際に読んで PDF へ出す＝実測で流出を確認した経路）。素の `\input{/abs}` は `expandInputs` が build ツリー外として除去するため cleanLatex に残らないが、多層防御として検査面にも残す。多引数の読み込み（`\import{dir}{file}` 等）は**全ての引数**を検査する（第 1 引数だけ見ると `\import{./}{../secret}` が無害に見え、実機で流出を確認した）。**main.tex では引数が制御綴りの読み込みも拒否する**（`\input\p` は展開結果が静的に分からない）。同梱支援ファイルにはこの規則を適用しない（配布クラスは動的引数を日常的に使い、実測 18 件中 10 件が該当する）。引数の走査は TeX の空白（改行・CR・FF）を読み飛ばす（空白とタブだけ飛ばすと、改行を 1 つ挟むだけで引数が空に見え、パスの検査が走らない。実機で流出を確認した）。`expandInputs` は `\input` / `\include` に加えて `\@@input` も畳む（scanner だけに頼らない）。**`\csname` の本体に制御綴りが含まれる場合は main.tex では一律拒否する**（`\def\x{directlua}\csname\x\endcsname` は実機で `\directlua` として発火し、LuaTeX の `io.open` による任意ファイル読み出しが PDF に出た。LuaTeX の読み取りは shell escape の設定と無関係に有効）。同梱支援ファイルには適用しない（配布 18 件中 12 件が該当）。静的に決まる `\csname` は**本体全体**で照合する（トークン分割で照合すると `\csname my-input\endcsname` のような配布 `.sty` を落とす）。**論文が同梱する `.sty` / `.cls` / `.bst` / `.bib` / `.bbl` も検査面に含める**が、対象は**配布版に shadow されないもの**（＝実際に読み込まれるもの）に限り、denylist は任意読み出しと Lua 実行のみ（`\directlua` 系 / `\openin` / `\read` / `\readline`）に絞る。`\write` / `\openout` を支援ファイルで禁じると、`elsarticle.cls` などを同梱した正規の論文が落ちる（実測 12 件中 8 件）。`\csname` の本文は大小文字を畳んで照合する（制御綴りそのものは TeX の意味論どおり区別する）。**shadow 判定に使う `kpsewhich` は部分解決を捨てない**: 未解決の名前が 1 つでもあると終了コードが 0 以外になるが、解決できた分は stdout に出るので、非 0 でも stdout を読む（捨てると同梱ファイルが全て「配布版に shadow されない」と判定され、検査対象が不要に広がる）。`kpsewhich` が無い環境では空集合＝全て検査対象へ倒す。**綴りの列挙は漏れる**（実測: `\lstinputlisting` / `\@input` / `\verbatiminput` / `\VerbatimInput` / `\inputminted` / `\CatchFileDef` / `\includegraphics` / `\includepdf` / `\addbibresource` / `\bibliography` の 10 種が素通りし、実機で `status=ok` / `buildOk=true` のままホストのファイル内容が PDF に出た）。列挙は維持したうえで、**親参照（`../`・`/../`）・`~/`・Windows のドライブ指定はコマンド名によらず落とす**。論文が本文でパスを見せる表示系（`\texttt` / `\url` / `\path` / `\verb` / 見出し等）だけを allowlist にし、列挙の向きを反転させる。**素の絶対パス（`/` 始まり）は一般規則の対象にしない**（pgf/tikz の key path `\pgfkeysvalueof{/tikz/…}` と静的に区別できず、TeX Live 配布 6,570 件で 660 件＝10% の誤検知になる）。図・文献リソース（`\includegraphics` / `\includepdf` / `\addbibresource` / `\bibliography`）はマクロ引数を許す（正規の書き方。strict にすると main で 145 件の誤検知増）。一般規則の走査コストは**件数ではなく実走査量**で抑える（件数だと正規の文章の `\texttt{/usr/…}` だけで上限に達し、正しい論文を `too-large` で落とす）。決定と残存リスク（列挙外のコマンドに素の絶対パスを渡す形は通る＝OS 隔離が本質的防御）は [パス引数 ADR](../adr/20260811-path-arguments-are-unsafe-regardless-of-command-name.md)・[プリアンブル ADR](../adr/20260811-preamble-is-untrusted-code-not-just-layout.md)・[支援ファイル ADR](../adr/20260811-support-files-are-part-of-the-inspection-surface.md)。
- **本番運用の前提（組版の隔離）**: 上の denylist は既知の綴りしか止められない。本番では組版を**書き込み可能な作業ディレクトリ以外へアクセスできない環境**（コンテナ／別ユーザ／読み取り専用マウント）で実行すること。kpathsea の `openin_any` では代替できない（`r` は絶対パスを制限せず、`p` は luaotfload ごと壊す。`\directlua` は kpathsea を経由しない）。
- **マルチテナントで呼ぶ場合の必須注入（1 箇所にまとめる）**: 既定値は**単一ユーザ向け**であり、web で複数テナントを捌く場合はそのままでは分離できない。テナントごとに必ず渡す: ①`TranslateDeps.dbPath`（既定 `~/.jpaper/glossary.db`。`term` テーブルにテナント列は無く、`status="confirmed"` の語は DB を共有する全員に効く）②`TranslateDeps.cacheKey`（既定 `~/.jpaper` 配下の共有鍵。checkpoint 署名鍵）③`TranslateOptions.outDir`（既定は cwd 直下の `<paperId>-ja`。同じ出力先は run lock で排他されるので、テナントを分けないと互いに 409 で弾き合う）。④`TranslateDeps.limits`（既定 `DEFAULT_LIMITS` は CLI 単体利用向けに緩い。実測: 既定のまま 506KiB の `.tar.gz` が 508MiB に展開されて `status=ok` になり、ピーク RSS 1,099MiB・同期書き込み 508MiB。4 本併走で正常リクエストの p50 が 79ms→1,789ms、イベントループ停止 1,682ms。`maxTotalBytes 40MiB` に締めると p50 206ms で敵対 run は `too-large`）⑤`TranslateDeps.work`（既定 `DEFAULT_WORK_LIMITS`。1 run が使うセグメント数・LLM 呼び出し回数の上限）。**資源の分離（①〜③）より、上限（④⑤）のほうがプロセスの生死を左右する。**既定へフォールバックした資源は `RunSummary.sharedDefaults`（`"db" | "cacheKey" | "outDir" | "limits" | "work"` の配列）に出し、`onError` にも警告を出す。**空でなければ分離できていない**という判定に使える。
- **パスの扱い**: `RunSummary.outDir` と `Result.pdfPath` はホストの**絶対パス**を返す。core は自分の外の URL 空間を知らないため写像しない。web 層が自前の識別子・署名付き URL へ写す責務を負い、そのまま応答へ透過してはならない。
- **LLM 同時実行の上限（プロセス全体）**: `TranslateOptions.concurrency`（既定 4）は run 内の上限でしかなく、1 プロセスで複数リクエストを捌く web ハンドラでは「リクエスト数 × セグメント並列」だけ呼び出しが同時に飛ぶ（claude プロバイダは 1 呼び出し = 1 子プロセス）。`translatePaper` は**注入クライアントを含む全ての LLM 呼び出し**を、プロセス全体で共有するゲートに通す（`TranslateDeps.gate` を渡すと**その外側にもう 1 段**重なる。置き換えではない。プロセスゲート自体の差し替えは test 専用の `setLlmGate` のみ）。プロバイダ生成側で掛けると、web が自前クライアント（テナント別資格情報・トレース）を注入した瞬間に上限が消えるため、run 層で一律に掛ける。上限は `JPAPER_MAX_LLM_CONCURRENCY`（既定 8・上限 64）で、**10 進整数のみ**受け付ける（`"1e9"` や `"0x10"` で無効化させない）。範囲外は既定へ戻さず端へ丸める（設定ミスが緩める方向に倒れないため）。ゲートは待機解除後に空きを再検査する（再検査しないと、`release` と待機者の再開の間に割り込んだ新規呼び出しのぶん上限を超える）。ゲートは中断ラッパの**外側**に置き、枠を取ってから中断を見る（待ち行列に中断済みが居座らない）。**待機中も中断が効く**（`Gate.run(fn, signal?)`）。効かないと、期限を持たない run が枠を握った時に、`timeoutMs` を正しく設定した他テナントの run まで返らない（実測で 100ms 指定の run が 1202ms 拘束された）。待ち行列の上限は**新規入場にだけ**掛ける（起床時の再検査で既存の待機者を落とすと、待たされた挙げ句に拒否される）。中断された待機者は**待ち行列から取り除く**（墓標を残すと上限判定だけが増え、`waiting()` が 0 のまま正当な呼び出しが `busy` で弾かれる）。`TranslateDeps.gate` は**プロセスゲートより外側**に置く（広い方を先に取ると、狭い方で待つ間もプロセス枠を占有して無関係なテナントを待たせる）。**待ち行列にも上限を掛ける**（`JPAPER_MAX_LLM_QUEUE`、既定 256・上限 4096）。無制限だと過負荷を `busy`（429）へ変換できず、返らないリクエストだけが積み上がる（実測: `makeGate(1)` に 10 万件積めた）。**`TranslateDeps.gate` はプロセス上限を置き換えず、外側の第 2 段として重ねる**（置き換えにすると、web がリクエスト単位でゲートを作った瞬間にプロセス上限が消える）。実装の正本は `src/runtime/concurrency.ts`。
- **用語集の上限**: `GlossaryBuilderOut.resolved` は件数 `MAX_TERMS`（500）、`src`/`form` は `MAX_TERM_CHARS`（200）、`note` は `MAX_NOTE_CHARS`。空の `src` は弾く。用語スライスは `seg.latex.includes(t.src)` で選ぶため、空や短い綴りを大量に返されると全セグメントのプロンプトに全件乗る（実測: 2 万件で 275 バイトの入力から 1 run 560 万文字、共有 DB に 2 万行）。`maxLlmCalls` は回数しか見ないのでバイト単位の増幅は素通りする。件数上限は proposed 書き戻しの件数上限も兼ねる。 `brief` / `style` も同じ理由で縛る（`thesis` などの文字列は `MAX_BRIEF_CHARS`=2000、配列は `MAX_BRIEF_ITEMS`=100）。brief は全セグメントの translator プロンプトに載るため、用語集と同じ増幅経路になる。
- **本文全体を走る同期パスの正規表現は量指定子を有界にする**: 攻撃者が制御する文字列に対して終端の無い量指定子（`[^}]+`・`.+?`・`[\s\S]*?`）を使うと、開始位置ごとに末尾まで走査して二次になる。用語候補収集（`src/terminology/collect.ts`）がこれで、実測 512KiB で 35,510ms・上限の 8MiB へ外挿して**約 2.5 時間**の同期停止だった（`checkpoint` は async だが中身は完全同期なので `timeoutMs` も `AbortSignal` も効かない）。**このペイロードは gzip 約 14KB** で、`maxArchiveBytes`・`maxTotalBytes`・`maxEntries`・`maxLatexBytes` のどれにも触れない＝サイズ上限では止まらない。上限は「量」だけでなく「1 文字あたりの計算量」にも要る。候補は `MAX_TERM_CHARS` に切られるので、それを超える長さを探すこと自体が無駄。
- **安全検査の走査コストの上限**: 読み込みコマンドの引数は `MAX_ARG_CHARS`（1024 文字）までしか探さず、候補数も `MAX_READ_CANDIDATES`（20,000 件）で抑える。閉じ波括弧を末尾まで探すと、閉じない `\input{` を並べるだけの入力でマッチ数 × 末尾走査 = O(n²) になる（実測 4MiB で 20,040ms、6.3KB のアップロードで 40 秒イベントループ停止）。長さの上限だけでは候補が線形に増えるので件数側にも要る。**支援ファイルは `maxLatexBytes` の対象外**（上限は `maxEntryBytes` だけ）なので、走査対象サイズにも上限（8MiB）を掛け、超えるものは読まずに危険として扱う。**打ち切りは必ず fail-closed**（`MAX_ARG_CHARS` 内で引数が閉じなければ、strict / 支援ファイルの区別なく危険として落とす）。打ち切り時に「引数を読めていない＝無害」と扱うと、引数の先頭を空白で 1024 文字以上詰めるだけで検査を外せる（実測 `\InputIfFileExists{<空白1100>/etc/passwd}` がファイルを読み PDF に出た）。空白詰めは正規の書き方ではないので支援ファイルにも例外を設けない（TeX Live 配布 6,570 件で誤検知の増分 0 件を実測）。`\csname` 側も同型で、本体長 `MAX_CSNAME_BODY_CHARS`（1024 文字）と件数 `MAX_CSNAME_CANDIDATES`（20,000 件）で抑える（正規表現で `\endcsname` を探すと、閉じない `\csname` の羅列でマッチ位置ごとの末尾走査になり実測 1MiB で 144,204ms）。窓の起点は**制御綴り直後の空白を読み飛ばした位置**に置く（TeX のトークナイザと同じ挙動。生の位置から数えると空白 1024 文字で本体を窓外へ押し出せる）。本体が窓内で閉じない場合は、綴りが 1024 文字を超える＝denylist と一致しないので名前照合からは外し、制御綴りを含むなら展開結果が短い綴りになりうるので main.tex では `csname` として落とす。
- **LLM 応答の上限**: 応答は `MAX_RESPONSE_CHARS`（100 万文字）で打ち切る。プロバイダ側（claude の stdout 連結、ollama の本文読み出し）でも同じ上限で受信を止め、超過は provider エラーにする。加えて `extractJson` の候補走査に仕事量の上限を掛ける。閉じない括弧が並ぶ応答は候補ごとに末尾まで再走査するため、長さの上限だけでは二次が消えない（実測: 50 万文字で 25,629ms、`withRetry` の 4 試行で 4 倍。`timeoutMs` は同期処理に割り込めない）。
- **取り込み上限の注入**: `TranslateDeps.limits?: IngestLimits` を `ingest`（アーカイブ展開）と `fetchArxivSource` の両方へ通す。**素の `.tex` とディレクトリ入力にも掛ける**（web で最も普通の入力形態がアップロード済みファイルのパスであり、そこが無検査だとプラン別に締めても素通りする。実測: 40MB の `.tex` で RSS 456MB、拒否前に 42MB の checkpoint 書き込み）。判定は**checkpoint を書く前**に置く（拒否した入力にディスクを使わない）。**`\input` 展開は第 2 の増幅段**なので、展開器自身に予算（累積バイト・展開回数・**解決の試行回数**（後の 2 つは `maxExpansions`＝既定 5000 を共用する別カウンタ）・深さ 32 段）を持たせ、超えた瞬間に `too-large` を投げる。解決の試行を数えないと、不在先への `\input` を並べるだけの入力（展開回数もバイト数も増えない）が素通りする（実測: 3.8MB の羅列が 1,096ms 同期でブロックし、47 バイトを返して成功していた）。`stack.includes` は直接の循環しか止めず、各ファイルが次を 2 回読むダイヤモンド型は指数的に膨らむ（実測: 508 バイトの入力が同期処理でイベントループを 205 秒占有し、`timeoutMs` も中断も一切効かなかった）。LaTeX 本文には図（バイナリ）と別枠の `maxLatexBytes`（既定 8MB）を持たせる。図と同じ上限で見ていたため、40MB の `.tex` が既定で通り 415MB の RSS を使っていた。main.tex 検出は各 `.tex` の**先頭 256KB だけ**を 1 回読み、件数も `maxEntries` で抑える（本文から参照されないファイルは `maxTotalBytes` に数えられないので、全文を読むと上限が効かない）。読んだ前文は**保持しない**（件数ぶんため込むと上限件数で約 2.5GB になり、実測 1,200 件・256MB ヒープで OOM 死した）。**図の解決も増幅段**なので、basename 索引を 1 回だけ作り（参照ごとにツリーを再走査すると O(参照数 × ファイル数)。実測: 100KB の入力で 3 秒、タイマー発火 0）、参照件数自体も `maxFigureRefs`（既定 5000。数えるのはユニークな `(bases, ref)` 組で、同じ参照の羅列は 1 件に畳む）で抑える（索引化しても 1 参照あたり `existsSync` が拡張子ぶん走るため、上限いっぱいの入力が 6.4 秒残る）。`\graphicspath` は重複を落として実在ディレクトリだけに絞り、件数を 64 で抑え、図の解決で叩く `existsSync` の総回数にも上限（20 万回）を掛ける（**`\graphicspath` の宣言ごとの実在確認も同じ予算に計上する**。ディレクトリ数を 64 で抑えても、宣言そのものは `maxLatexBytes` まで並べられる。実測: 8MiB の入力で `existsSync` 92 万回・1,081ms）。参照件数だけでは 1 参照あたりのコストが bases に比例して伸びる（実測: 4,000 dirs × 1,000 refs の 39KiB 入力で 36,769ms、タイマー発火 0）。**memo キーは base 列を世代番号で代表する**（参照ごとに `bases` を直列化すると、`\graphicspath` 1 本あたりの文字列長に上限が無いぶん二次になる。`"./"` の繰り返しは既存ディレクトリへ解決するので実在確認を通り、文字列としては相異なるので重複排除も効かない。実測 8MiB で 94,071ms）。**「回数の上限」を入れても「1 回あたりのコスト」に上限が無ければ意味が無い**、が反復して現れる教訓。既定は `DEFAULT_LIMITS`。web ではプラン別に締められる。
- **中断（`AbortSignal`）**: `TranslateOptions.signal` を受け、LLM 呼び出し・全文組版・arXiv 取得へ伝播する。中断は `kind="canceled"`（期限超過だけ `kind="timeout"`）/ **終了コード 6** で返し、リトライ対象にしない（`isTransient` は false）。単一終了コード決定規則では `6` を最優先にする（中断された run の中で起きた他の失敗より、中断された事実のほうが呼び出し側に必要）。伝播は境界 1 箇所（`withSignal` による `LlmClient` のラッパ）で行い、エージェントの関数シグネチャは増やさない。組版は中断時にプロセスグループごと `SIGKILL`（タイムアウトと同じ扱い）。実装の正本は `src/runtime/cancellation.ts`。
- **arXiv 取得の待ち行列の上限**: 3 秒間隔（本節「arXiv ID 取得」）は予約方式で直列化するため、同時要求が増えるほど後発の待ち時間が線形に伸びる。予約時点で待ち時間が `maxQueueWaitMs`（既定 30 秒）を超えるなら**待たずに `kind="busy"` で失敗**させ、自分のぶんで待ち行列をさらに伸ばさない。待機中に中断・失敗したら**予約を巻き戻す**（返さないと、接続してすぐ切るだけで＝fetch を 1 度も起こさずに待ち行列を伸ばし、他の全リクエストを拒否させられる）。
- **run 全体の期限（`TranslateOptions.timeoutMs`）と枠の解放**: 期限は run 層で 1 度だけ用意し、呼び出し側の `signal` と OR で合流させる（web ハンドラごとに `setTimeout` を書かせない）。超過は中断と同じ exit 6 で返るが、`kind` は `timeout` に分ける（web が 504 と 499 を出し分けられるように）。**期限の印は内部タイマーだけが付ける**（呼び出し側が渡す `reason` は信用しない。信用すると、client 由来の値で切断が期限超過に化ける）。**不正な `timeoutMs`（`NaN`・`Infinity`・0 以下・文字列）は黙って「期限なし」にせず `input` で拒否する**（無期限に化けた run が枠を握ると他テナントを止める）。`2^31-1` を超える値はクランプする（`setTimeout` が 1ms に丸め、指定した瞬間に abort されるため）。あわせて、**中断されたら下位の呼び出しが決着しなくても中断ラッパから抜ける**。注入クライアントは任意の実装であり、契約は `signal` の尊重を強制できない。await し続けると同時実行ゲートの枠が返らず、実測で `active=1 / waiting=1` のまま恒久的に 1 枠失われた（リクエストを重ねれば全テナントが停止する）。漏れた呼び出し自体は止められないので、**枠だけ返し、遅れて来る rejection は握り潰す**。abort listener は決着時に必ず外す。実装の正本は `src/runtime/cancellation.ts`。
- **1 run の仕事量の上限（`TranslateDeps.work?: Partial<WorkLimits>`）**: `IngestLimits` はバイト数とエントリ数しか見ないため、**サイズ上限を全て満たしたまま呼び出し回数だけが爆発する入力**（節を大量に含む小さな `.tex`）を止められない。実測で 49KiB の入力から 1601 回の呼び出しが出た。`maxSegments`（既定 150）はセグメント化直後に判定し、節ループを 1 本も回さずに `too-large` で落とす（超過が確定した入力に課金しない）。`maxLlmCalls`（既定 600）は run 内の全 LLM 呼び出しをラッパで数え、超過分は下位クライアントへ届けない。**リトライ・再訳・評価も 1 回として数える**（課金されるのは試行回数）。既定値は実論文（arXiv 2203.06060、本文 109KiB＝35 セグメント / 96 呼び出し）の 4 倍前後に置く。同時実行ゲート（前項）は同時数を抑えるだけで総量を抑えないため、両方要る。**設定値は個別に検査し、不正値で黙って緩めない**: 明示的な `undefined`・`NaN`・`Infinity`・0 以下・数値以外は既定へ戻し、過大な値は上限の上限（`WORK_LIMIT_CAPS`）で切る（spread マージだと `work: { maxSegments: plan.maxSegments }` の 1 行で上限が丸ごと消え、実測で 801 回の呼び出しが素通りした）。実装の正本は `src/runtime/work-budget.ts`。
- **checkpoint の無効化キーは入力の内容を代表しなければならない**: `ingest` の `invalidation` を `(path, mtimeMs, size)` にしていた頃は、同一パス・同一サイズ・秒単位で同じ mtime の別論文が同じ入力とみなされ、**論文 B を投げた利用者に論文 A の訳文が exit 0 で返った**（LLM 呼び出し 0 回・`paperId` もファイル名 stem 由来なので `.paper-id` の印も発動しない）。`tar -x` / `cp -p` / `rsync -t` / `docker cp` は mtime を復元するので、アップロードを固定パスへ展開する web パイプラインではこれが常態になる。署名（HMAC）の破綻ではなく**署名対象が内容を代表していない**設計の穴なので、`inputSignature` は内容の sha256 を使う（ディレクトリ入力は相対パスと内容の畳み込み）。走査は上限（512MB・10,000 エントリ）で抑え、超える入力は取り込み側が `too-large` で落とすため部分ハッシュのままでよい。**`arxiv` 分岐は ID のみのハッシュなので、版を省いた ID（`2203.06060`）で論文が改訂されると旧 checkpoint を再利用する**（既知の残存リスク）。
- **`.run` の保持ポリシー**: checkpoint のファイル名は `<stepId>.<無効化ハッシュ>.json` なので、論文を直して再投入するたびに旧世代が残る（実測: 8 世代で 228KB→1208KB と線形に増加）。**新しい世代を書いたら同じ step の旧世代を削除する**。GC は最善努力で、失敗しても run は続行する（増えるだけ）。セグメント数が減った再投入では使われなくなった `seg-*` が残りうるが、`maxSegments` で件数は有界。`llm-trace.jsonl` は 1 ファイル 5MB で 1 世代だけ退避する（合計は `2×maxBytes + 1 行`で有界。ローテ直後の 1 行は無条件に書く）。**上限が効くのは既定シンクだけで、`TranslateDeps.trace` を注入した場合の保持は呼び出し側の責務**。判定は**実ファイルのサイズ**で行う（シンクごとのカウンタだと、同じファイルへ複数のシンクを向けた瞬間に上限が壊れる）。集計ツールは退避ファイル（`.1`）も読む。checkpoint だけ GC しても、トレースが増え続ければ `.run` は線形に増える。旧世代を消す以上、**入力を A→B→A と往復させると A は再計算＝再課金になる**（世代を残さないこととのトレードオフ）。`.run` 全体の寿命（run 完了後にいつ消すか）は呼び出し側の責務。 加えて、run が正常に完了した時点で**今回使わなかった stepId の checkpoint を消す**。旧世代 GC は同じ stepId しか見ないため、節が減る再実行では孤児が残り続ける（実測: 8 節→1 節に縮小しても 10 ファイル 4.2MB のまま、うち 7 件が前回の訳文）。paperId が衝突すると、これがそのまま別論文の内容の残留経路になる。
- **観測（トレース・進捗・呼び出し回数）**: web はテナント別の資格情報のためにクライアントを必ず注入するので、プロバイダ生成側にだけトレースを配線すると**課金の記録が構造的に消える**。`translatePaper` は注入クライアントにも `withTrace` を掛ける（usage/コストは注入側の内部にしか無いので、run 層が残すのは回数・latency・呼び出し文脈）。宛先は `TranslateDeps.trace` で差し替えられる（既定は `<outDir>/.run/llm-trace.jsonl`）。`RunSummary.llmCalls` に実際に発行した回数を載せる（**失敗した run でも返す**＝どこまで課金相当の仕事をしたか）。**通知チャネル（`onError` / `onProgress`）の例外は run を壊さない**。web の SSE 切断などで投げても結果を変えず、外へも出さない（§8 の「例外は投げず戻り値で表現」）。`onError` も `outwardMessage` を通す。進捗は `TranslateDeps.onProgress`（`ingest`/`context`/`translate`/`typeset` と `done/total`）で通知する。
- **入口の検証**: `translatePaper` は `JpaperInput` / `provider` / `concurrency` / `outDir` を入口で検証し、不正なら `kind="input"` の `Result` を返す。**生の例外を web ハンドラへ漏らさない**（`{ kind: "path", path: undefined }` で `TypeError` が漏れていた）。未知の provider を既定へフォールバックさせない（`"openai"` が claude 扱いで通り、コンテキスト窓だけ Ollama のものになっていた）。
- **失敗の構造化（`Result.error`）**: `Result` に `error?: { kind, code, message, detail? }` を持たせる。`status="failed"` のとき必ず入る。`kind` は `input`（入力が不正）/ `conflict`（出力先が使用中＝run lock）/ `too-large`（サイズ・件数の上限超過）/ `busy`（一時的な過負荷。後で再試行できる＝arXiv の待ち行列超過など）/ `upstream`（外部サービス側の障害＝arXiv 到達不能・リトライ枯渇）/ `provider`（LLM プロバイダ利用不能。**注入クライアントが投げた例外もここに写す**＝テナントの 401 が 500 にならないように）/ `formal`（形式検査不通過）/ `quality`（品質未達）/ `typeset`（全文組版失敗）/ `canceled`（呼び出し側の中断＝切断）/ `timeout`（run 全体の期限超過。web が 504 と 499 を出し分けられるように分ける）/ `infra`（実行環境の障害＝権限・容量・パス衝突。コードのバグと区別してアラートするため）/ `internal`（想定外）。`code` は §6 の終了コードで、`kind` はそれを細分する軸（`code=2` が `input`/`conflict`/`too-large`/`busy`/`upstream`/`provider` に分かれる）。`detail` には `internal` のスタックのほか、`upstream`・`infra`・`JpaperError` の伏せる前の原文も入る。**`detail` はサーバ側のログ用であり、web の応答へ載せてはならない**。LLM 応答がリトライ後も zod を通らない場合は `internal` ではなく `provider` に分類する（生の zod エラーを応答へ出さないため、メッセージは 200 文字で切る）。web ハンドラは `kind` から応答を出し分ける（例: `input`→400 / `conflict`→409 / `too-large`→413 / `busy`→429 / `formal`・`quality`・`typeset`→422 / `canceled`→499 / `timeout`→504 / `upstream`・`provider`→502 / `infra`・`internal`→500）。**`message` は外向きに出してよいが、`detail` はサーバ側ログ専用**（スタックと生の errno・絶対パスを含む）。`message` は制御文字を落とし 500 文字で切る（論文由来の文字列・外部プロセスの出力が端末や HTTP 応答へ流れるため。ただし論文由来の語句そのものは残りうるので、web 側の escape は必須）。`infra` の `message` には errno の種別だけを載せ、パスは載せない。**外向き `message` は経路によらず 1 つの出口（`outwardMessage`）を通す**: 制御文字（C0/C1 に加えて双方向制御・行区切り・ゼロ幅）を落とし、ホストの絶対パスを `<path>` に伏せ、500 文字で切る。伏せた原文はサーバ側ログ用に `detail` へ移す。組版失敗の `message` は latexmk ログの切り出し＝**論文が内容を操作できる**ため、同じ出口を通し、ログ由来の断片は個別にも長さを切る。環境由来の errno（`ENOENT`/`EEXIST`/`EBUSY` を含む）は `infra`、ネットワーク errno（`ECONNREFUSED` 等）は `upstream` に分類し、`internal` は本当にコードのバグだけにする。**ただしアーカイブ展開時の書き出しだけは先に `input` へ寄せる**: エントリ名そのものが不正で書けない場合（`EISDIR`/`EEXIST`/`ENOTDIR`/`ENAMETOOLONG`。`.` エントリや `a` と `a/b` の衝突）は入力起因なので、errno の一般分類（`infra`＝exit 1）へ落ちる前に `kind="input"` の `JpaperError` に変換する。素通しすると、論文側の細工でサーバ障害のアラートと自動リトライを誘発できる。権限・容量（`EACCES`/`ENOSPC` 等）はこの例外に含めず `infra` のままにする。errno は `cause` を 3 段まで辿る（ライブラリが包むため）。`onError` は表示用の副作用として残るが、判定材料は戻り値から取れる。`RunSummary`（stdout 契約）は変更しない。
- **出力先の排他（run lock）**: checkpoint は `<outDir>/.run` 単位で共有されるため、同一 `outDir` の並行実行は互いの訳文・用語文脈を混ぜたまま**両方が成功を返す**。`translatePaper` は開始時に `<outDir>/.run/run.lock` を原子的に取得し（方法は後述の「一時ファイルへ書き切ってから `link`」）、取得できなければ**終了コード 2**（入力エラー）で明示的に失敗する。ロックは `pid` / `startedAt` / `beatAt` を持ち、**保持者が生きている間 `beatAt` を更新し続ける**（`HEARTBEAT_MS` 30 秒）。更新が `LOCK_STALE_MS`（120 秒）途切れ、かつ保持プロセスが存在しないときだけ失効として奪う。pid の生存判定は `ESRCH` のときだけ「死亡」とする（`EPERM` は「存在するが権限が無い」＝生存の証拠。コンテナの pid 1 や別ユーザ実行で生きたロックを奪わないため）。ロックの作成は「一時ファイルへ書き切ってから `link`」で行う（原子的な排他と、常に完全な内容が読めることを同時に満たす。`open("wx")` は作成と書き込みの間に空ファイルを読まれ失効と誤判定される）。失効ロックの削除は補助ロック `run.lock.steal` で直列化する（直列化しないと複数プロセスが互いの新しいロックを消し合い、全員が保持者を自認する）。取得に失敗した側は必ず `kind="conflict"` で返し、生の fs エラーを外へ出さない。実装の正本は `src/durable/run-lock.ts`。web ハンドラから呼ぶ場合、同時リクエストは outDir を分けるか、この失敗を 409 相当として扱う。
- **単一終了コード決定規則**（1 run で複数原因が混在時）: `6`（中断・期限超過）> `2`（入力/プロバイダ）> `3`（形式失敗）> `4`（品質失敗）> `5`（全文ゲート=(B)）> `1`（想定外）の優先順位で 1 つに決める。`6` を先頭に置くのは、中断された run の部分的な失敗を「翻訳の失敗」として報告しないため。`1` を最後尾に置くのは、内部バグを組版失敗の陰に隠さないため。実装の正本は `resolveExitCode`（`src/types/errors.ts`）。
- **大セグメント再分割後の扱い**: 再分割した各断片で `MAX_REVISIONS` 区分（小/中/大＝絶対トークン閾値）を**断片ごとに再判定**。`firstOccurrence` は断片をまたいでも**文書全体で1回**（決定的インデクサが全文基準で付与、分割の影響を受けない）。
- **収集[決定的] の v1 最小仕様（(A) 固定スコープ・工数を pin）**: 定義パターンは**固定セット**に限定する — (1) `\newcommand`、(2) `we (call|define|term|denote) X` / `we refer to ... as X`、(3) `X (is|are) defined as`、(4) `\emph{}`/`\textit{}`/`\textbf{}` の初出、(5) 大文字始まりの複合固有名。加えて DB `src` への**最長一致**。**網羅性は求めない**（取りこぼしは全文を読む glossary-builder が補う）。パターン拡充・ネット検索連携は roadmap（本付録 §7 の (B)/Phase2 外の enhancement）。
