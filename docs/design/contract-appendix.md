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
const GlossaryBuilderOut = z.object({ resolved: z.array(ResolvedTerm.omit({ firstOccurrence: true }) )});
// firstOccurrence は翻訳配線側の決定的インデクサが後付け（translator に判定させない）
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
- 初期シード: **v1 は空で開始**し、翻訳のたびに `proposed` を蓄積して育てる（同梱シードなし）。`input/` は空のまま（`.gitkeep` のみ）。人間が `proposed`→`confirmed` に昇格。

## 3. 品質ループ（値の正本）

- 単位: セグメント（節）。2層＝[節ループ軽検査＋evaluator] と [全文組版ゲート]（[2層化 ADR](../adr/20260709-quality-gate-two-layer-and-build-error-triage.md)）。
- `MAX_REVISIONS`: セグメントサイズ連動 **小=3 / 中=4 / 大=5**（下限3・上限5）。区分は**絶対トークン閾値**（プロバイダ非依存＝決定的テストのゴールデン値が揺れない）: 小 `<1500` / 中 `<3500` / 大 `>=3500`（§4 の自前推定器で計測）。超過→failed。形式検査の差し戻しもカウント。
- evaluator `verdict`: `pass`→抜ける / `revise`→`issues` を translator の再訳入力へ / `fail`→即 failed。
- 全文ゲート失敗の分類: 翻訳起因の LaTeX 文法ミス→失敗スニペット＋エラー行のみで再訳 / 構造・テンプレ起因→明示的失敗。

## 4. セグメント分割・トークン予算（モデル非依存）

- 境界: `\section`/`\subsection` を第一境界。1セグメントがトークン予算超過なら段落境界で再分割。分割は決定的関数（テスト対象）。
- 予算はモデルのコンテキスト窓 `CW` から逆算:
  - 原文セグメント上限 `segmentBudget ≈ 0.30 × CW`
  - 訳出予約 `= 1.5 × segmentBudget`、思考余白 `= max(2_000, 0.15 × CW)`、残りを システム/辞書オーバーヘッド＋安全に充てる。
  - `CW` は**プロバイダ設定の定数**（claude subprocess はモデルを渡さないので保守的に既定 `200_000`、Ollama はモデルの context を設定に明記）。実行時に設定から取得。
- **トークン計測は JPaper 自前の決定的推定器**（プロバイダのトークナイザに依存しない固定実装＝分割・MAX 判定が決定的でテスト可能）。プロバイダを変えても分割結果は変わらない。
- glossary-builder の「全文1回」も同 30% ルール。超える論文は候補集合を共有したまま確定パスを分割。

## 5. プロバイダ・CLI 契約

- v1 実装 = **2つ**: `ollama`（local, オンデマンド daemon）/ `claude`（cloud, `claude -p --output-format json` の `result` を抽出）。codex/OpenRouter/API キーは将来。
- `--provider {ollama|claude}` は **必須（既定なし）**。省略はエラー（終了コード §6）。**受理値の正本は `ollama|claude`**（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) の例示 `local|cloud` は概念軸。CLI 実値は本付録が正本）。
- claude CLI は純変換器化して使う: `--append-system-prompt` で役割注入、`--max-turns 1`、内蔵ツール無効化（`--allowedTools` 空）。対応 CLI バージョンはレンジ指定し、出力 JSON 形式は統合テストで回帰検知。
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

- stdout: 最終成果パスとサマリ JSON。stderr: 進捗・エラー。

## 7. 見積りスコープ（2段構成・2026-07-09 確定）

新B レビューを受け、v1 を2段で発注する。

- **(A) 固定価格 = コア**: 用語 DB（`node:sqlite`）／薄いランタイム＋エージェント配線／節ループ品質ゲート（形式検査＋evaluator＋再訳）／durable checkpoint／CLI・プロバイダ。§1–6・§8 の契約で確定。
- **(B) 上限付き T&M = 組版・図・引用レイヤ**: `assemble-latex`（訳文＋manifest→`main.tex`/chapters）／共通プリアンブル・引用マクロテンプレ／全文組版ゲートのビルドエラー分類＋エラー行→セグメント逆引き／`.bbl` 番号順パース＋`\cite`→番号対応表／図 manifest。工数の幅が大きいため実費上限方式。
- **Phase2（別フェーズ）**: PDF-only 抽出（Nougat/GPU/Docker/`nougat-ocr`/`pymupdf`/`pdfplumber`）／`.bbl` 著者年スタイル／`glossary.db` 並行実行。

## 7.5 (A) コアの受け入れ条件（(B) 非依存で定義）

(A) は組版=(B) を持たないため「main.pdf 生成（終了コード0・`buildOk`・`pdfPath`）」に単体で到達できない。(A) の完成を (B) から切り離して定義する（R1 解消）。

