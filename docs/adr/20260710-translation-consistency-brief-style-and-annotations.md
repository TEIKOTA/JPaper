# 2026/07/10 翻訳一貫性: 文書ブリーフ＋文体契約・evaluator 軸の明文化・訳注 surface

# Status
- accepted

# Situation
- JPaper は学術論文の和訳エージェント。用語は [用語アーキテクチャ ADR](./20260709-terminology-architecture-two-tier-classified-glossary.md) で 2層辞書＋4クラス分類を確定し、品質ゲートは [2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md) で「節ループ＋全文組版ゲート」に分けて**節翻訳を並列化**した。
- 学術翻訳の実務レポート（deep-research, 2026-07-10）を現 spec と突き合わせたところ、**用語の次元はほぼ実装済み**（`paper-defined` 分類は研究の false-friend 懸念の先取り）だが、**用語以外の3次元**に欠落が見つかった。個人利用で成果物は**日本語 PDF のみ読む**前提を踏まえ、実装前に方針を確定する。

# Context
- 欠落は独立ではなく、いずれも「節を並列・独立に訳す」現アーキテクチャ（[2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md) 決定2）の**局所最適／大域不整合**という同じ弱点に帰着する。
  1. **文書レベルの理解の非共有**: glossary-builder は全文を1回読むが目的は用語確定のみ。translator は節ごと・並列で `latex＋glossarySlice` しか受け取らず、**主張の順序・強度（断定/限定/推量）・記法規約**を知らない。統計含意（`significantly`=有意）や hedging を落としうる。
  2. **文体の非共有**: 並列セグメント間で共有されるのは用語だけで、**である調/時制/見出し訳/数字表記**の per-paper 文体契約が無く、文体がぶれる。
  3. **不確実性の非可視化**: 「曖昧なら preserve」で原文保持はするが、それを人間に示す出口が無い。PDF しか読まない運用では、保留・低確信を PDF の外へ出しても届かない。
- 研究が言う「試訳で先に文体を固定」は、JPaper では**新ステージではなく glossary-builder の全文1回パスの副産物**として自然に足せる（用語に加えてブリーフ＋文体契約も同時確定→全 translator へ注入）。
- 「機械化してよいのは事実の有無だけ」（[品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) 決定1）を守り、品質判断は LLM、事実に落とせるものだけを機械化する。

# Material for decision
- 学術翻訳の実務レポート（deep-research, 2026-07-10。要点＝原文理解の前倒し・用語集の事前固定・主張強度と統計語の保持・単位/記法の非破壊・図表と参考文献の同期・不明語は訳し切らず訳注で保留・機械整合チェック＋第三者レビュー）
- [用語 ADR](./20260709-terminology-architecture-two-tier-classified-glossary.md)（2層辞書・4クラス・retrieval-then-inject）
- [2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md)（節ループ＋全文ゲート・並列翻訳）
- [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)（機械=事実の有無 / 品質=LLM・明示的失敗）
- [契約付録](../design/contract-appendix.md)（zod I/O・値の正本）

# Decision

## 決定 1: glossary-builder の全文パスを「用語＋文書ブリーフ＋文体契約」に拡張し全 translator へ注入
- glossary-builder が全文を1回見る際、用語確定に加えて次の2つを副産物として確定・ロックする。
  - **文書ブリーフ**（`brief.md`）: 論文の主張の核・各節の役割・記法規約・主張強度の注意。
  - **文体契約**（`style.md`）: 文体（**既定=である調・常体**）・時制方針・見出し訳・数字/単位表記。
- 両ファイルは **`<paper>-ja/` に可視・編集可**で出力する（`glossary.md` と同格。[UI/配置 ADR](./20260709-user-interface-file-layout-and-cli.md) の透明性方針）。ユーザーが編集→再実行すると durable が下流の翻訳ステップだけを無効化して反映する。
- ブリーフ＋文体契約は §13A の run-context に**確定辞書＋rendering と並べて全 translator に注入**する。並列でも大域一貫を保つ源になる。

