# 2026/10/08 本文中の \author は訳さず印で伏せ、伏せた区間の用語は節の用語に数えない

# Status
- accepted

# Situation
- Web アプリ（#328）の動作確認で 4 論文を claude の 4 設定（Sonnet 5.5 / Haiku 5.5 × effort medium / low）で同時に訳し、3 本が落ちた。うち arXiv 2407.12996（Haiku 5.5 / low）は先頭の節 seg-0000 が形式検査 `symbol-command` で落ちた（#331）。
- 本文の `\title` は契約付録 §8 の keep（丸ごと 1 つの印）で伏せているが、`\author` は生のまま translator に渡っていた。

# Context
- seg-0000 は `\title`（keep）・`\author{ 氏名, … \\ 所属\\ … }`・英文アブストラクト。調査では当初、`\author` の中の行終端 `\\`（8 個）の数をモデルが変えたと推定した（`symbol-command` は `\\` の個数の完全一致を求める）。翻訳指示は著者・所属を訳すかどうかを決めておらず、利用者の判断で「著者・所属はそのまま」と決めた（2026-10-08）。
- `\author` を伏せても seg-0000 は同じく落ちた。本番と同じ文脈で seg-0000 だけを実モデルに訳させて差し戻し文を記録すると、1〜3 回目は「初出の併記形が無い: フラットなアンサンブル(flat ensemble)」、4 回目は訳文に「% 指摘の語は本セグメントの原文に出現しないため追加していない」というコメントを書き足して `symbol-command`（`%` src=0 ja=1）で落ちていた。
- "flat ensemble" は seg-0000 では keep の `\title{…improving flat ensembles…}` の中にしか無い。節の用語（slice）と初出の節は節の原文全体で数えていたので、translator に見せない `\title` の中の語に「この節で初出の併記をせよ」と求めていた。満たしようのない要求で、改稿予算を使い切って落ちる。
- 文脈（用語・ブリーフ）なしで訳させると seg-0000 は 1 回で通った。失敗の原因はモデルの能力ではなく、伏せた区間と用語の数え方の食い違いだった。

# Material for decision
- [数式保護 ADR](./20260814-protect-math-spans-before-translation.md): 書き写しの機会を与えなければ、書き写しの失敗は原理的に起こらない。
- [保護の要否はモデルの能力で決まる ADR](./20260816-protection-depends-on-model-capability.md): 数式・記号の保護は `PROTECT_SPANS` で切り替える。一方 `\title` の keep は「訳さないのが正しい」ので切り替えに関わらず伏せている。
- 契約付録 §8（本文 `\title` の keep）。印の欠落を `title` として名指しで差し戻し、復元した命令を形式検査・evaluator の両方から外す。
- landmines.md（対訳 PDF のタイトルブロック）は `\author` 段落を訳文側にも残す前提で、`\author` を訳すことは求めていない。

# Decision
- **節の本文にある `\author[..]{..}` 命令全体を、`\title` の keep と同じ扱いで丸ごと 1 つの印に伏せ、原文のまま復元する**。正本は `src/workflows/section-loop.ts`（区間は `src/tools/tex-spans.ts` の `commandSpans`、伏せは `src/segment/protect.ts` の `frozen`）。
- 保護の要否（`PROTECT_SPANS`）とは独立に常に伏せる。数式と違い、モデルの能力ではなく「訳さないのが正しい」から。
- 印の欠落・重複は形式検査 `author` として名指しで差し戻す。復元した `\author` は形式検査・evaluator に見せない（未翻訳と判定させない）。
- checkpoint の無効化キーには入れない（保護の範囲はキーに入らないという既存の扱いに合わせる）。
- **節の用語（slice）と初出の節は、translator が訳す本文（keep の `\title` と `\author` 命令を除いた原文）で数える**。正本は `src/workflows/step-keys.ts` の `translatedLatex`。
- 会議テンプレ固有の著者命令（ICML の `\icmlauthor` など）は #330 で扱う。

# Consequences
- 良い面
  - 著者ブロックの `\\` の数がずれて節ごと落ちる失敗が、構造上起こらなくなる。著者ブロックぶんの入力・出力トークンも減る。
  - 著者表記が原文と完全に一致する（訳し方の揺れが出ない）。
  - タイトルや著者にだけ出る用語で、本文の節に満たせない併記を求めなくなる。用語の初出は、本文で最初に出る節に移る。
- トレードオフ
  - `\thanks{…}`（謝辞・連絡先）など `\author` の中にある文も訳されない。
  - 既に訳した節の checkpoint は無効化されないので、所属を訳した旧訳は、その節を訳し直すまで残る。
  - 伏せた区間にだけ出る用語がある論文では、その節と初出が移った節の slice が変わるので、再実行でその節を訳し直す（用語集の編集は新しい鍵で署名し直して進む）。
  - 印が 1 つ増える節では、`\title` と合わせて 2 つの「訳さない印」が並ぶ。
