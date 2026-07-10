import { describe, it, expect } from "vitest";
import {
  renderGlossaryMd,
  parseGlossaryMd,
  renderBriefMd,
  parseBriefMd,
  renderStyleMd,
  parseStyleMd,
} from "./glossary-io.js";
import type { DocumentBrief, StyleContract } from "./../types/contract.js";

describe("glossary.md round-trip", () => {
  it("描画→読み戻しで一致（note 含む）", () => {
    const rows = [
      { src: "attention", form: "アテンション", class: "established", rendering: "translate" },
      {
        src: "value",
        form: "値(Value)",
        class: "paper-defined",
        rendering: "bilingual",
        note: "論文定義",
      },
    ];
    expect(parseGlossaryMd(renderGlossaryMd(rows))).toEqual(rows);
  });

  it("ヘッダ・区切り行は無視する", () => {
    expect(parseGlossaryMd(renderGlossaryMd([]))).toEqual([]);
  });

  it("セル内の | は無害化する", () => {
    const parsed = parseGlossaryMd(
      renderGlossaryMd([{ src: "a|b", form: "x|y", class: "established", rendering: "translate" }]),
    );
    expect(parsed[0]!.src).toBe("a b");
  });
});

describe("brief/style round-trip", () => {
  it("brief.md は round-trip する", () => {
    const b: DocumentBrief = {
      thesis: "自己注意で系列を並列処理する",
      sectionRoles: [{ id: "s1", role: "導入" }],
      notationConventions: ["Q,K,V は行列"],
      claimStrengthNotes: [],
    };
    expect(parseBriefMd(renderBriefMd(b))).toEqual(b);
  });

  it("style.md は round-trip する", () => {
    const s: StyleContract = {
      register: "plain",
      tensePolicy: "結果=過去",
      headingStyle: "体言止め",
      numberStyle: "半角",
      notes: ["常体"],
    };
    expect(parseStyleMd(renderStyleMd(s))).toEqual(s);
  });
});
