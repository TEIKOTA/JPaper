# 2026/10/08 本文中の \author は訳さず、印で伏せて原文のまま残す

# Status
- accepted

# Situation
- Web アプリ（#328）の動作確認で 4 論文を claude の 4 設定（Sonnet 5.5 / Haiku 5.5 × effort medium / low）で同時に訳し、3 本が落ちた。うち arXiv 2407.12996（Haiku 5.5 / low）は先頭の節 seg-0000 が形式検査 `symbol-command` で落ちた（#331）。
- 本文の `\title` は契約付録 §8 の keep（丸ごと 1 つの印）で伏せているが、`\author` は生のまま translator に渡っていた。

# Context
- seg-0000 は `\author{ 氏名〔n〕, … \\ 所属\\ … }` と英文アブストラクト。検査側から見た原文の `\\` は 8 個ですべて `\author` の中にある。`symbol-command` は行終端 `\\` の個数の完全一致を求める（[エスケープ特殊文字保護 ADR](./20260815-protect-escaped-specials-too.md) で `\\` は保護区間に含めないと決めたため）。
- 翻訳指示は「本文を訳し、制御綴りは原文どおり」で、著者・所属を訳すかどうかを決めていない。モデルは所属を訳したり改行を詰めたりし、`\\ src=8 ja=N` の差し戻しを 3 回受けても直らなかった（失敗した訳文は保存されないので推定）。
- 著者名と所属は訳す対象かどうかが決まっていなかった。利用者の判断で「著者・所属はそのまま」と決めた（2026-10-08）。

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
- 会議テンプレ固有の著者命令（ICML の `\icmlauthor` など）は #330 で扱う。

# Consequences
- 良い面
  - 著者ブロックの `\\` の数がずれて節ごと落ちる失敗が、構造上起こらなくなる。著者ブロックぶんの入力・出力トークンも減る。
  - 著者表記が原文と完全に一致する（訳し方の揺れが出ない）。
- トレードオフ
  - `\thanks{…}`（謝辞・連絡先）など `\author` の中にある文も訳されない。
  - 既に訳した節の checkpoint は無効化されないので、所属を訳した旧訳は、その節を訳し直すまで残る。
  - 印が 1 つ増える節では、`\title` と合わせて 2 つの「訳さない印」が並ぶ。
