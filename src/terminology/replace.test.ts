import { describe, it, expect } from "vitest";
import {
  rewriteMdBody,
  editedForm,
  findOccurrences,
  isEditable,
  replaceOccurrences,
  rewriteGlossaryMd,
  rewriteStrings,
  rewriteText,
  sameJaTerms,
  shieldsFor,
  termJa,
  validateTermJa,
  type TermRewrite,
} from "./replace.js";
import { parseBriefMd, parseGlossaryMd, parseStyleMd, renderBriefMd, renderGlossaryMd, renderStyleMd, type ResolvedRow } from "./glossary-io.js";

const rows: ResolvedRow[] = [
  { src: "Rashomon set", form: "ラショモン集合(Rashomon set)", class: "established", rendering: "bilingual", note: "以降は「ラショモン集合」" },
  { src: "empirical Rashomon set", form: "経験的ラショモン集合", class: "paper-defined", rendering: "translate", note: "以降単に「ラショモン集合」と呼ぶ" },
  { src: "Rashomon ratio", form: "ラショモン比", class: "established", rendering: "translate" },
  { src: "CMA-ES", form: "CMA-ES", class: "do-not-translate", rendering: "keep-original" },
];

const rw = (): TermRewrite => ({
  oldJa: "ラショモン集合",
  newJa: "羅生門集合",
  shields: shieldsFor(rows, "Rashomon set", "ラショモン集合"),
});

describe("訳語（契約付録 §9）", () => {
  it("bilingual は併記形の日本語部分、translate は form、keep-original は訳語を持たない", () => {
    expect(termJa(rows[0]!)).toBe("ラショモン集合");
    expect(termJa(rows[2]!)).toBe("ラショモン比");
    expect(termJa(rows[3]!)).toBeUndefined();
    expect(isEditable(rows[3]!)).toBe(false);
    expect(isEditable(rows[0]!)).toBe(true);
  });

  it("bilingual の新しい form は原語を src の綴りで併記する（入力の原語の綴りは採らない）", () => {
    expect(editedForm(rows[0]!, "羅生門集合")).toEqual({ form: "羅生門集合(Rashomon set)", ja: "羅生門集合" });
    expect(editedForm(rows[0]!, " 羅生門集合(rashomon SET) ")).toEqual({
      form: "羅生門集合(Rashomon set)",
      ja: "羅生門集合",
    });
    expect(editedForm(rows[2]!, "羅生門比")).toEqual({ form: "羅生門比", ja: "羅生門比" });
  });

  it("空・表の区切り・組版で意味を持つ文字を拒む", () => {
    expect(validateTermJa("  ")).toBeDefined();
    expect(validateTermJa("a|b")).toBeDefined();
    expect(validateTermJa("集合\\textbf")).toBeDefined();
    expect(validateTermJa("50%")).toBeDefined();
    expect(validateTermJa("羅生門集合")).toBeUndefined();
  });
});

describe("置換", () => {
  it("併記形の初出と以降の訳だけの形の両方を置き換える", () => {
    const text = "ラショモン集合(Rashomon set)は大きい。再びラショモン集合。";
    expect(rewriteText(text, rw())).toBe("羅生門集合(Rashomon set)は大きい。再び羅生門集合。");
  });

  it("ほかの語の訳語に含まれる出現は印を付けて置換しない", () => {
    const text = "経験的ラショモン集合とラショモン集合。";
    const occs = findOccurrences(text, "ラショモン集合", rw().shields);
    expect(occs).toEqual([
      { start: 3, end: 10, shieldedBy: "empirical Rashomon set" },
      { start: 11, end: 18 },
    ]);
    expect(replaceOccurrences(text, occs, "羅生門集合")).toBe("経験的ラショモン集合と羅生門集合。");
  });

  it("同じ訳語を持つほかの語を挙げる", () => {
    const dup = [...rows, { src: "Rashomon sets", form: "ラショモン集合", class: "established", rendering: "translate" }];
    expect(sameJaTerms(dup, "Rashomon set", "ラショモン集合")).toEqual(["Rashomon sets"]);
  });

  it("値の中の文字列をすべて書き換え、キーは書き換えない", () => {
    const v = { ラショモン集合: ["ラショモン集合の大きさ", { message: "経験的ラショモン集合" }], n: 1 };
    expect(rewriteStrings(v, rw())).toEqual({
      ラショモン集合: ["羅生門集合の大きさ", { message: "経験的ラショモン集合" }],
      n: 1,
    });
  });
});

describe("glossary.md の書き換え", () => {
  it("対象の行の form を差し替え、全行の訳注を書き換え、他の行の form と表の外は触らない", () => {
    const md = renderGlossaryMd(rows);
    const out = rewriteGlossaryMd(md, "Rashomon set", "羅生門集合(Rashomon set)", rw());
    const parsed = parseGlossaryMd(out);
    expect(parsed[0]).toEqual({ ...rows[0], form: "羅生門集合(Rashomon set)", note: "以降は「羅生門集合」" });
    expect(parsed[1]).toEqual({ ...rows[1], note: "以降単に「羅生門集合」と呼ぶ" });
    expect(parsed[2]).toEqual(rows[2]);
    expect(parsed[3]).toEqual(rows[3]);
    expect(out.split("\n").slice(0, 6)).toEqual(md.split("\n").slice(0, 6));
  });

  it("対象の行が無ければ投げる", () => {
    expect(() => rewriteGlossaryMd(renderGlossaryMd(rows), "nope", "x", rw())).toThrow();
  });
});

describe("brief.md・style.md の書き換え", () => {
  it("見出しと「- キー:」のキーは書き換えず、本文だけを置換する", () => {
    const brief = renderBriefMd({
      thesis: "主張は単純である",
      sectionRoles: [{ id: "序論", role: "主張を述べる" }],
      notationConventions: [],
      claimStrengthNotes: ["主張を弱める"],
    });
    const style = renderStyleMd({ register: "plain", tensePolicy: "現在形", headingStyle: "体言止め", numberStyle: "単位は SI", notes: [] });
    const toClaim = { oldJa: "主張", newJa: "クレーム", shields: [] };
    const toUnit = { oldJa: "単位", newJa: "ユニット", shields: [] };
    const b = parseBriefMd(rewriteMdBody(brief, toClaim, false));
    expect(b.thesis).toBe("クレームは単純である");
    expect(b.sectionRoles).toEqual([{ id: "序論", role: "クレームを述べる" }]);
    expect(b.claimStrengthNotes).toEqual(["クレームを弱める"]);
    expect(parseStyleMd(rewriteMdBody(style, toUnit, true)).numberStyle).toBe("ユニットは SI");
  });
});