- **(A) の成果**: 節ループ品質ゲートを通過した**訳文セグメント群**（`translation/chapters/*` 相当の中間物）＋ per-paper 確定辞書（`glossary.md`）＋ `RunSummary`。**組版・PDF は含まない**。
- **(A) 単体の終了コード**: `0`=全セグメントが節ループ通過（翻訳完了・組版前）／`2`=入力・プロバイダ／`3`=形式検査が MAX 内に通らず failed／`4`=品質未達 failed。`5`（全文組版ゲート）・`pdfPath`・`buildOk` は **(B) 結合後に評価**（(A) 単体では `RunSummary.buildOk = null`）。
- **(A) の検収**: ①`FakeLlmClient` 注入で配線・段階遷移・checkpoint の idempotent-skip・`MAX_REVISIONS` 到達 failed が決定的に再現、②実 LLM で訳文セグメント＋`glossary.md` が生成され `RunSummary` が返る。組版通過は (B) 検収項目。

## 8. 追加契約（新B レビュー反映）

- **core API**: `translatePaper(input: JpaperInput, opts: { provider: "ollama"|"claude"; outDir?: string }): Promise<Result>`。`Result = { status: "ok"|"failed"; pdfPath?: string; exitCode: number; summary: RunSummary }`。CLI・GUI はこの1関数を呼ぶ薄い皮（[UI/配置 ADR](../adr/20260709-user-interface-file-layout-and-cli.md) 決定4）。例外は投げず `status/exitCode` で表現（§6 と対応）。
- **stdout サマリ JSON**: `RunSummary = { paperId, outDir, segments: {total, passed, failed}, revisions: {max, used}, glossary: {proposedAdded}, buildOk: boolean, exitCode }`（zod 定義を実装時に写経）。
- **リトライ（`isTransient`）**: 対象＝ネットワーク瞬断・タイムアウト・HTTP 429/5xx・Ollama 一時的接続不可。回数3・指数バックオフ（初期 1s, ×2, 上限 10s）。それ以外（タスク失敗）はリトライせず surface。
- **形式検査の合否規則（節ループ内・決定的）**: 数式保全＝原文と訳文で `$...$`／`\[...\]`／`\begin{equation|align|...}` の**個数一致**（中身は問わない）。段落欠落なし＝**訳文段落数 ≤ 原文段落数**（日本語で複数段落を自然に統合するのを許容。分割・水増しは不可）。ただし訳文段落数が原文の **50% 未満**なら明らかな欠落として error。`keep-original` 一貫＝当該語が全出現で原形のまま。zod 適合＝§1 スキーマ。（大セグメント `>=3500` がトークン予算 `0.30×CW` を超える場合の段落境界での再分割は §4 の core 実装＝(A) に含む。）
- **Ollama 設定契約**: 設定に `model`（例 `llama3.1:8b`）・`contextWindow`・`keepAlive`・`port`。`ollama serve` はオンデマンド起動、起動/モデル未 pull 失敗は明示案内＋**終了コード 2**（プロバイダ利用不能）。
- **claude CLI**: 対応バージョンはレンジで固定（実装時に基準版を pin し統合テストで回帰検知）。抽出は `--output-format json` の `result` フィールド固定。
- **arXiv ID 取得**: `<input>` が arXiv ID のときソース tarball を取得。ネットワーク不可/取得失敗は明示的失敗（終了コード 2）。取得先・レート制限は実装時に pin。
- **`LlmClient` 境界の型（正本）**: `type LlmClient = { complete(req: { model?: string; system: string; user: string }): Promise<string> }`。`model` は claude(subprocess) では未使用＝optional、Ollama/将来 API では必須。戻り値は**JSON テキスト文字列**（呼び出し側が extractJson→zod.parse）。system は §13A の3部品ビルダー出力。
- **`JpaperInput` 型（正本）**: `type JpaperInput = { kind: "path"; path: string } | { kind: "arxiv"; id: string }`。CLI の `<input>` 文字列を判定してこの discriminated union に正規化。判定不能は終了コード 2。
- **`paper-defined`/`bilingual` の厳守も機械検査に含む**（§13C の「`値(Value)` 統一を決定的テスト」と整合／G6 の矛盾解消）: 確定 `form` が当該語の**全出現で使われているか**を形式検査で判定（`keep-original` 一貫と同列）。
- **単一終了コード決定規則**（1 run で複数原因が混在時）: `2`（入力/プロバイダ）> `3`（形式失敗）> `4`（品質失敗）> `5`（全文ゲート=(B)）の優先順位で1つに決める。
- **大セグメント再分割後の扱い**: 再分割した各断片で `MAX_REVISIONS` 区分（小/中/大＝絶対トークン閾値）を**断片ごとに再判定**。`firstOccurrence` は断片をまたいでも**文書全体で1回**（決定的インデクサが全文基準で付与、分割の影響を受けない）。
- **収集[決定的] の v1 最小仕様（(A) 固定スコープ・工数を pin）**: 定義パターンは**固定セット**に限定する — (1) `\newcommand`、(2) `we (call|define|term|denote) X` / `we refer to ... as X`、(3) `X (is|are) defined as`、(4) `\emph{}`/`\textit{}`/`\textbf{}` の初出、(5) 大文字始まりの複合固有名。加えて DB `src` への**最長一致**。**網羅性は求めない**（取りこぼしは全文を読む glossary-builder が補う）。パターン拡充・ネット検索連携は roadmap（本付録 §7 の (B)/Phase2 外の enhancement）。
