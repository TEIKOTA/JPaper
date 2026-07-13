import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyLog, stageBuild, runBuildGate } from "./build-gate.js";
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

describe("stageBuild", () => {
  it("main.tex・.sty・図（相対パス保持）を複製する", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "nips.sty"), "% sty");
    writeFileSync(path.join(src, "notes.txt"), "ignore");
    mkdirSync(path.join(src, "Figures"));
    writeFileSync(path.join(src, "Figures", "a.png"), "PNG");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", src, [path.join(src, "Figures", "a.png")]);
    expect(existsSync(path.join(build, "main.tex"))).toBe(true);
    expect(existsSync(path.join(build, "nips.sty"))).toBe(true);
    expect(existsSync(path.join(build, "Figures", "a.png"))).toBe(true);
    expect(readdirSync(build)).not.toContain("notes.txt");
  });
});

describe("runBuildGate", () => {
  const src = () => {
    const s = mkTemp();
    writeFileSync(path.join(s, "s.sty"), "% x");
    return s;
  };
  it("ビルド成功＋警告なしは buildOk かつ pdfPath", () => {
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "Output written on main.pdf (15 pages)." };
    };
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: src(), figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(true);
    expect(r.pdfPath).toBe(path.join(build, "main.pdf"));
  });
  it("翻訳起因の fatal は buildOk=false かつ failedSegments に載る", () => {
    const build = path.join(mkTemp(), "b");
    const runner = () => ({ code: 1, log: "./main.tex:25: Missing $ inserted." });
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: src(), figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.failedSegments[0]!.id).toBe("seg-0001");
  });
  it("欠図（構造起因）は成功終了でも buildOk=false", () => {
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "LaTeX Warning: File `Figures/x.png' not found." };
    };
    const r = runBuildGate({ buildDir: build, mainTex: "M", sourceDir: src(), figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.missingFigures).toEqual(["Figures/x.png"]);
  });
});
