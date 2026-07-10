import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ResolvedTerm, DocumentBrief, StyleContract } from "../types/contract.js";

const term: ResolvedTerm = {
  src: "attention",
  form: "アテンション",
  class: "established",
  rendering: "translate",
  firstOccurrence: true,
};

describe("buildSystemPrompt", () => {
  it("役割・共通規約・確定用語を含む", () => {
    const p = buildSystemPrompt("translator", { glossary: [term] });
    expect(p).toContain("翻訳する専門家");
    expect(p).toContain("構造・数式");
    expect(p).toContain("attention → アテンション");
  });

  it("evaluator にのみ pitfalls を開示する", () => {
    expect(buildSystemPrompt("evaluator", { glossary: [] })).toContain("有意");
    expect(buildSystemPrompt("translator", { glossary: [] })).not.toContain("有意");
    expect(buildSystemPrompt("glossary-builder", { glossary: [] })).not.toContain("有意");
  });

  it("brief/style を注入する", () => {
    const brief: DocumentBrief = {
      thesis: "核",
      sectionRoles: [{ id: "s1", role: "導入" }],
      notationConventions: ["x は変数"],
      claimStrengthNotes: [],
    };
    const style: StyleContract = {
      register: "plain",
      tensePolicy: "結果=過去",
      headingStyle: "体言止め",
      numberStyle: "半角",
      notes: [],
    };
    const p = buildSystemPrompt("translator", { glossary: [], brief, style });
    expect(p).toContain("主張の核: 核");
    expect(p).toContain("である調・常体");
  });

  it("決定的（用語の並び順に依らず同一出力）", () => {
    const t2: ResolvedTerm = { ...term, src: "model", form: "モデル" };
    expect(buildSystemPrompt("translator", { glossary: [term, t2] })).toBe(
      buildSystemPrompt("translator", { glossary: [t2, term] }),
    );
  });
});
