import { describe, expect, it } from "vitest";
import { termOccurrences, uncoveredTerms, withoutPluralVariants } from "./term-coverage.js";

describe("uncoveredTerms", () => {
  it("より長い語の中にしか出ない語は外す", () => {
    const terms = [{ src: "Deep Ensemble" }, { src: "Deep Ensembles" }];
    expect(uncoveredTerms("We use Deep Ensembles here.", terms).map((t) => t.src)).toEqual(["Deep Ensembles"]);
  });
  it("単独の出現が 1 か所でもあれば残す", () => {
    const terms = [{ src: "crc" }, { src: "crc-rumc" }];
    expect(uncoveredTerms("crc-rumc and crc", terms).map((t) => t.src)).toEqual(["crc", "crc-rumc"]);
  });
  it("出現しない語は返さない", () => {
    expect(uncoveredTerms("abc", [{ src: "x" }])).toEqual([]);
  });
});

describe("termOccurrences", () => {
  it("語の一部には当たらない", () => {
    expect(termOccurrences("lymphocytes and lymph", "lymph")).toEqual([16]);
  });
  it("複数形は同じ語として数える", () => {
    expect(termOccurrences("GPUs, GPU, GPUes", "GPU")).toEqual([0, 6, 11]);
  });
  it("記号端の語は境界を見ない", () => {
    expect(termOccurrences("a$\\alpha$b", "$\\alpha$")).toEqual([1]);
  });
});

describe("withoutPluralVariants", () => {
  it("同じ扱いの複数形の語を除く", () => {
    const terms = [
      { src: "Deep Ensemble", rendering: "bilingual" },
      { src: "Deep Ensembles", rendering: "bilingual" },
      { src: "Class", rendering: "translate" },
      { src: "Classes", rendering: "keep-original" },
    ];
    expect(withoutPluralVariants(terms).map((t) => t.src)).toEqual(["Deep Ensemble", "Class", "Classes"]);
  });
});
