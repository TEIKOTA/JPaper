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
- **機械出力の md は run が最後まで到達したときだけ outDir へ確定する**（`glossary.md` / `brief.md` / `style.md`）。中断・例外で抜けた run の中間物を残すと、人間が一度も見ていない機械出力が次の run の正本になり、入力を直しても差し替わらなくなる。確定時に `<outDir>/.paper-id` へ論文 ID を記録し、**別の論文が同じ outDir を使うときは既存 md を採用しない**（警告を出して作り直す）。採用しないと、論文 A の brief が論文 B の全 translator プロンプトへ注入される。印が無い出力先（旧版が作ったもの）はこれまでどおり採用する。
- 初期シード: **v1 は空で開始**し、翻訳のたびに `proposed` を蓄積して育てる（同梱シードなし）。`input/` は空のまま（`.gitkeep` のみ）。人間が `proposed`→`confirmed` に昇格。

## 3. 品質ループ（値の正本）

- 単位: セグメント（節）。2層＝[節ループ軽検査＋evaluator] と [全文組版ゲート]（[2層化 ADR](../adr/20260709-quality-gate-two-layer-and-build-error-triage.md)）。
- `MAX_REVISIONS`: セグメントサイズ連動 **小=3 / 中=4 / 大=5**（下限3・上限5）。区分は**絶対トークン閾値**（プロバイダ非依存＝決定的テストのゴールデン値が揺れない）: 小 `<1500` / 中 `<3500` / 大 `>=3500`（§4 の自前推定器で計測）。超過→failed。形式検査の差し戻しもカウント。
- evaluator の合否は**不変条件**で決める（`verdict` 単独では決めない）: **出版可能＝`verdict≠fail` かつ `error` 級 `issue` が無い**。この時のみ pass（`warn` は非ブロッキングで訳注へ流す）。それ以外は `issues` を translator の再訳入力へ回し、`verdict=fail` は即 failed（再訳しない）・`MAX_REVISIONS` 超過も failed。`error` 級 issue があれば `pass` verdict でも通さない（重大問題の素通しを防ぐ）。**severity の正しい割当は evaluator の責務**（下の rubric で規定）で、意味反転など地の文の意味的欠陥に対する決定的検出器は存在しないため、決定的ハードゲートは §7 の形式検査（数式・引用・keep-original 等）が担う。
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
| 1 | 想定外エラー |
| 2 | 入力形態の判定不能 / `--provider` 未指定 |
| 3 | 節ループの形式検査が MAX_REVISIONS 内に通らず failed |
| 4 | 品質未達（evaluator が pass に至らず MAX_REVISIONS 超過 or `fail`） |
| 5 | 全文組版ゲート失敗（構造・テンプレ起因のビルド/欠図/未解決参照） |
| 6 | 呼び出し側の中断（`AbortSignal`。web でクライアントが切断した等） |

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

