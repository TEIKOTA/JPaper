import { describe, it, expect } from "vitest";
import { formalCheck } from "./quality-gate.js";
import type { ResolvedTerm } from "../types/contract.js";

const kinds = (src: string, ja: string, terms: ResolvedTerm[] = []) =>
  formalCheck(src, ja, terms).map((i) => i.kind);

describe("formalCheck: 数式", () => {
  it("個数一致は pass、欠落は math issue", () => {
    expect(formalCheck("$x$ and $y$", "$x$ と $y$", [])).toEqual([]);
    expect(kinds("$x$ and $y$", "$x$ のみ")).toContain("math");
  });
  it("\\[ \\] や align 環境も数える", () => {
    expect(formalCheck("\\[a\\] \\begin{align}b\\end{align}", "\\[a\\] \\begin{align}b\\end{align}", [])).toEqual([]);
    expect(kinds("\\begin{align}b\\end{align}", "訳のみ")).toContain("math");
  });
});

describe("formalCheck: 段落", () => {
  it("水増し（訳>原）を検出", () => {
    expect(kinds("a", "訳a\n\n余分")).toContain("paragraph");
  });
  it("欠落（原の50%未満）を検出", () => {
    expect(kinds("a\n\nb\n\nc\n\nd", "one")).toContain("paragraph");
  });
  it("訳≦原かつ50%以上は pass", () => {
    expect(formalCheck("a\n\nb", "訳ab", [])).toEqual([]);
  });
});

describe("formalCheck: keep-original", () => {
  const t: ResolvedTerm = {
    src: "BLEU",
    form: "BLEU",
    class: "do-not-translate",
    rendering: "keep-original",
    firstOccurrence: true,
  };
  it("原形保持は pass、消失は issue", () => {
    expect(formalCheck("BLEU score", "BLEU スコア", [t])).toEqual([]);
    expect(kinds("BLEU score", "スコア", [t])).toContain("keep-original");
  });
});

describe("formalCheck: bilingual", () => {
  const first: ResolvedTerm = {
    src: "value",
    form: "値(Value)",
    class: "paper-defined",
    rendering: "bilingual",
    firstOccurrence: true,
  };
  const later: ResolvedTerm = { ...first, firstOccurrence: false };

  it("初出は併記形が必要", () => {
    expect(formalCheck("value", "値(Value) を使う", [first])).toEqual([]);
    expect(kinds("value", "値 を使う", [first])).toContain("bilingual");
  });
  it("2回目以降は日本語のみ（併記形はNG）", () => {
    expect(formalCheck("value", "値 を使う", [later])).toEqual([]);
    expect(kinds("value", "値(Value) を使う", [later])).toContain("bilingual");
  });

  it("併記形を持たない form（日本語のみ）は 2回目以降でも誤検知しない", () => {
    const plain: ResolvedTerm = {
      src: "x",
      form: "用語",
      class: "paper-defined",
      rendering: "bilingual",
      firstOccurrence: false,
    };
    expect(formalCheck("x", "用語を繰り返し用語と使う", [plain])).toEqual([]);
  });
});
