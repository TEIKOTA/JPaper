import { describe, it, expect } from "vitest";
import { buildSystemPrompt, renderGlossaryBlock } from "./system-prompt.js";
import type { ResolvedTerm, DocumentBrief, StyleContract } from "../types/contract.js";

const term: ResolvedTerm = {
  src: "attention",
  form: "アテンション",
  class: "established",
  rendering: "translate",
  firstOccurrence: true,
};

describe("buildSystemPrompt", () => {
  it("役割・共通規約を含む（確定用語は system に含めない＝user 側）", () => {
    const p = buildSystemPrompt("translator", {});
    expect(p).toContain("翻訳する専門家");
    expect(p).toContain("構造・数式");
    expect(p).not.toContain("確定用語・表記"); // 用語ブロックは user へ移動
  });

  it("用語スライスに依らず system prompt は同一（キャッシュ prefix を安定化）", () => {
    // per-segment で用語が変わっても system prompt が変わらない＝同一 role のコール間でキャッシュ再利用できる。
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
    expect(buildSystemPrompt("translator", { brief, style })).toBe(
      buildSystemPrompt("translator", { brief, style }),
    );
  });

  it("translator にのみ見出し和訳の指示を出す", () => {
    expect(buildSystemPrompt("translator", {})).toContain("見出しの扱い");
    expect(buildSystemPrompt("evaluator", {})).not.toContain("見出しの扱い");
    expect(buildSystemPrompt("glossary-builder", {})).not.toContain("見出しの扱い");
  });

  it("evaluator にのみ pitfalls を開示する", () => {
    expect(buildSystemPrompt("evaluator", {})).toContain("有意");
    expect(buildSystemPrompt("translator", {})).not.toContain("有意");
    expect(buildSystemPrompt("glossary-builder", {})).not.toContain("有意");
  });

  it("evaluator に verdict/severity の判定基準を明示する（重大問題を warn に格下げしない）", () => {
    const p = buildSystemPrompt("evaluator", {});
    expect(p).toContain("重大な問題を warn に格下げしてはならない");
    expect(p).toContain("verdict=fail");
    expect(buildSystemPrompt("translator", {})).not.toContain("格下げ");
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
    const p = buildSystemPrompt("translator", { brief, style });
    expect(p).toContain("主張の核: 核");
    expect(p).toContain("である調・常体");
  });
});

describe("renderGlossaryBlock（user 側の確定用語ブロック）", () => {
  it("確定用語を含み rendering ごとに行動指示を出す（bilingual 初出/以降・keep-original）", () => {
    expect(renderGlossaryBlock([term])).toContain("attention: 訳語「アテンション」を使う");
    const bi1: ResolvedTerm = {
      src: "value",
      form: "値(Value)",
      class: "paper-defined",
      rendering: "bilingual",
      firstOccurrence: true,
    };
    const bi2: ResolvedTerm = { ...bi1, firstOccurrence: false };
    const keep: ResolvedTerm = {
      src: "BLEU",
      form: "BLEU",
      class: "do-not-translate",
      rendering: "keep-original",
      firstOccurrence: false,
    };
    expect(renderGlossaryBlock([bi1])).toContain("初出なので併記「値(Value)」");
    expect(renderGlossaryBlock([bi2])).toContain("「値」（日本語のみ");
    expect(renderGlossaryBlock([keep])).toContain("原表記「BLEU」のまま残す");
  });

  it("決定的（用語の並び順に依らず同一出力）", () => {
    const t2: ResolvedTerm = { ...term, src: "model", form: "モデル" };
    expect(renderGlossaryBlock([term, t2])).toBe(renderGlossaryBlock([t2, term]));
  });
});
