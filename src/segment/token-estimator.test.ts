import { describe, it, expect } from "vitest";
import { estimateTokens } from "./token-estimator.js";

describe("estimateTokens", () => {
  it("ASCII は約4文字で1トークン", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("CJK は1文字1トークン", () => {
    expect(estimateTokens("あいう")).toBe(3);
    expect(estimateTokens("日本語")).toBe(3);
    expect(estimateTokens("カタカナ")).toBe(4);
  });

  it("混在は加算", () => {
    expect(estimateTokens("abcd漢字")).toBe(1 + 2);
  });

  it("決定的（同入力同出力）", () => {
    const s = "\\section{Attention} We propose $x=y$.";
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });
});
