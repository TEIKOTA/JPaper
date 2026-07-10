import { describe, it, expect } from "vitest";
import {
  sizeClassFor,
  maxRevisionsFor,
  segmentBudgetFor,
  extractDocumentBody,
  segment,
} from "./segmenter.js";

describe("sizeClass / maxRevisions / budget", () => {
  it("sizeClass 境界（<1500 / <3500 / >=3500）", () => {
    expect(sizeClassFor(1499)).toBe("small");
    expect(sizeClassFor(1500)).toBe("medium");
    expect(sizeClassFor(3499)).toBe("medium");
    expect(sizeClassFor(3500)).toBe("large");
  });
  it("maxRevisions 3/4/5", () => {
    expect(maxRevisionsFor(100)).toBe(3);
    expect(maxRevisionsFor(2000)).toBe(4);
    expect(maxRevisionsFor(5000)).toBe(5);
  });
  it("segmentBudget = 0.30×CW", () => {
    expect(segmentBudgetFor(200000)).toBe(60000);
  });
});

describe("extractDocumentBody", () => {
  it("document 環境の中身を取り出す", () => {
    expect(
      extractDocumentBody("\\documentclass{a}\\begin{document}BODY\\end{document}"),
    ).toBe("BODY");
  });
  it("document 環境が無ければ全体", () => {
    expect(extractDocumentBody("no doc env")).toBe("no doc env");
  });
});

describe("segment", () => {
  it("\\section 境界で分割し決定的 id を振る", () => {
    const latex =
      "\\begin{document}\\section{A}aaa \\section{B}bbb\\end{document}";
    const segs = segment(latex, 100000);
    expect(segs.length).toBe(2);
    expect(segs[0]!.latex).toContain("\\section{A}");
    expect(segs[1]!.latex).toContain("\\section{B}");
    expect(segs[0]!.id).toBe("seg-0000");
    expect(segs[1]!.id).toBe("seg-0001");
    expect(segs[0]!.tokens).toBeGreaterThan(0);
  });

  it("節前の前文も1セグメントになる", () => {
    const latex = "\\begin{document}イントロ本文\\section{A}aaa\\end{document}";
    const segs = segment(latex, 100000);
    expect(segs.length).toBe(2);
    expect(segs[0]!.latex).toContain("イントロ本文");
  });

  it("予算超過セグメントは段落境界で再分割する", () => {
    const paras = Array.from(
      { length: 5 },
      (_, i) => `para${i} ${"word ".repeat(50)}`,
    ).join("\n\n");
    const latex = `\\begin{document}\\section{X}\n${paras}\n\\end{document}`;
    const segs = segment(latex, 30);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.map((s) => s.id)).toEqual(
      segs.map((_, i) => `seg-${String(i).padStart(4, "0")}`),
    );
  });
});
