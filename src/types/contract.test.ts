import { describe, it, expect } from "vitest";
import {
  ResolvedTerm,
  StyleContract,
  DocumentBrief,
  GlossaryBuilderOut,
  JpaperInput,
  RunSummary,
  TranslatorIn,
  EvaluatorOut,
  Provider,
} from "./contract.js";

describe("contract zod schemas", () => {
  it("ResolvedTerm: 妥当な値を round-trip する", () => {
    const t = {
      src: "attention",
      form: "アテンション",
      class: "established" as const,
      rendering: "translate" as const,
      firstOccurrence: true,
    };
    expect(ResolvedTerm.parse(t)).toMatchObject(t);
  });

  it("ResolvedTerm: 不正な class を拒否する", () => {
    expect(() =>
      ResolvedTerm.parse({
        src: "x",
        form: "y",
        class: "bogus",
        rendering: "translate",
        firstOccurrence: false,
      }),
    ).toThrow();
  });

  it("StyleContract: register 既定は plain（である調・常体）", () => {
    const s = StyleContract.parse({
      tensePolicy: "結果=過去",
      headingStyle: "節見出しは体言止め",
      numberStyle: "半角",
    });
    expect(s.register).toBe("plain");
    expect(s.notes).toEqual([]);
  });

  it("DocumentBrief: claimStrengthNotes 既定は空配列", () => {
    const b = DocumentBrief.parse({
      thesis: "核",
      sectionRoles: [{ id: "s1", role: "導入" }],
      notationConventions: ["x は変数"],
    });
    expect(b.claimStrengthNotes).toEqual([]);
  });

  it("GlossaryBuilderOut: resolved は firstOccurrence を持たない", () => {
    const out = GlossaryBuilderOut.parse({
      resolved: [
        {
          src: "value",
          form: "値(Value)",
          class: "paper-defined",
          rendering: "bilingual",
        },
      ],
      brief: {
        thesis: "t",
        sectionRoles: [],
        notationConventions: [],
      },
      style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
    });
    expect(out.resolved[0]).not.toHaveProperty("firstOccurrence");
    expect(out.style.register).toBe("plain");
  });

  it("JpaperInput: path / arxiv の discriminated union", () => {
    expect(JpaperInput.parse({ kind: "path", path: "/a/b" })).toEqual({
      kind: "path",
      path: "/a/b",
    });
    expect(JpaperInput.parse({ kind: "arxiv", id: "1505.04597" })).toEqual({
      kind: "arxiv",
      id: "1505.04597",
    });
    expect(() => JpaperInput.parse({ kind: "url", url: "x" })).toThrow();
  });

  it("Provider: ollama|claude のみ受理", () => {
    expect(Provider.parse("ollama")).toBe("ollama");
    expect(Provider.parse("claude")).toBe("claude");
    expect(() => Provider.parse("openai")).toThrow();
  });

  it("TranslatorIn: priorJa/issues は任意（初回は無し）", () => {
    const parsed = TranslatorIn.parse({
      segmentId: "s1",
      latex: "\\section{x}",
      glossarySlice: [],
    });
    expect(parsed.priorJa).toBeUndefined();
  });

  it("EvaluatorOut: verdict と issues", () => {
    const e = EvaluatorOut.parse({
      verdict: "revise",
      issues: [{ severity: "warn", message: "hedging を弱めない" }],
    });
    expect(e.verdict).toBe("revise");
    expect(e.issues[0].severity).toBe("warn");
  });

  it("RunSummary: (A) 単体では buildOk/layout は null 可", () => {
    const s = RunSummary.parse({
      paperId: "p",
      outDir: "/out",
      segments: { total: 3, passed: 3, failed: 0 },
      revisions: { max: 4, used: 1 },
      glossary: { proposedAdded: 2 },
      notes: { total: 1, byTrigger: { "paper-defined-preserve": 1 } },
      layout: null,
      buildOk: null,
      exitCode: 0,
    });
    expect(s.buildOk).toBeNull();
    expect(s.layout).toBeNull();
  });
});
