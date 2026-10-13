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

  it("上限を超えても見出しは全部残し、冒頭文は浅い見出しから入る分だけ足す", () => {
    const filler = "Words ".repeat(60);
    const secs = Array.from({ length: 30 }, (_, i) =>
      `\\section{Part ${String(i)}}${filler}first. Second.\\subsection{Sub ${String(i)}}${filler}sub. More.`,
    ).join("\n");
    const out = paperExcerpt(`\\begin{document}${secs}\\section{Conclusions}We conclude. Done.\\end{document}`);
    expect(out.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("§ ")).length).toBe(31);
    expect(lines.filter((l) => l.startsWith("§§ ")).length).toBe(30);
    expect(lines.at(-1)).toBe("§ Conclusions: We conclude. Done.");
    // 浅い見出しの冒頭文が先に入る。
    expect(lines.filter((l) => l.startsWith("§ ") && l.includes(": ")).length).toBe(31);
    expect(lines.filter((l) => l.startsWith("§§ ") && l.includes(": ")).length).toBeLessThan(30);
  });

  it("見出しだけで上限を超えるなら、入る見出しまで（冒頭文なし）", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `\\section{Heading ${String(i)}}Sentence one. Sentence two.`).join("\n");
    const out = paperExcerpt(`\\begin{document}${many}\\end{document}`);
    expect(out.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(out.split("\n").every((l) => /^§ Heading \d+$/.test(l))).toBe(true);
  });

  it("冒頭文から \\label・図表・verbatim を外し、任意引数のある見出しは必須引数を題にする", () => {
    const tex = [
      "\\begin{document}",
      "\\section[Short {X}]{Long title}\\label{sec:a}",
      "\\begin{figure}[t]\\centering\\includegraphics{a.png}\\caption{Cap.}\\end{figure}",
      "\\begin{verbatim}\\section{Fake}\\end{verbatim}",
      "Real prose here. Second one.",
      "\\end{document}",
    ].join("\n");
    expect(paperExcerpt(tex)).toBe("§ Long title: Real prose here. Second one.");
  });

  it("abstract*・空の abstract 環境は前文の \\abstract{} に切り替える", () => {
    expect(paperExcerpt("\\begin{document}\\begin{abstract*}Star abs.\\end{abstract*}\\end{document}")).toBe("[abstract] Star abs.");
    expect(
      paperExcerpt("\\abstract{Pre abs.}\\begin{document}\\begin{abstract} \\end{abstract}\\end{document}"),
    ).toBe("[abstract] Pre abs.");
  });

  it("leadSentences: 略語（e.g.・et al.・Fig.）では切らず、全角の終止符で切る", () => {
    expect(leadSentences("We use e.g. ResNet and others. Third. Fourth.")).toBe("We use e.g. ResNet and others. Third.");
    expect(leadSentences("Fig. 3 shows it, as Smith et al. note. Next. Last.")).toBe("Fig. 3 shows it, as Smith et al. note. Next.");
    expect(leadSentences("これは文である．次の文！三つ目？")).toBe("これは文である．次の文！");
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
