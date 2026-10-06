import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("matchKnownTerms は confirmed のみを最長一致優先で返す", () => {
    const db = new GlossaryDb();
    db.writeBackProposed([
      { src: "attention", ja: null, ...base },
      { src: "self-attention", ja: null, ...base },
    ]);
    // proposed のうちは他論文の処理に影響しない。
    expect(db.matchKnownTerms("we use self-attention here")).toEqual([]);
    db.promote("attention", null, null);
    db.promote("self-attention", null, null);
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

describe("複数プロセス/複数接続での競合", () => {
  const tmpDb = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-db-race-"));
    dbDirs.push(d);
    return path.join(d, "glossary.db");
  };
  const dbDirs: string[] = [];
  afterEach(() => {
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const term = (src: string) => ({ src, ja: "訳", class: "term", rendering: "translate" });

  it("同じファイルへの別接続が開けて、双方の書き込みが残る", () => {
    const loc = tmpDb();
    const a = new GlossaryDb(loc);
    // 修正前は、a が DDL の書き込みトランザクションを持つ間に b を開くと即 locked だった。
    const b = new GlossaryDb(loc);
    expect(a.writeBackProposed([term("alpha")])).toBe(1);
    expect(b.writeBackProposed([term("bravo")])).toBe(1);
    const c = new GlossaryDb(loc);
    expect(c.allSrcTerms().sort()).toEqual(["alpha", "bravo"]);
    a.close();
    b.close();
    c.close();
  });

  it("永続 DB は WAL になる（読み手と書き手を並行させる）", () => {
    const loc = tmpDb();
    const db = new GlossaryDb(loc);
    expect(existsSync(`${loc}-wal`) || existsSync(loc)).toBe(true);
    db.writeBackProposed([term("alpha")]);
    expect(existsSync(`${loc}-wal`)).toBe(true);
    db.close();
  });

  it("dedup はトランザクションの中でも効く", () => {
    const loc = tmpDb();
    const db = new GlossaryDb(loc);
    expect(db.writeBackProposed([term("alpha"), term("alpha")])).toBe(1);
    expect(db.writeBackProposed([term("alpha")])).toBe(0);
    expect(db.allSrcTerms()).toEqual(["alpha"]);
    db.close();
  });
});
