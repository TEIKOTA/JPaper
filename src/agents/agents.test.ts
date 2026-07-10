import { describe, it, expect } from "vitest";
import { translate } from "./translator.js";
import { evaluate } from "./evaluator.js";
import { buildGlossary } from "./glossary-builder.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

describe("translator", () => {
  it("本文を訳して TranslatorOut を返す", async () => {
    const c = new FakeLlmClient('{"segmentId":"s1","ja":"アテンションは…"}');
    const out = await translate(c, {
      segmentId: "s1",
      latex: "\\section{x} attention",
      glossarySlice: [
        {
          src: "attention",
          form: "アテンション",
          class: "established",
          rendering: "translate",
          firstOccurrence: true,
        },
      ],
    });
    expect(out).toEqual({ segmentId: "s1", ja: "アテンションは…" });
    expect(c.calls[0]!.system).toContain("翻訳する専門家");
    expect(c.calls[0]!.system).toContain("attention: 訳語「アテンション」を使う");
    expect(c.calls[0]!.user).toContain("\\section{x}");
  });

  it("再訳時は priorJa/issues を user に載せる", async () => {
    const c = new FakeLlmClient('{"segmentId":"s1","ja":"改稿"}');
    await translate(c, {
      segmentId: "s1",
      latex: "x",
      glossarySlice: [],
      priorJa: "前訳",
      issues: ["hedging を保持"],
    });
    expect(c.calls[0]!.user).toContain("前訳");
    expect(c.calls[0]!.user).toContain("hedging を保持");
  });
});

describe("evaluator", () => {
  it("verdict/issues を返し pitfalls を開示", async () => {
    const c = new FakeLlmClient('{"verdict":"pass","issues":[]}');
    const out = await evaluate(c, { segmentId: "s1", srcLatex: "x", ja: "訳" });
    expect(out.verdict).toBe("pass");
    expect(c.calls[0]!.system).toContain("有意");
    expect(c.calls[0]!.user).toContain("severity");
  });
});

describe("glossary-builder", () => {
  it("resolved/brief/style を返す（firstOccurrence 無し・style 既定 plain）", async () => {
    const resp = JSON.stringify({
      resolved: [
        { src: "v", form: "値(Value)", class: "paper-defined", rendering: "bilingual" },
      ],
      brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
      style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
    });
    const c = new FakeLlmClient(resp);
    const out = await buildGlossary(c, {
      paperId: "p",
      candidates: [{ src: "v", globalCandidates: [{ ja: "値" }], definedInPaper: true }],
    });
    expect(out.resolved[0]!.form).toBe("値(Value)");
    expect(out.style.register).toBe("plain");
    expect(c.calls[0]!.user).toContain("v [論文内定義]");
    expect(c.calls[0]!.user).toContain("rendering");
  });
});
