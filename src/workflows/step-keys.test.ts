import { describe, it, expect } from "vitest";
import { segmentFirstOccurrence, segmentSlice, translatedLatex } from "./step-keys.js";
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
