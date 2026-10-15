import { describe, expect, it } from "vitest";
import { documentTextBox, figureKey, figureRegions, parseBboxLayout, textBox, type PageLayout, type TextBlock } from "./figures.js";
import { placeFigures } from "./assemble.js";

// 504×720pt の書籍のページ（GSM 252 の実測の座標に合わせる）。本文の幅は 72.7〜431.3pt。
function block(x0: number, y0: number, x1: number, y1: number, text: string, lineCount = 1): TextBlock {
  const h = (y1 - y0) / lineCount;
  return {
    x0,
    y0,
    x1,
    y1,
    text,
    lines: Array.from({ length: lineCount }, (_, i) => ({ x0, y0: y0 + i * h, x1, y1: y0 + (i + 1) * h })),
  };
}
const page = (blocks: TextBlock[]): PageLayout => ({ width: 504, height: 720, blocks });
const BODY = (y0: number, y1: number, lines = 5): TextBlock =>
  block(72.7, y0, 431.3, y1, "body text of the paragraph that spans the full width", lines);

describe("図の範囲（キャプションの上の空白）", () => {
  it("柱の下からキャプションの上まで（p.38 の Figure 1.1。凡例とグラフを分けない）", () => {
    const layout = page([
      block(72.7, 55.8, 83.5, 66.7, "16"),
      block(363, 55.8, 431.3, 66.7, "1. Introduction"),
      block(185.8, 298.7, 318.2, 307.7, "Figure 1.1. Bias-variance tradeoff."),
      block(108.5, 517.6, 395.5, 537.5, "Figure 1.2. Double-descent curve in deep learning", 2),
      BODY(560, 660, 6),
    ]);
    const r = figureRegions(layout, { x0: 72.7, x1: 431.3 });
    expect(r.map((x) => x.label)).toEqual(["Figure 1.1.", "Figure 1.2."]);
    // 柱の下の罫線を避けて少し下から。
    expect(r[0]!.y0).toBeGreaterThan(66.7 + 4);
    expect(r[0]!.y1).toBeCloseTo(298.7 - 2);
    // 2 つ目は 1 つ目のキャプションの下から。
    expect(r[1]!.y0).toBeCloseTo(307.7 + 2);
    expect(r[1]!.y1).toBeCloseTo(517.6 - 2);
  });

  it("直前の本文の段落の下から切り、図の中の細い文字（軸ラベル・凡例）では切らない", () => {
    const layout = page([
      BODY(100, 200),
      block(200, 250, 260, 258, "Model Complexity"),
      block(150, 300, 260, 318, "Total Error variance", 2),
      block(150, 330, 350, 340, "Figure 2.1. A plot."),
      BODY(360, 460),
    ]);
    const [r] = figureRegions(layout, { x0: 72.7, x1: 431.3 });
    expect(r!.y0).toBeCloseTo(202);
    expect(r!.y1).toBeCloseTo(328);
  });

  it("表のキャプションの下からは切らない（表のキャプションも境界）", () => {
    const layout = page([BODY(80, 120), block(180, 130, 320, 140, "Table 3.2. Data"), block(180, 300, 330, 310, "Figure 3.10. Histogram.")]);
    const [r] = figureRegions(layout, { x0: 72.7, x1: 431.3 });
    expect(r!.y0).toBeCloseTo(142);
  });

  it("2 段組で片方の段のキャプションなら、その段の範囲で切る。読む順は左の段→右の段", () => {
    // 段の幅 230pt ずつ（本文の幅 72〜540）。
    const col = (x0: number, y0: number, y1: number): TextBlock => block(x0, y0, x0 + 230, y1, "column body text here", 6);
    const layout: PageLayout = {
      width: 612,
      height: 792,
      blocks: [
        col(72, 100, 300),
        col(310, 100, 200),
        block(320, 400, 520, 410, "Figure 2. Right column figure."),
        col(72, 320, 500),
        block(80, 600, 290, 610, "Figure 1. Left column figure."),
        col(310, 420, 700),
      ],
    };
    const r = figureRegions(layout, { x0: 72, x1: 540 });
    expect(r.map((x) => x.label)).toEqual(["Figure 1.", "Figure 2."]);
    expect(r[0]!.x1).toBeLessThanOrEqual(306 + 2);
    expect(r[0]!.y0).toBeCloseTo(502);
    expect(r[1]!.x0).toBeGreaterThanOrEqual(306 - 2);
    expect(r[1]!.y0).toBeCloseTo(202);
  });

  it("キャプションの上に 20pt の余地も無ければ切り出さない", () => {
    const layout = page([BODY(100, 300), block(150, 310, 300, 320, "Figure 4.1. Tight.")]);
    expect(figureRegions(layout, { x0: 72.7, x1: 431.3 })).toEqual([]);
  });

  it("本文中の「Figure 1.1 shows」はキャプションではない", () => {
    const layout = page([BODY(100, 200), block(72.7, 300, 431.3, 310, "Figure 1.1 shows the tradeoff between bias and variance")]);
    expect(figureRegions(layout, { x0: 72.7, x1: 431.3 })).toEqual([]);
  });
});