## 決定 2: evaluator の評価軸を明文化する
- evaluator の品質判定に、従来の「自然さ・専門用語妥当性・原意保持」へ加えて次を明示軸として足す。
  - **主張強度・hedging の保持**（断定/限定/推量を原文どおり）。
  - **統計語の忠実**（`significantly`＝統計的有意、p 値等の含意を落とさない）。
  - **単位・記法の正しさ**（SI 表記＝立体・`°K`→`K`・数値と単位の間隔）。
- これらは事実の有無に完全には落ちない品質なので LLM（evaluator）が担う。決定的に落とせる単位/略語/表記の一部は決定4の全文 lint に回す。

## 決定 3: 訳注（uncertainties）を導入し PDF 内へ surface する
- **trigger は3種**:
  1. `paper-defined` を preserve/併記した箇所。
  2. **低確信の訳語**（**決定的条件**: `established` 候補だが global DB に `confirmed` 訳が無く `proposed` のみ、または未ヒットで preserve に倒したもの）。
  3. evaluator が `warn` を残した箇所。
- **説明文は LLM 生成**（term 系は glossary-builder が確定時に付す note、warn 系は evaluator の `issue.message`）。訳注の**採否＝trigger は決定的**、**文面＝LLM**、という分担にする。
- **データ生成は (A) コア**: 訳注は `notes.json`（`.run/` 配下）と `glossary.md` の該当語への印として残し、`RunSummary` に件数を載せる。**PDF への描画は (B) 組版**: 本文の**文書全体で初出の箇所にのみ**脚注（`\footnote`）を付け、**巻末に「訳注一覧」**を集約する（`firstOccurrence` を流用し重複を抑える）。

## 決定 4: 全文の決定的「言語整合 lint」は (B) T&M に置く
- 単位表記（SI 規則）・略語の初出定義・glossary 外の訳語表記ゆれ・数字表記の整合を**決定的に**検査する lint を、[2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md) の全文組版ゲートの隣に**言語整合ゲート**として足す。事実の有無に落とせる分だけを機械化し、意味の正誤は evaluator に残す。
- 実装は組版レイヤと同じく**工数の幅が大きいため (B) 上限付き T&M**（[契約付録](../design/contract-appendix.md) §7）に置く。範囲は PerfectIt 相当（表記ゆれ・数字表記含む）まで許容する。

## 決定 5: 既知の落とし穴は evaluator 向け skill に段階開示する（DB は空スタート維持）
- 統計語（`significantly`=有意）・SI 規則・頻出 false friend（`agency`=行為主体性 等）の**注意チェックリストを skill 化**し、**evaluator の system prompt にのみ**段階開示する。translator/glossary-builder は汚さない。
- global DB への seed はしない（[契約付録](../design/contract-appendix.md) §2 の「v1 は空で開始」を維持）。落とし穴は「事実の種」ではなく「レビュー観点」として持つ。

# Consequences
- 良い面
  - 用語だけでなく**文書ブリーフ＋文体契約**を全文1回で確定・注入するため、並列翻訳の速度を保ったまま主張強度・文体の大域一貫を回収できる。
  - `brief.md`/`style.md` が可視・編集可で、ユーザーが方針を上書き→再実行できる（durable と整合）。
  - 「曖昧なら preserve」の判断が**PDF 内の訳注**として読者に届く。trigger を決定的にしたことで訳注の採否がテスト可能。
  - 落とし穴を skill に閉じ込めることで、空スタート方針・「機械化=事実の有無」原則を崩さずに頻出誤訳へ注意を効かせられる。
- トレードオフ
  - glossary-builder の全文パスの責務と出力（`GlossaryBuilderOut` に brief/style/note）が増える。run-context も肥大する（トークン予算 §4 の 30% 圏内で管理）。
  - 訳注の文面が LLM 生成のため**非決定的**（採否は決定的だが文面はテスト対象外）。
  - 言語整合 lint と訳注レンダリングを (B) に足すため (B) の工数上限が上がる。
  - 低確信の決定的条件は DB の衛生（confirmed の充実度）に依存し、育つ前は preserve/訳注が多めに出る（意図した安全側）。
- 本 ADR は [用語 ADR](./20260709-terminology-architecture-two-tier-classified-glossary.md)・[2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md)・[品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) を**改変せず具体化・拡張**する。値・スキーマの正本は [契約付録](../design/contract-appendix.md)。
