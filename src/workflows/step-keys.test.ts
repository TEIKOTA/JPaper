import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planSegments, rebaseIngest, segmentFirstOccurrence, segmentSlice, translatedLatex } from "./step-keys.js";
import type { ResolvedRow } from "../terminology/glossary-io.js";

const flat: ResolvedRow = { src: "flat ensemble", form: "フラットなアンサンブル(flat ensemble)", class: "concept", rendering: "bilingual" };
const title = "\\title{Improving flat ensembles}";
const seg0 = {
  id: "seg-0000",
  latex: `${title}\n\\author{Flat Ensemble Lab}\n\\maketitle\nWe study sharpness.`,
  keep: { start: 0, end: title.length },
};
const seg1 = { id: "seg-0001", latex: "A flat ensemble is robust." };

describe("訳す本文で用語を数える（契約付録 §1・§3）", () => {
  it("keep の \\title と \\author 命令を除く", () => {
    expect(translatedLatex(seg0)).toBe(" \n \n\\maketitle\nWe study sharpness.");
  });

  it("伏せた区間にだけ出る用語はその節のスライスに入れず、初出は次に本文へ出る節にする", () => {
    const firstOcc = segmentFirstOccurrence([seg0, seg1], [flat]);
    expect(firstOcc.get("flat ensemble")).toBe("seg-0001");
    expect(segmentSlice(seg0, [flat], firstOcc)).toEqual([]);
    expect(segmentSlice(seg1, [flat], firstOcc)).toMatchObject([{ src: "flat ensemble", firstOccurrence: true }]);
  });
});

describe("planSegments は前付けの型で keep と frozen を決める（契約付録 §3・§8）", () => {
  it("ICML: \\icmltitle を keep、著者一覧と所属を frozen にし、訳す本文から除く", () => {
    const body = [
      "\\twocolumn[",
      "\\icmltitle{Flat Ensembles}",
      "\\begin{icmlauthorlist}\\icmlauthor{Ann}{tor}\\end{icmlauthorlist}",
      "\\icmlaffiliation{tor}{Flat Ensemble Lab}",
      "]",
      "We study sharpness.",
    ].join("\n");
    const tex = `\\documentclass{article}\n\\usepackage{icml2023}\n\\begin{document}\n${body}\n\\end{document}\n`;
    const plan = planSegments(tex, 8000);
    const s = plan.segments.find((x) => x.keep !== undefined)!;
    expect(s.latex.slice(s.keep!.start, s.keep!.end)).toBe("\\icmltitle{Flat Ensembles}");
    expect(s.frozen!.map(([a, b]) => s.latex.slice(a, b))).toEqual([
      "\\begin{icmlauthorlist}\\icmlauthor{Ann}{tor}\\end{icmlauthorlist}",
      "\\icmlaffiliation{tor}{Flat Ensemble Lab}",
    ]);
    expect(translatedLatex(s)).not.toContain("Flat Ensemble");
    expect(translatedLatex(s)).toContain("We study sharpness.");
  });

  it("keep（本文の \\title）の中の注記は frozen に入れない", () => {
    const tex = "\\documentclass{article}\n\\begin{document}\n\\title{Flat\\thanks{Lab}}\n\\author{Ann}\n\\maketitle\nText\n\\end{document}\n";
    const s = planSegments(tex, 8000).segments.find((x) => x.keep !== undefined)!;
    expect(s.frozen!.map(([a, b]) => s.latex.slice(a, b))).toEqual(["\\author{Ann}"]);
  });
});

describe("rebaseIngest は取り込みの checkpoint のパスを今の出力先へ付け替える（契約付録 §8・issue #447）", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jpaper-rebase-"));
    roots.push(root);
    const oldRun = path.join(root, "old", ".run");
    const newRun = path.join(root, "new", ".run");
    mkdirSync(path.join(newRun, "source", "paper"), { recursive: true });
    mkdirSync(path.join(newRun, "pdf-source"), { recursive: true });
    return { root, oldRun, newRun };
  };
  const cache = (sourceDir: string, mainDir: string, figures: string[]) => ({
    cleanLatex: "",
    paperId: "p",
    unresolvedInputs: 0,
    redacted: 0,
    sourceDir,
    mainDir,
    figures,
  });

  it("旧い出力先の .run/source 配下を今の .run/source 配下へ移す", () => {
    const { oldRun, newRun } = setup();
    const c = cache(path.join(oldRun, "source"), path.join(oldRun, "source", "paper"), [
      path.join(oldRun, "source", "paper", "fig.png"),
    ]);
    expect(rebaseIngest(c, newRun)).toEqual({
      ...c,
      sourceDir: path.join(newRun, "source"),
      mainDir: path.join(newRun, "source", "paper"),
      figures: [path.join(newRun, "source", "paper", "fig.png")],
    });
  });

  it("PDF 入力の .run/pdf-source も移す", () => {
    const { oldRun, newRun } = setup();
    const c = cache(path.join(oldRun, "pdf-source"), path.join(oldRun, "pdf-source"), []);
    expect(rebaseIngest(c, newRun).sourceDir).toBe(path.join(newRun, "pdf-source"));
  });

  it("今の出力先を指す checkpoint はそのまま返す", () => {
    const { newRun } = setup();
    const c = cache(path.join(newRun, "source"), path.join(newRun, "source"), []);
    expect(rebaseIngest(c, newRun)).toBe(c);
  });

  it("出力先の外（ディレクトリ入力）を指すパスは付け替えない", () => {
    const { root, newRun } = setup();
    const c = cache(path.join(root, "input"), path.join(root, "input"), [path.join(root, "input", "a.png")]);
    expect(rebaseIngest(c, newRun)).toBe(c);
  });

  it("移した先に .run/source が無ければ付け替えない", () => {
    const { root, oldRun } = setup();
    const c = cache(path.join(oldRun, "source"), path.join(oldRun, "source"), []);
    expect(rebaseIngest(c, path.join(root, "empty", ".run"))).toBe(c);
  });

  it("旧い .run/source の外へ出る図は付け替えず、付け替えた先は今の .run/source の外を指さない", () => {
    const { root, oldRun, newRun } = setup();
    const outside = path.join(oldRun, "source", "..", "..", "secret.png");
    const c = cache(path.join(oldRun, "source"), path.join(root, "elsewhere"), [
      outside,
      path.join(root, "etc", "passwd"),
    ]);
    const r = rebaseIngest(c, newRun);
    expect(r.sourceDir).toBe(path.join(newRun, "source"));
    expect(r.mainDir).toBe(path.join(root, "elsewhere"));
    expect(r.figures).toEqual(c.figures);
    for (const p of [r.sourceDir, ...r.figures.filter((f) => f.startsWith(newRun))]) {
      expect(path.relative(path.join(newRun, "source"), p).startsWith("..")).toBe(false);
    }
  });
});