describe("bbox の読み取り", () => {
  const xhtml = `<doc><page width="504.000000" height="720.000000"><flow>
<block xMin="185.8" yMin="298.7" xMax="318.2" yMax="307.7"><line xMin="185.8" yMin="298.7" xMax="318.2" yMax="307.7">
<word xMin="185.8" yMin="298.7" xMax="213.3" yMax="307.7">Figure</word><word xMin="215" yMin="298.7" xMax="229" yMax="307.7">1.1.</word>
<word xMin="233" yMin="298.7" xMax="284" yMax="307.7">A&amp;B</word></line></block></flow></page></doc>`;

  it("ページの寸法・ブロック・行・語を読む（実体参照を戻す）", () => {
    const l = parseBboxLayout(xhtml)!;
    expect(l.width).toBe(504);
    expect(l.blocks[0]!.text).toBe("Figure 1.1. A&B");
    expect(l.blocks[0]!.lines).toHaveLength(1);
  });

  it("本文の幅は上端・下端の帯と短い行を除いて測り、文書全体は中央値", () => {
    const body = page([BODY(100, 200), block(9, 690, 495, 700, "Purchased from the publisher for the exclusive use of somebody")]);
    expect(textBox(body)).toEqual({ x0: 72.7, x1: 431.3 });
    expect(documentTextBox([body, page([BODY(100, 200)]), page([])])).toEqual({ x0: 72.7, x1: 431.3 });
  });
});

describe("図の目印を置き換える", () => {
  const mark = "\\par\\noindent\\fbox{Figure omitted (see page 3 of the original PDF)}";
  const fig = (key: string): { key: string; file: string } => ({ key, file: `figures/${key}.png` });

  it("目印の後ろのキャプションの番号と同じ番号の図を貼り、段落の頭なら center で包む", () => {
    const tex = `${mark}\n\n\\textbf{Figure 2.1.} One.\n\n${mark}\n\n\\textbf{Figure 2.2.} Two.`;
    const r = placeFigures(tex, [fig("2.2"), fig("2.1")]);
    expect(r).toMatchObject({ placed: 2, marks: 2 });
    expect(r.tex.indexOf("{figures/2.1.png}")).toBeLessThan(r.tex.indexOf("{figures/2.2.png}"));
    expect(r.tex).toContain("\\begin{center}\\includegraphics");
  });

  it("前の図が切り出せなくても、後ろの図を前の目印に貼らない", () => {
    const tex = `${mark}\n\nFigure 2.1. One.\n\n${mark}\n\nFigure 2.2. Two.`;
    const r = placeFigures(tex, [fig("2.2")]);
    expect(r).toMatchObject({ placed: 1, marks: 2 });
    expect(r.tex.indexOf("Figure omitted")).toBeLessThan(r.tex.indexOf("Figure 2.1."));
    expect(r.tex.indexOf("{figures/2.2.png}")).toBeGreaterThan(r.tex.indexOf("Figure 2.1."));
  });

  it("番号の無い目印は残し、段落の頭でない目印は center で包まない", () => {
    expect(placeFigures(`${mark}\n\nA caption without a number.`, [fig("1")]).placed).toBe(0);
    const r = placeFigures("\\fbox{Figure omitted (see page 3 of the original PDF)} & Fig. 1: a", [fig("1")]);
    expect(r.placed).toBe(1);
    expect(r.tex).not.toContain("center");
  });

  it("キャプションの番号を読む", () => {
    expect(figureKey("Figure 1.1.")).toBe("1.1");
    expect(figureKey("\\textbf{Fig.~3} x")).toBe("3");
    expect(figureKey("FIGURE s2:")).toBe("S2");
    expect(figureKey("Table 1.")).toBeUndefined();
  });
});
