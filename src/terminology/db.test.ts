import { describe, it, expect } from "vitest";
import { GlossaryDb } from "./db.js";

const base = {
  class: "established",
  rendering: "translate" as const,
};

describe("GlossaryDb", () => {
  it("空スタートで DDL 適用済み", () => {
    const db = new GlossaryDb();
    expect(db.allSrcTerms()).toEqual([]);
    db.close();
  });

  it("writeBackProposed は (src,ja,domain) で dedup", () => {
    const db = new GlossaryDb();
    const e = { src: "attention", ja: "アテンション", domain: "ml", ...base };
    expect(db.writeBackProposed([e])).toBe(1);
    expect(db.writeBackProposed([e])).toBe(0);
    expect(db.writeBackProposed([{ ...e, ja: "注意" }])).toBe(1);
    expect(db.writeBackProposed([{ ...e, domain: "nlp" }])).toBe(1);
    db.close();
  });

  it("confirmedFor は confirmed のみ・promote で昇格", () => {
    const db = new GlossaryDb();
    db.writeBackProposed([{ src: "x", ja: "エックス", ...base }]);
    expect(db.confirmedFor("x")).toEqual([]);
    expect(db.promote("x", "エックス", null)).toBe(1);
    expect(db.confirmedFor("x").map((e) => e.ja)).toEqual(["エックス"]);
    db.close();
  });

  it("matchKnownTerms は最長一致優先", () => {
    const db = new GlossaryDb();
    db.writeBackProposed([
      { src: "attention", ja: null, ...base },
      { src: "self-attention", ja: null, ...base },
    ]);
    const m = db.matchKnownTerms("we use self-attention here");
    expect(m[0]).toBe("self-attention");
    expect(m).toContain("attention");
    db.close();
  });

  it("aliases は JSON で往復", () => {
    const db = new GlossaryDb();
    db.writeBackProposed([
      { src: "T", ja: "変換器", aliases: ["Transformer", "xf"], ...base },
    ]);
    expect(db.allFor("T")[0]!.aliases).toEqual(["Transformer", "xf"]);
    db.close();
  });
});
