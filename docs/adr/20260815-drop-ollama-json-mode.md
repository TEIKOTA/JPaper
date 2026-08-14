# 2026/08/15 Ollama へ format:"json" を送らない（制約デコードが LaTeX の綴りを壊す）

# Status
- accepted
- [構造化出力 ADR](./20260723-provider-branched-structured-output.md) の Ollama 側の決定を置き換える（claude 側の決定は据え置き）。

# Situation
- ローカル LLM 単独（`gemma4:12b-it-qat` / MacBook Air M4 24GB）で論文を訳し切る運用中。数式保護・記号検査・引用検査を入れてもなお、書き写しの失敗が消えなかった。
- 落ちる節は決まって**コホート記述の段落**（`\%` と `\citep` と数値が密集する）で、形式の改稿予算を使い切って失敗していた。

# Context
- 節ループを 1 節だけ再現して各稿を出したところ、モデルの出力がこうなっていた。

  ```
  第 1 稿: … (LIPA) 研究 <TAB>cp{marcotte2017white} からの…
  第 2 稿: … (LIPA) 研究 <改行>citPar{marcotte2017white} からの…
  ```

  `\citep` が TAB や改行に化けている。**これは翻訳の失敗ではなく、出力の符号化の失敗**だった。
- 原因は `format: "json"` の制約デコード。JSON の文字列中で `\c` は不正なエスケープなので、文法は backslash の次に `"\/bfnrtu` しか許さない。モデルが `\citep` を書こうとすると `\t` や `\n` へ倒され、続く文字列も崩れる。
- 同一プロンプト・同一モデルで `format` の有無だけを変えた実測。

  | | 訳文中の `\citep` |
  | --- | --- |
  | `format:"json"` あり | **0 個**（`{"segmentId": …, "ja": "\\subsubsection{…` と始まるが引用は消える） |
  | `format:"json"` なし | **2 個とも保持**（`") 研究 \\citep{mar"` / `") 研究 \\citep{swa"`） |

- `\\subsubsection` は制約下でも正しく二重化されている。**モデルが backslash を出せないのではなく、二重化に失敗したときに文法が誤ったエスケープを強制する**のが問題。
- [構造化出力 ADR](./20260723-provider-branched-structured-output.md) 自身が「**Ollama の実モデル検証は依然後回し**」と書いていた。今回の実測がその欠けていた検証にあたる。
- これまでローカル側で観測してきた書き写しの失敗——`\citep`/`\citet` が `\cite` に化ける、`\%` の backslash が落ちる、行終端 `\\` が消える、数式が壊れる——はすべてこの 1 つの原因で説明がつく。

# Material for decision
- 実測（本 repo）: 上表。`seg-0007` を `format` の有無だけ変えて 1 回ずつ。
- [構造化出力 ADR](./20260723-provider-branched-structured-output.md): 「`format:"json"` は**構文**を保証するが**形状**は保証しない（zod.parse が引き続き検証）」。構文保証のためだけに払っていた代償が、payload が LaTeX のときは中身の破壊だった。
- 既存の受け皿: `extractJson` はコードフェンスを剥がし、前後に散文があっても balanced な JSON 候補を走査する。失敗は `schemaFailure` として `withRetry` に載る。**claude 側は元からこの経路だけで動いている**。
- [数式保護 ADR](./20260814-protect-math-spans-before-translation.md) / [エスケープ特殊文字保護 ADR](./20260815-protect-escaped-specials-too.md): 保護区間は印（backslash を含まない）へ差し替えるので、この不具合の影響を受けない。保護が効いていたのは、偶然この符号化問題を迂回していたからでもある。

# Decision
- **Ollama へ `format` を送らない**。`LlmRequest.jsonMode` はプロバイダ側で無視する（契約のフィールドは将来の API プロバイダのために残す）。
- JSON の取り出しは `extractJson` → zod → `withRetry` に一本化する。claude と同じ経路になる。
- **プロンプトの JSON 指示は残す**（全プロバイダ共通のベースライン）。
- 保護区間（数式・エスケープした特殊文字）は**そのまま維持する**。符号化が直っても、書き写しの機会を減らすこと自体の価値は変わらない。

# Consequences
- 良い面
  - `\citep` / `\%` / `\\` / 数式が**訳文に正しく載る**。これまで形式検査で事後検出していた失敗の主因が消える。
  - 「12B は書き写しが苦手」という見立てが誤りだったと分かった。**モデルの能力ではなく配線の問題**だったので、他のローカルモデルでも同じ改善が期待できる。
  - claude と Ollama で JSON の取り出し経路が 1 本になる（分岐が減る）。
- トレードオフ
  - **構文的に妥当な JSON の保証を失う**。モデルが壊れた JSON を返せば `schemaFailure` で再試行になり、その分の呼び出しコストがかかる（ローカルでは 1 回 35〜226 秒）。実測では `format` 無しでもコードフェンス付きの妥当な JSON が返っており、`extractJson` がフェンスを剥がす。
  - 将来 `format: <json schema>` で形状まで強制したくなっても、この経路は使えない。**LaTeX を JSON 文字列で運ぶ限り、制約デコードとは両立しない**。形状強制が必要になったら、訳文を JSON 文字列ではなく別の枠（区切り付きの平文など）で運ぶ設計変更とセットで考える。
