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

describe("glossary.md の検証の欄（契約付録 §4・issue #309）", () => {
  it("checks を渡すと検証の欄を足し、読み戻しは先頭 5 欄だけを使う", async () => {
    const { renderGlossaryMd: render, parseGlossaryMd: parse } = await import("./glossary-io.js");
    const rows = [
      { src: "Widget set", form: "部品集合", class: "established", rendering: "translate" },
      { src: "Gizmo", form: "ギズモ", class: "established", rendering: "translate", note: "説明" },
      { src: "Plain", form: "平易", class: "proper-noun", rendering: "translate" },
    ];
    const md = render(rows, [
      { src: "Widget set", status: "replaced", form: "部品集合", original: "ウィジェット|集合", sources: ["https://a.jp/x", "https://b.jp/y"] },
      { src: "Gizmo", status: "unverified", form: "ギズモ", sources: [] },
    ]);
    expect(md).toContain("| 原語 | 確定訳/表記 | 分類 | 表記方針 | 訳注 | 検証 |");
    expect(md).toContain("| Widget set | 部品集合 | established | translate |  | 用例に合わせた（元の訳: ウィジェット 集合） 出典: https://a.jp/x https://b.jp/y |");
    expect(md).toContain("| Plain | 平易 | proper-noun | translate |  |  |");
    expect(parse(md)).toEqual(rows);
    expect(render(rows)).not.toContain("検証");
  });

  it("ほかの語の差し替えに揃えた未確認の語は、未確認の理由に揃えたことと元の訳を続ける", () => {
    const md = renderGlossaryMd(
      [{ src: "Widget set ratio", form: "部品集合比", class: "established", rendering: "translate" }],
      [{ src: "Widget set ratio", status: "unverified", form: "部品集合比", reason: "few-sites", original: "ウィジェット集合比", via: "Widget set", sources: [] }],
    );
    expect(md).toContain(
      "| Widget set ratio | 部品集合比 | established | translate |  | 未確認（差し替えに足りる用例が無い）。Widget set の訳に揃えた（元の訳: ウィジェット集合比） |",
    );
  });
});
