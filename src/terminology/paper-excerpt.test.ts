import { describe, it, expect } from "vitest";
import { leadSentences, MAX_EXCERPT_CHARS, paperExcerpt } from "./paper-excerpt.js";

const PAPER = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\title{T}\\maketitle",
  "\\begin{abstract}",
  "We study  robustness of brain MRI segmentation. % hidden comment",
  "We release a benchmark.",
  "\\end{abstract}",
  "\\section{Introduction}",
  "Deep models fail under shift. They are brittle in practice. A third sentence.",
  "\\subsection{Contributions}",
  "We propose ROOD-MRI. It is open.",
  "% \\section{Commented Out}",
  "\\section*{Related Work}",
  "Prior work exists.",
  "\\end{document}",
].join("\n");

describe("paperExcerpt（契約付録 §4・issue #258）", () => {
  it("abstract・見出し（深さつき）・各見出しの直後の 2 文を取り出し、コメントは落とす", () => {
    expect(paperExcerpt(PAPER)).toBe(
      [
        "[abstract] We study robustness of brain MRI segmentation. We release a benchmark.",
        "§ Introduction: Deep models fail under shift. They are brittle in practice.",
        "§§ Contributions: We propose ROOD-MRI. It is open.",
        "§ Related Work: Prior work exists.",
      ].join("\n"),
    );
  });

  it("本文に abstract が無ければ前文の \\abstract{…} を使う。どちらも無ければ見出しだけ", () => {
    const pre = "\\documentclass{mdpi}\\abstract{Short abstract here.}\\begin{document}\\section{A}Body.\\end{document}";
    expect(paperExcerpt(pre).split("\n")[0]).toBe("[abstract] Short abstract here.");
    expect(paperExcerpt("\\begin{document}\\section{A}Body.\\end{document}")).toBe("§ A: Body.");
  });

  it("全体は MAX_EXCERPT_CHARS 字まで（見出しの途中で切らず、入る行までにする）", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `\\section{Heading ${String(i)}}Sentence one. Sentence two.`).join("\n");
    const out = paperExcerpt(`\\begin{document}${many}\\end{document}`);
    expect(out.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(out.split("\n").every((l) => /^§ Heading \d+: Sentence one\. Sentence two\.$/.test(l))).toBe(true);
  });

  it("leadSentences: 句点・終止符で 2 文、無ければ上限で切る。小数点では切らない", () => {
    expect(leadSentences("値は 3.5 である。次の文。三つ目。")).toBe("値は 3.5 である。次の文。");
    expect(leadSentences("Accuracy is 3.5 points higher. Next one! Third.")).toBe("Accuracy is 3.5 points higher. Next one!");
    expect(leadSentences("x".repeat(1000), 2, 10)).toBe("xxxxxxxxx…");
  });

  it.each([
    ["閉じない見出しの羅列", "\\section{".repeat(80_000)],
    ["閉じない abstract", "\\begin{abstract}".repeat(60_000)],
    ["見出しだけの羅列", "\\section{a}".repeat(90_000)],
  ])("線形時間で終わる（%s、1MiB 前後）", (_name, body) => {
    const t = performance.now();
    paperExcerpt(`\\begin{document}${body}\\end{document}`);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
