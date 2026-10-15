import { describe, expect, it } from "vitest";
import { checkWords, latexWords, MAX_MISSING_RUN, OMITTED_MARK, textLayerWords } from "./word-check.js";

const LAYER = `see Remark 18.1. We will specifically discuss the necessity for decay in the
learning rate in the next Section 18.3.3. We will prove in Lemma 18.7 that SGD
converges to the global minimizer for strongly convex functions.
Lemma 18.7. Let Assumptions 17.6 and 18.4 hold with 𝜅2 ≥ 1.`;

const FULL = String.raw`see Remark 18.1. We will specifically discuss the necessity for decay in the
learning rate in the next Section 18.3.3. We will prove in Lemma 18.7 that SGD
converges to the global minimizer for strongly convex functions.

\textbf{Lemma 18.7.} \textit{Let Assumptions 17.6 and 18.4 hold with $\kappa_2 \geq 1$.}`;

describe("テキスト層の語", () => {
  it("3 文字以上の英字だけを小文字で数え、数式の Unicode 英字・演算子名は数えない", () => {
    expect(textLayerWords("𝔼 [Λ(𝜃𝑘)] ≤ lim sup the Lemma")).toEqual(["the", "lemma"]);
  });

  it("行末の分綴と合字をつなぐ", () => {
    expect(textLayerWords("continuous time approxima-\ntion of the ﬁrst")).toEqual([
      "continuous",
      "time",
      "approximation",
      "the",
      "first",
    ]);
  });
});

describe("起こした LaTeX の語", () => {
  it("数式は落とし、数式の中の \\text{} と命令の引数は残す", () => {
    const { words } = latexWords(String.raw`\textbf{Lemma} holds $\|x\|\le C \text{ for all } k$ by \cite{BCN18}.`);
    expect(words).toEqual(["lemma", "holds", "bcn", "for", "all"]);
  });

  it("コメントは落とし、省いた文字の申告は別に数える", () => {
    const r = latexWords(`body text here\n% a comment line\n${OMITTED_MARK} Total Error variance\n`);
    expect(r.words).toEqual(["body", "text", "here"]);
    expect(r.omitted).toEqual(["total", "error", "variance"]);
  });
});

describe("語句の突き合わせ", () => {
  it("すべて写していれば合格", () => {
    const r = checkWords(LAYER, FULL);
    expect(r.ok).toBe(true);
    expect(r.maxMissingRun).toBe(0);
  });

  it("ページ先頭の段落を書き落とすと、連続した欠けで不合格になる（実測 p.3 の形）", () => {
    const dropped = FULL.slice(FULL.indexOf("\\textbf{Lemma"));
    const r = checkWords(LAYER, dropped);
    expect(r.ok).toBe(false);
    expect(r.maxMissingRun).toBeGreaterThanOrEqual(MAX_MISSING_RUN);
    expect(r.missingSample).toContain("remark");
  });

  it("ばらばらの 1〜2 語の不一致は合格（引用キーや数式の中の語）", () => {
    const r = checkWords(LAYER, FULL.replace("specifically ", "").replace("strongly ", ""));
    expect(r.ok).toBe(true);
    expect(r.maxMissingRun).toBe(1);
  });

  it("連続 4 語の欠けは合格、5 語で不合格（境界）", () => {
    const layer = "alpha beta gamma delta epsilon zeta theta";
    expect(checkWords(layer, "alpha zeta theta epsilon").ok).toBe(true); // beta gamma delta の 3 語
    expect(checkWords(layer, "alpha epsilon zeta theta").maxMissingRun).toBe(3);
    expect(checkWords(layer, "alpha zeta theta").maxMissingRun).toBe(4);
    expect(checkWords(layer, "alpha zeta theta").ok).toBe(true);
    expect(checkWords(layer, "alpha theta").maxMissingRun).toBe(5);
    expect(checkWords(layer, "alpha theta").ok).toBe(false);
  });

  it("省いたと申告した語は欠けに数えないが、申告が多すぎれば不合格", () => {
    const layer = "Total Error variance bias optimal complexity Figure caption text";
    expect(checkWords(layer, `Figure caption text\n${OMITTED_MARK} Total Error variance bias optimal complexity`).ok).toBe(true);
    const many = Array.from({ length: 40 }, (_, i) => `word${"x".repeat(i % 5)}abc`).join(" ");
    const r = checkWords(many, `${OMITTED_MARK} ${many}`);
    expect(r.omitted).toBe(40);
    expect(r.ok).toBe(false);
  });

  it("テキスト層に無い文字（既に落とした購入者表示）の申告は、上限に数えない", () => {
    const footer = "Purchased from Example Society for the exclusive use of Somebody Copyright Duplication prohibited ".repeat(4);
    const r = checkWords("alpha beta gamma delta", `alpha beta gamma delta\n${OMITTED_MARK} ${footer}`);
    expect(r.omitted).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("起こした側にだけある語を数える", () => {
    expect(checkWords("alpha beta gamma", "alpha beta gamma injected words").extra).toBe(2);
  });
});
