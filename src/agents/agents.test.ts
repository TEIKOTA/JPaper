import { describe, it, expect } from "vitest";
import { translate } from "./translator.js";
import { evaluate } from "./evaluator.js";
import { buildGlossary } from "./glossary-builder.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import type { ResolvedTerm } from "../types/contract.js";

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
    // 確定用語は system ではなく user（プロンプトキャッシュ prefix を安定化するため）
    expect(c.calls[0]!.system).not.toContain("attention: 訳語");
    expect(c.calls[0]!.user).toContain("attention: 訳語「アテンション」を使う");
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

  it("初稿は訳出、改稿は前稿の最小差分修正として指示する", async () => {
    const c = new FakeLlmClient('{"segmentId":"s1","ja":"訳"}');
    await translate(c, { segmentId: "s1", latex: "x", glossarySlice: [] });
    expect(c.calls[0]!.user).toContain("本文と図表のキャプション");
    expect(c.calls[0]!.user).toContain("\\caption の中身");
    expect(c.calls[0]!.user).not.toContain("訳し直さない");

    const r = new FakeLlmClient('{"segmentId":"s1","ja":"訳"}');
    await translate(r, {
      segmentId: "s1",
      latex: "x",
      glossarySlice: [],
      priorJa: "前訳",
      issues: ["数式が欠けている"],
    });
    // 「1 文字も変えない」を先に置くとモデルは前稿をそのまま返す（実測: 2 稿目が
    // 1 稿目とバイト単位で一致）。直す義務を先に、残す指示を後に置く。
    expect(r.calls[0]!.user).toContain("指摘された箇所を必ず直す");
    expect(r.calls[0]!.user).toContain("前回の訳を土台にして残し");
    expect(r.calls[0]!.user).toContain("訳し直さない");
    // 形式の指示は改稿でも落とさない（平文フェンスの契約は稿によらない）。
    expect(r.calls[0]!.user).toContain("```tex");
  });

  it("トレース用 meta（role/phase/segmentId/pass）を request に載せる", async () => {
    const c = new FakeLlmClient('{"segmentId":"s1","ja":"訳"}');
    await translate(c, { segmentId: "s1", latex: "x", glossarySlice: [] }, {}, 2);
    expect(c.calls[0]!.meta).toEqual({
      role: "translator",
      phase: "translate",
      segmentId: "s1",
      pass: 2,
    });
  });
});

describe("evaluator", () => {
  it("verdict/issues を返し pitfalls を開示", async () => {
    const c = new FakeLlmClient('{"verdict":"pass","issues":[]}');
    const out = await evaluate(c, { segmentId: "s1", srcLatex: "x", ja: "訳" }, {}, 1);
    expect(out.verdict).toBe("pass");
    expect(c.calls[0]!.system).toContain("有意");
    expect(c.calls[0]!.user).toContain("severity");
    expect(c.calls[0]!.meta).toEqual({
      role: "evaluator",
      phase: "evaluate",
      segmentId: "s1",
      pass: 1,
    });
  });

  it("確定用語は system ではなく user に載る（用語違反検出のため届く・キャッシュ prefix を保つ）", async () => {
    const c = new FakeLlmClient('{"verdict":"pass","issues":[]}');
    const glossary: ResolvedTerm[] = [
      {
        src: "attention",
        form: "アテンション",
        class: "established",
        rendering: "translate",
        firstOccurrence: true,
      },
    ];
    await evaluate(c, { segmentId: "s1", srcLatex: "x", ja: "訳" }, { glossary });
    expect(c.calls[0]!.user).toContain("attention: 訳語「アテンション」を使う");
    expect(c.calls[0]!.system).not.toContain("attention: 訳語");
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
    expect(c.calls[0]!.user).toContain("併記形");
    expect(c.calls[0]!.meta).toEqual({ role: "glossary-builder", phase: "glossary" });
  });
});

// #267: 訳文は JSON 文字列で運ばない（\t 系の綴りが黙って壊れるため）。
describe("translator: 平文で受け取る", () => {
  it("```tex 囲みの中身をそのまま訳文にする", async () => {
    const c = new FakeLlmClient("```tex\n$3\\times3\\times3$ の体積\n```");
    const r = await translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] });
    expect(r).toEqual({ segmentId: "seg-1", ja: "$3\\times3\\times3$ の体積" });
  });

  it("囲みの外に説明があっても中身だけを取る", async () => {
    const c = new FakeLlmClient("承知しました。\n```tex\n訳文\n```\n以上です。");
    const r = await translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] });
    expect(r.ja).toBe("訳文");
  });

  it("言語指定なしのフェンスも受ける", async () => {
    const c = new FakeLlmClient("```\n訳文\n```");
    expect((await translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] })).ja).toBe(
      "訳文",
    );
  });

  it("segmentId はモデルに書かせず、呼び出し側の値を返す", async () => {
    const c = new FakeLlmClient("```tex\n訳文\n```");
    const r = await translate(c, { segmentId: "seg-0042", latex: "x", glossarySlice: [] });
    expect(r.segmentId).toBe("seg-0042");
  });

  it("JSON で返ってきた場合も後方互換で受ける", async () => {
    const c = new FakeLlmClient('{"segmentId":"x","ja":"訳文"}');
    expect((await translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] })).ja).toBe(
      "訳文",
    );
  });

  it("どちらでもなければ再試行して provider エラーにする", async () => {
    const c = new FakeLlmClient("囲みも JSON もありません");
    await expect(
      translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] }),
    ).rejects.toThrow(/契約に合いません/);
  }, 30_000); // 再試行の待ちを含む

  it("指示は平文を求める（JSON を求めない）", async () => {
    const c = new FakeLlmClient("```tex\n訳文\n```");
    await translate(c, { segmentId: "seg-1", latex: "x", glossarySlice: [] });
    expect(c.calls[0]?.user).toContain("```tex と ``` で囲んで返す");
  });
});
