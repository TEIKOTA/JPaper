import { describe, it, expect } from "vitest";
import { collectCandidates } from "./collect.js";

describe("collectCandidates", () => {
  it("固定5パターンで候補を集める", () => {
    const latex =
      "\\newcommand{\\mdl}{X}. We define self-attention as a mechanism. " +
      "The \\emph{multi-head} attention uses Byte Pair Encoding.";
    const srcs = collectCandidates(latex).map((c) => c.src);
    expect(srcs).toContain("\\mdl");
    expect(srcs).toContain("self-attention");
    expect(srcs).toContain("multi-head");
    expect(srcs).toContain("Byte Pair Encoding");
  });

  it("we define X は definedInPaper=true", () => {
    const cands = collectCandidates("We define self-attention as X");
    expect(cands.find((c) => c.src === "self-attention")?.definedInPaper).toBe(true);
  });

  it("複合固有名は definedInPaper=false", () => {
    const cands = collectCandidates("uses Byte Pair Encoding here");
    expect(cands.find((c) => c.src === "Byte Pair Encoding")?.definedInPaper).toBe(false);
  });

  it("DB 既知語も候補に含める", () => {
    const srcs = collectCandidates("we use attention", ["attention"]).map((c) => c.src);
    expect(srcs).toContain("attention");
  });

  it("文書順（初出位置）で返す", () => {
    const cands = collectCandidates("\\emph{alpha} then \\emph{beta}");
    expect(cands.map((c) => c.src)).toEqual(["alpha", "beta"]);
  });
});
