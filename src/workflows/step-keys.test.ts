import { describe, it, expect } from "vitest";
import { planSegments, segmentFirstOccurrence, segmentSlice, translatedLatex } from "./step-keys.js";
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
