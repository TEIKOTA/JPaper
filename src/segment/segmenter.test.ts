import { describe, it, expect } from "vitest";
import {
  sizeClassFor,
  maxRevisionsFor,
  segmentBudgetFor,
  extractDocumentBody,
  segment,
} from "./segmenter.js";
import { estimateTokens } from "./token-estimator.js";

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

describe("段落分割のコスト", () => {
  it("入力長に線形（バッファを数え直さない）", () => {
    // 連結後の文字列を段落ごとに数え直していた頃は O(n²) で、400KiB の入力が
    // 120,557ms 同期でイベントループを止めた（10ms タイマー発火 0/12,055）。
    const body = "a\n\n".repeat(Math.floor((400 * 1024) / 3));
    const started = Date.now();
    const segs = segment(`\\begin{document}\\section{S}${body}\\end{document}`, 60_000);
    expect(segs.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("足し込みの丸めが連結して数えた値と一致する", () => {
    // Math.ceil(other/4) は加法的でないので、丸めは合計してから 1 度だけ掛ける。
    const paras = ["ab", "日本語の段落", "cde", "漢字と ascii の混在", "f"];
    const body = paras.join("\n\n");
    for (const budget of [3, 5, 8, 13, 21]) {
      for (const seg of segment(`\\begin{document}\\section{S}${body}\\end{document}`, budget)) {
        expect(seg.tokens).toBe(estimateTokens(seg.latex));
      }
    }
  });
});