- **core API**: `translatePaper(input: JpaperInput, opts: { provider: "ollama"|"claude"; outDir?: string }): Promise<Result>`。`Result = { status: "ok"|"failed"; pdfPath?: string; exitCode: number; summary: RunSummary }`。CLI・GUI はこの1関数を呼ぶ薄い皮（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) 決定4）。例外は投げず `status/exitCode` で表現（§6 と対応）。
- **stdout サマリ JSON**: `RunSummary = { paperId, outDir, segments: {total, passed, failed}, revisions: {max, used}, glossary: {proposedAdded}, notes: {total, byTrigger}, layout: "original"|"template"|null, buildOk: boolean, sharedDefaults: ("db"|"cacheKey"|"outDir")[], exitCode }`（zod 定義を実装時に写経）。`layout` は採用した組版モード（[組版レイアウト ADR](../adr/20260710-typesetting-layout-original-first-hybrid.md)。`original`=原プリアンブル温存／`template`=共通テンプレへフォールバック）。組版は (B) のため **(A) 単体では `layout=null`**（`buildOk=null` と同様）。`notes` は §1 `TranslatorNote` の件数集計（本体は `notes.json`）。`byTrigger` は `paper-defined-preserve|low-confidence|evaluator-warn|heading-untranslated` 別の件数。
- **訳注の生成契約（[翻訳一貫性 ADR](../adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定3・採否=決定的 / 文面=LLM）**: trigger を次の決定的規則で採る。①`paper-defined` で `rendering∈{keep-original,bilingual}` に確定した語 ②**低確信=`class="established"` かつ global DB に `status="confirmed"` の一致が無く `proposed` のみ or 未ヒットで preserve に倒した語**（DB 状態から決定的に判定）③evaluator の `warn` issue ④**heading-untranslated=見出し（`\section` 等）の可視テキストが未訳の可能性（`untranslatedHeadings` の決定的検査。非ブロッキングで再訳ゲートには載せない）**。文面 `text` は term 系＝`ResolvedTerm.note`、warn 系＝`EvalIssue.message`、heading 系＝決定的テンプレ（LLM 非依存）。`firstOccurrence`（文書全体基準）で本文脚注は初出1回のみ、巻末一覧は語ごと1エントリ。④の決定は [見出し未訳検査 ADR](../adr/20260721-heading-untranslated-nonblocking-note.md)。
- **run-context 注入（brief/style）**: system prompt の run-context（設計メモ §13A）に **`DocumentBrief`＋`StyleContract` を全 translator へ注入**する（per-paper で run 内不変＝キャッシュ prefix を安定化）。**per-segment の確定用語ブロック（rendering 指示）は system ではなく user メッセージへ載せる**（毎セグメント変わり system の cache prefix を壊すため。[プロンプトキャッシュ再利用 ADR](../adr/20260722-prompt-cache-reuse-stable-system-prompt.md)）。トークン予算は §4 の 30% 圏内で管理（超過時はブリーフを要約して圧縮）。
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
- **組版へ渡す LaTeX の安全検査**: 論文プリアンブルは翻訳されず verbatim に持ち越されるため、節ループの品質ゲートでは一切検査されない。取り込み直後に**原文全体**（プリアンブル含む）を走査し、読み出し・Lua 実行・書き込みプリミティブ（`\openin` / `\read` / `\directlua` / `\openout` / `\write` 等。正本は `src/tools/tex-safety.ts`）を含むなら `kind="input"` で拒否する。LLM を呼ぶ前に弾く。組立後の main.tex も latexmk へ渡す前に再検査する（多層防御）。`^^` 記法と `\csname` による綴りの組み立ては展開してから照合する。`\usepackage` は正規の用途があるため対象外。**読み込みコマンド（`\input` / `\include` / `\InputIfFileExists` / `\import` 等）は名前では落とせないので、引数の形で判定する**: 引数が絶対パス・`~`・`..` を含むもの、および `\csname` で綴りを組み立てたものを拒否する（`\csname input\endcsname{/abs}` は `expandInputs` の正規表現に一致せずプリアンブルに残り、latexmk が実際に読んで PDF へ出す＝実測で流出を確認した経路）。素の `\input{/abs}` は `expandInputs` が build ツリー外として除去するため cleanLatex に残らないが、多層防御として検査面にも残す。`\csname` は**本体全体**で照合する（トークン分割で照合すると `\csname my-input\endcsname` のような配布 `.sty` を落とす）。**論文が同梱する `.sty` / `.cls` / `.bst` / `.bib` / `.bbl` も検査面に含める**が、対象は**配布版に shadow されないもの**（＝実際に読み込まれるもの）に限り、denylist は任意読み出しと Lua 実行のみ（`\directlua` 系 / `\openin` / `\read` / `\readline`）に絞る。`\write` / `\openout` を支援ファイルで禁じると、`elsarticle.cls` などを同梱した正規の論文が落ちる（実測 12 件中 8 件）。`\csname` の本文は大小文字を畳んで照合する（制御綴りそのものは TeX の意味論どおり区別する）。決定と残存リスクは [プリアンブル ADR](../adr/20260811-preamble-is-untrusted-code-not-just-layout.md) と [支援ファイル ADR](../adr/20260811-support-files-are-part-of-the-inspection-surface.md)。
- **本番運用の前提（組版の隔離）**: 上の denylist は既知の綴りしか止められない。本番では組版を**書き込み可能な作業ディレクトリ以外へアクセスできない環境**（コンテナ／別ユーザ／読み取り専用マウント）で実行すること。kpathsea の `openin_any` では代替できない（`r` は絶対パスを制限せず、`p` は luaotfload ごと壊す。`\directlua` は kpathsea を経由しない）。
- **マルチテナントで呼ぶ場合の必須注入（1 箇所にまとめる）**: 既定値は**単一ユーザ向け**であり、web で複数テナントを捌く場合はそのままでは分離できない。テナントごとに必ず渡す: ①`TranslateDeps.dbPath`（既定 `~/.jpaper/glossary.db`。`term` テーブルにテナント列は無く、`status="confirmed"` の語は DB を共有する全員に効く）②`TranslateDeps.cacheKey`（既定 `~/.jpaper` 配下の共有鍵。checkpoint 署名鍵）③`TranslateOptions.outDir`（既定は cwd 直下の `<paperId>-ja`。同じ出力先は run lock で排他されるので、テナントを分けないと互いに 409 で弾き合う）。既定へフォールバックした資源は `RunSummary.sharedDefaults`（`"db" | "cacheKey" | "outDir"` の配列）に出し、`onError` にも警告を出す。**空でなければ分離できていない**という判定に使える。
- **パスの扱い**: `RunSummary.outDir` と `Result.pdfPath` はホストの**絶対パス**を返す。core は自分の外の URL 空間を知らないため写像しない。web 層が自前の識別子・署名付き URL へ写す責務を負い、そのまま応答へ透過してはならない。
- **LLM 同時実行の上限（プロセス全体）**: `TranslateOptions.concurrency`（既定 4）は run 内の上限でしかなく、1 プロセスで複数リクエストを捌く web ハンドラでは「リクエスト数 × セグメント並列」だけ呼び出しが同時に飛ぶ（claude プロバイダは 1 呼び出し = 1 子プロセス）。`translatePaper` は**注入クライアントを含む全ての LLM 呼び出し**を、プロセス全体で共有するゲートに通す（`TranslateDeps.gate` で差し替え可能）。プロバイダ生成側で掛けると、web が自前クライアント（テナント別資格情報・トレース）を注入した瞬間に上限が消えるため、run 層で一律に掛ける。上限は `JPAPER_MAX_LLM_CONCURRENCY`（既定 8・上限 64）で、**10 進整数のみ**受け付ける（`"1e9"` や `"0x10"` で無効化させない）。範囲外は既定へ戻さず端へ丸める（設定ミスが緩める方向に倒れないため）。ゲートは待機解除後に空きを再検査する（再検査しないと、`release` と待機者の再開の間に割り込んだ新規呼び出しのぶん上限を超える）。ゲートは中断ラッパの**外側**に置き、枠を取ってから中断を見る（待ち行列に中断済みが居座らない）。**待機中も中断が効く**（`Gate.run(fn, signal?)`）。効かないと、期限を持たない run が枠を握った時に、`timeoutMs` を正しく設定した他テナントの run まで返らない（実測で 100ms 指定の run が 1202ms 拘束された）。中断済みの待機者は起こしても枠を使わないので、生きている先頭が出るまで捨てる。**待ち行列にも上限を掛ける**（`JPAPER_MAX_LLM_QUEUE`、既定 256・上限 4096）。無制限だと過負荷を `busy`（429）へ変換できず、返らないリクエストだけが積み上がる（実測: `makeGate(1)` に 10 万件積めた）。**`TranslateDeps.gate` はプロセス上限を置き換えず、内側の第 2 段として重ねる**（置き換えにすると、web がリクエスト単位でゲートを作った瞬間にプロセス上限が消える）。実装の正本は `src/runtime/concurrency.ts`。
- **取り込み上限の注入**: `TranslateDeps.limits?: IngestLimits` を `ingest`（アーカイブ展開）と `fetchArxivSource` の両方へ通す。既定は `DEFAULT_LIMITS`。web ではプラン別に締められる。
- **中断（`AbortSignal`）**: `TranslateOptions.signal` を受け、LLM 呼び出し・全文組版・arXiv 取得へ伝播する。中断は `kind="canceled"` / **終了コード 6** で返し、リトライ対象にしない（`isTransient` は false）。単一終了コード決定規則では `6` を最優先にする（中断された run の中で起きた他の失敗より、中断された事実のほうが呼び出し側に必要）。伝播は境界 1 箇所（`withSignal` による `LlmClient` のラッパ）で行い、エージェントの関数シグネチャは増やさない。組版は中断時にプロセスグループごと `SIGKILL`（タイムアウトと同じ扱い）。実装の正本は `src/runtime/cancellation.ts`。
- **arXiv 取得の待ち行列の上限**: 3 秒間隔（本節「arXiv ID 取得」）は予約方式で直列化するため、同時要求が増えるほど後発の待ち時間が線形に伸びる。予約時点で待ち時間が `maxQueueWaitMs`（既定 30 秒）を超えるなら**待たずに `kind="busy"` で失敗**させ、自分のぶんで待ち行列をさらに伸ばさない。待機中に中断・失敗したら**予約を巻き戻す**（返さないと、接続してすぐ切るだけで＝fetch を 1 度も起こさずに待ち行列を伸ばし、他の全リクエストを拒否させられる）。
- **run 全体の期限（`TranslateOptions.timeoutMs`）と枠の解放**: 期限は run 層で 1 度だけ用意し、呼び出し側の `signal` と OR で合流させる（web ハンドラごとに `setTimeout` を書かせない）。超過は中断と同じ経路＝`canceled`/exit 6 で返る。**不正な `timeoutMs`（`NaN`・`Infinity`・0 以下・文字列）は黙って「期限なし」にせず `input` で拒否する**（無期限に化けた run が枠を握ると他テナントを止める）。`2^31-1` を超える値はクランプする（`setTimeout` が 1ms に丸め、指定した瞬間に abort されるため）。あわせて、**中断されたら下位の呼び出しが決着しなくても中断ラッパから抜ける**。注入クライアントは任意の実装であり、契約は `signal` の尊重を強制できない。await し続けると同時実行ゲートの枠が返らず、実測で `active=1 / waiting=1` のまま恒久的に 1 枠失われた（リクエストを重ねれば全テナントが停止する）。漏れた呼び出し自体は止められないので、**枠だけ返し、遅れて来る rejection は握り潰す**。abort listener は決着時に必ず外す。実装の正本は `src/runtime/cancellation.ts`。
- **1 run の仕事量の上限（`TranslateDeps.work?: Partial<WorkLimits>`）**: `IngestLimits` はバイト数とエントリ数しか見ないため、**サイズ上限を全て満たしたまま呼び出し回数だけが爆発する入力**（節を大量に含む小さな `.tex`）を止められない。実測で 49KiB の入力から 1601 回の呼び出しが出た。`maxSegments`（既定 150）はセグメント化直後に判定し、節ループを 1 本も回さずに `too-large` で落とす（超過が確定した入力に課金しない）。`maxLlmCalls`（既定 600）は run 内の全 LLM 呼び出しをラッパで数え、超過分は下位クライアントへ届けない。**リトライ・再訳・評価も 1 回として数える**（課金されるのは試行回数）。既定値は実論文（arXiv 2203.06060、本文 109KiB＝35 セグメント / 96 呼び出し）の 4 倍前後に置く。同時実行ゲート（前項）は同時数を抑えるだけで総量を抑えないため、両方要る。**設定値は個別に検査し、不正値で黙って緩めない**: 明示的な `undefined`・`NaN`・`Infinity`・0 以下・数値以外は既定へ戻し、過大な値は上限の上限（`WORK_LIMIT_CAPS`）で切る（spread マージだと `work: { maxSegments: plan.maxSegments }` の 1 行で上限が丸ごと消え、実測で 801 回の呼び出しが素通りした）。実装の正本は `src/runtime/work-budget.ts`。
- **`.run` の保持ポリシー**: checkpoint のファイル名は `<stepId>.<無効化ハッシュ>.json` なので、論文を直して再投入するたびに旧世代が残る（実測: 8 世代で 228KB→1208KB と線形に増加）。**新しい世代を書いたら同じ step の旧世代を削除する**。GC は最善努力で、失敗しても run は続行する（増えるだけ）。セグメント数が減った再投入では使われなくなった `seg-*` が残りうるが、`maxSegments` で件数は有界。`.run` 全体の寿命（run 完了後にいつ消すか）は呼び出し側の責務。
- **観測（トレース・進捗・呼び出し回数）**: web はテナント別の資格情報のためにクライアントを必ず注入するので、プロバイダ生成側にだけトレースを配線すると**課金の記録が構造的に消える**。`translatePaper` は注入クライアントにも `withTrace` を掛ける（usage/コストは注入側の内部にしか無いので、run 層が残すのは回数・latency・呼び出し文脈）。宛先は `TranslateDeps.trace` で差し替えられる（既定は `<outDir>/.run/llm-trace.jsonl`）。`RunSummary.llmCalls` に実際に発行した回数を載せる（**失敗した run でも返す**＝どこまで課金相当の仕事をしたか）。進捗は `TranslateDeps.onProgress`（`ingest`/`context`/`translate`/`typeset` と `done/total`）で通知する。
- **入口の検証**: `translatePaper` は `JpaperInput` と `provider` を zod で検証し、不正なら `kind="input"` の `Result` を返す。**生の例外を web ハンドラへ漏らさない**（`{ kind: "path", path: undefined }` で `TypeError` が漏れていた）。未知の provider を既定へフォールバックさせない（`"openai"` が claude 扱いで通り、コンテキスト窓だけ Ollama のものになっていた）。
- **失敗の構造化（`Result.error`）**: `Result` に `error?: { kind, code, message, detail? }` を持たせる。`status="failed"` のとき必ず入る。`kind` は `input`（入力が不正）/ `conflict`（出力先が使用中＝run lock）/ `too-large`（サイズ・件数の上限超過）/ `busy`（一時的な過負荷。後で再試行できる＝arXiv の待ち行列超過など）/ `upstream`（外部サービス側の障害＝arXiv 到達不能・リトライ枯渇）/ `provider`（LLM プロバイダ利用不能。**注入クライアントが投げた例外もここに写す**＝テナントの 401 が 500 にならないように）/ `formal`（形式検査不通過）/ `quality`（品質未達）/ `typeset`（全文組版失敗）/ `canceled`（中断）/ `infra`（実行環境の障害＝権限・容量・パス衝突。コードのバグと区別してアラートするため）/ `internal`（想定外）。`code` は §6 の終了コードで、`kind` はそれを細分する軸（`code=2` が `input`/`conflict`/`too-large`/`provider` に分かれる）。`internal` のときだけ `detail` にスタックを入れる。**`detail` はサーバ側のログ用であり、web の応答へ載せてはならない**。LLM 応答がリトライ後も zod を通らない場合は `internal` ではなく `provider` に分類する（生の zod エラーを応答へ出さないため、メッセージは 200 文字で切る）。web ハンドラは `kind` から応答を出し分ける（例: `input`→400 / `conflict`→409 / `too-large`→413 / `busy`→429 / `formal`・`quality`・`typeset`→422 / `canceled`→499 / `upstream`・`provider`→502 / `infra`・`internal`→500）。**`message` は外向きに出してよいが、`detail` はサーバ側ログ専用**（スタックと生の errno・絶対パスを含む）。`message` は制御文字を落とし 500 文字で切る（論文由来の文字列・外部プロセスの出力が端末や HTTP 応答へ流れるため。ただし論文由来の語句そのものは残りうるので、web 側の escape は必須）。`infra` の `message` には errno の種別だけを載せ、パスは載せない。**外向き `message` は経路によらず 1 つの出口（`outwardMessage`）を通す**: 制御文字（C0/C1 に加えて双方向制御・行区切り・ゼロ幅）を落とし、ホストの絶対パスを `<path>` に伏せ、500 文字で切る。伏せた原文はサーバ側ログ用に `detail` へ移す。組版失敗の `message` は latexmk ログの切り出し＝**論文が内容を操作できる**ため、同じ出口を通し、ログ由来の断片は個別にも長さを切る。環境由来の errno（`ENOENT`/`EEXIST`/`EBUSY` を含む）は `infra`、ネットワーク errno（`ECONNREFUSED` 等）は `upstream` に分類し、`internal` は本当にコードのバグだけにする。errno は `cause` を 3 段まで辿る（ライブラリが包むため）。`onError` は表示用の副作用として残るが、判定材料は戻り値から取れる。`RunSummary`（stdout 契約）は変更しない。
- **出力先の排他（run lock）**: checkpoint は `<outDir>/.run` 単位で共有されるため、同一 `outDir` の並行実行は互いの訳文・用語文脈を混ぜたまま**両方が成功を返す**。`translatePaper` は開始時に `<outDir>/.run/run.lock` を `O_EXCL` で取得し、取得できなければ**終了コード 2**（入力エラー）で明示的に失敗する。ロックは `pid` / `startedAt` / `beatAt` を持ち、**保持者が生きている間 `beatAt` を更新し続ける**（`HEARTBEAT_MS` 30 秒）。更新が `LOCK_STALE_MS`（120 秒）途切れ、かつ保持プロセスが存在しないときだけ失効として奪う。pid の生存判定は `ESRCH` のときだけ「死亡」とする（`EPERM` は「存在するが権限が無い」＝生存の証拠。コンテナの pid 1 や別ユーザ実行で生きたロックを奪わないため）。ロックの作成は「一時ファイルへ書き切ってから `link`」で行う（原子的な排他と、常に完全な内容が読めることを同時に満たす。`open("wx")` は作成と書き込みの間に空ファイルを読まれ失効と誤判定される）。失効ロックの削除は補助ロック `run.lock.steal` で直列化する（直列化しないと複数プロセスが互いの新しいロックを消し合い、全員が保持者を自認する）。取得に失敗した側は必ず `kind="conflict"` で返し、生の fs エラーを外へ出さない。実装の正本は `src/durable/run-lock.ts`。web ハンドラから呼ぶ場合、同時リクエストは outDir を分けるか、この失敗を 409 相当として扱う。
- **単一終了コード決定規則**（1 run で複数原因が混在時）: `2`（入力/プロバイダ）> `3`（形式失敗）> `4`（品質失敗）> `5`（全文ゲート=(B)）の優先順位で1つに決める。
- **大セグメント再分割後の扱い**: 再分割した各断片で `MAX_REVISIONS` 区分（小/中/大＝絶対トークン閾値）を**断片ごとに再判定**。`firstOccurrence` は断片をまたいでも**文書全体で1回**（決定的インデクサが全文基準で付与、分割の影響を受けない）。
- **収集[決定的] の v1 最小仕様（(A) 固定スコープ・工数を pin）**: 定義パターンは**固定セット**に限定する — (1) `\newcommand`、(2) `we (call|define|term|denote) X` / `we refer to ... as X`、(3) `X (is|are) defined as`、(4) `\emph{}`/`\textit{}`/`\textbf{}` の初出、(5) 大文字始まりの複合固有名。加えて DB `src` への**最長一致**。**網羅性は求めない**（取りこぼしは全文を読む glossary-builder が補う）。パターン拡充・ネット検索連携は roadmap（本付録 §7 の (B)/Phase2 外の enhancement）。
