import { describe, it, expect } from "vitest";
import {
  ResolvedTerm,
  StyleContract,
  DocumentBrief,
  GlossaryBuilderOut,
  JpaperInput,
  RunSummary,
  TranslatorIn,
  TranslatorOut,
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
    expect(e.issues[0]?.severity).toBe("warn");
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

describe("用語集の上限", () => {
  const term = (over: Record<string, unknown> = {}) => ({
    src: "value",
    form: "値",
    class: "paper-defined",
    rendering: "bilingual",
    ...over,
  });
  const wrap = (resolved: unknown[]) => ({
    resolved,
    brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
    style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
  });

  it("件数の上限を超えたら弾く", () => {
    // 上限が無かった頃は 2 万件を返させて、275 バイトの入力から 1 run で
    // 560 万文字ぶんのプロンプトを吐かせられた（maxLlmCalls は回数しか見ない）。
    expect(() => GlossaryBuilderOut.parse(wrap(Array.from({ length: 501 }, () => term())))).toThrow();
    expect(GlossaryBuilderOut.parse(wrap(Array.from({ length: 500 }, () => term()))).resolved).toHaveLength(500);
  });

  it("空の src を弾く", () => {
    // 用語スライスは seg.latex.includes(src) で選ぶので、空だと全件が全セグメントに乗る。
    expect(() => GlossaryBuilderOut.parse(wrap([term({ src: "" })]))).toThrow();
  });

  it("長すぎる src/form を弾く", () => {
    expect(() => GlossaryBuilderOut.parse(wrap([term({ src: "x".repeat(201) })]))).toThrow();
    expect(() => GlossaryBuilderOut.parse(wrap([term({ form: "x".repeat(201) })]))).toThrow();
  });
});

describe("brief / style の上限", () => {
  const wrap = (brief: unknown, style?: unknown) => ({
    resolved: [],
    brief,
    style: style ?? { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
  });
  const brief = (over: Record<string, unknown> = {}) => ({
    thesis: "t",
    sectionRoles: [],
    notationConventions: [],
    ...over,
  });

  it("brief は全セグメントのプロンプトに載るので件数・長さを縛る", () => {
    expect(() =>
      GlossaryBuilderOut.parse(wrap(brief({ thesis: "x".repeat(2001) }))),
    ).toThrow();
    expect(() =>
      GlossaryBuilderOut.parse(
        wrap(brief({ notationConventions: Array.from({ length: 101 }, () => "x") })),
      ),
    ).toThrow();
    expect(() =>
      GlossaryBuilderOut.parse(
        wrap(brief({ sectionRoles: Array.from({ length: 101 }, () => ({ id: "a", role: "b" })) })),
      ),
    ).toThrow();
  });

  it("style も同じ上限で縛る", () => {
    expect(() =>
      GlossaryBuilderOut.parse(
        wrap(brief(), { tensePolicy: "x".repeat(2001), headingStyle: "b", numberStyle: "c" }),
      ),
    ).toThrow();
  });
});


describe("TranslatorOut: 小さいモデルの形の揺れ", () => {
  it('{"seg-0019": {"ja": "…"}} を畳んで受ける（実測の形）', () => {
    const v = TranslatorOut.parse({ "seg-0019": { ja: "訳文" } });
    expect(v).toEqual({ segmentId: "seg-0019", ja: "訳文" });
  });

  it("正しい形はそのまま通る", () => {
    expect(TranslatorOut.parse({ segmentId: "seg-1", ja: "訳文" })).toEqual({
      segmentId: "seg-1",
      ja: "訳文",
    });
  });

  it("鍵が 2 つ以上あるものは畳まない（曖昧なので落とす）", () => {
    expect(() => TranslatorOut.parse({ a: { ja: "x" }, b: { ja: "y" } })).toThrow();
  });

  it("中身に ja が無ければ畳まない", () => {
    expect(() => TranslatorOut.parse({ "seg-1": { text: "x" } })).toThrow();
  });

  it("配列や null は素通しして落とす", () => {
    expect(() => TranslatorOut.parse([{ ja: "x" }])).toThrow();
    expect(() => TranslatorOut.parse(null)).toThrow();
  });
});
