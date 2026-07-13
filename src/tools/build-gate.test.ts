import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyLog, stageBuild, runBuildGate, checkFigures } from "./build-gate.js";
import type { SourceSpan } from "./assemble-latex.js";

const MAP: SourceSpan[] = [
  { id: "seg-0000", startLine: 10, endLine: 20 },
  { id: "seg-0001", startLine: 21, endLine: 40 },
];

const temps: string[] = [];
function mkTemp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "jpaper-build-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("classifyLog", () => {
  it("本文行のエラーはセグメントへ逆引きする（翻訳起因）", () => {
    const log = "./main.tex:25: Paragraph ended before \\align* was complete.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([
      { id: "seg-0001", line: 25, message: "Paragraph ended before \\align* was complete." },
    ]);
    expect(c.structuralErrors).toEqual([]);
  });
  it("マップ外（前文など）のエラーは構造起因にする", () => {
    const log = "main.tex:3: Undefined control sequence.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toEqual(["main.tex:3: Undefined control sequence."]);
  });
  it("main.tex 以外（.cls/.sty）の file:line エラーも構造起因に残す", () => {
    const log = "./nips_2017.sty:42: Undefined control sequence.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toEqual(["nips_2017.sty:42: Undefined control sequence."]);
  });
  it("欠図と未解決参照/引用を抽出する", () => {
    const log = [
      "LaTeX Warning: File `Figures/x.png' not found.",
      "! Unable to load picture or PDF file `vis/y.pdf'.",
      "LaTeX Warning: Reference `fig:foo' on page 4 undefined on input line 216.",
      "LaTeX Warning: Citation `bar2017' undefined on input line 30.",
    ].join("\n");
    const c = classifyLog(log, MAP);
    expect(c.missingFigures.sort()).toEqual(["Figures/x.png", "vis/y.pdf"]);
    expect(c.unresolvedRefs.sort()).toEqual(["bar2017", "fig:foo"]);
  });
});

describe("checkFigures", () => {
  const mainDir = "/src";
  it("本文に残る図は落とさず、消えた図を dropped に挙げる", () => {
    const mainTex = "見よ \\includegraphics{Figures/a} を参照";
    const dropped = checkFigures(mainTex, mainDir, ["/src/Figures/a.png", "/src/Figures/gone.pdf"]);
    expect(dropped).toEqual(["Figures/gone.pdf"]);
  });
});

describe("stageBuild", () => {
  it("main.tex・支援ファイル(.sty/.bib はフラット・再帰)・図(main 相対)を複製する", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "nips.sty"), "% sty");
    writeFileSync(path.join(src, "refs.bib"), "@x{}");
    writeFileSync(path.join(src, "notes.txt"), "ignore");
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "sub", "extra.cls"), "% cls");
    mkdirSync(path.join(src, "Figures"));
    writeFileSync(path.join(src, "Figures", "a.png"), "PNG");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", {
      sourceDir: src,
      mainDir: src,
      figures: [path.join(src, "Figures", "a.png")],
    });
    expect(existsSync(path.join(build, "main.tex"))).toBe(true);
    expect(existsSync(path.join(build, "nips.sty"))).toBe(true);
    expect(existsSync(path.join(build, "refs.bib"))).toBe(true);
    expect(existsSync(path.join(build, "extra.cls"))).toBe(true); // 再帰・フラット
    expect(existsSync(path.join(build, "Figures", "a.png"))).toBe(true);
    expect(readdirSync(build)).not.toContain("notes.txt");
  });
  it("入れ子 main の図は main 相対で配置する（sourceDir 相対にしない）", () => {
    const src = mkTemp();
    const mainDir = path.join(src, "paper");
    mkdirSync(path.join(mainDir, "Figures"), { recursive: true });
    writeFileSync(path.join(mainDir, "Figures", "a.png"), "PNG");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir, figures: [path.join(mainDir, "Figures", "a.png")] });
    expect(existsSync(path.join(build, "Figures", "a.png"))).toBe(true);
    expect(existsSync(path.join(build, "paper", "Figures", "a.png"))).toBe(false);
  });
});

describe("runBuildGate", () => {
  const src = () => {
    const s = mkTemp();
    writeFileSync(path.join(s, "s.sty"), "% x");
    return s;
  };
  it("ビルド成功＋警告なしは buildOk かつ pdfPath", () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "Output written on main.pdf (15 pages)." };
    };
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(true);
    expect(r.pdfPath).toBe(path.join(build, "main.pdf"));
  });
  it("翻訳起因の fatal は buildOk=false かつ failedSegments に載る", () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = () => ({ code: 1, log: "./main.tex:25: Missing $ inserted." });
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.failedSegments[0]!.id).toBe("seg-0001");
  });
  it("欠図（構造起因）は成功終了でも buildOk=false", () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "LaTeX Warning: File `Figures/x.png' not found." };
    };
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.missingFigures).toEqual(["Figures/x.png"]);
  });
});
