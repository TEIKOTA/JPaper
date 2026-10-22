import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findUnbudgetedComparisons } from "./budget-rule.js";

const repo = path.resolve(import.meta.dirname, "../..");
// fastestMs 自体の挙動（待ちは数えない等）を見る検査で、予算ではない値と比べる。
const EXEMPT = new Set(["src/testing/timing.test.ts"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "output", ".run"]);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(?:ts|tsx|mts|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const lines = (src: string) => findUnbudgetedComparisons(src).map((v) => v.line);

describe("fastestMs の閾値は budgetMs を通す（#484）", () => {
  it("リポジトリのテストに、budgetMs を通さない fastestMs の比較が無い", () => {
    const bad: string[] = [];
    for (const f of testFiles(repo)) {
      const rel = path.relative(repo, f).split(path.sep).join("/");
      if (EXEMPT.has(rel)) continue;
      for (const v of findUnbudgetedComparisons(readFileSync(f, "utf8"))) bad.push(`${rel}:${v.line} ${v.reason}`);
    }
    expect(bad).toEqual([]);
  });

  it("生の数値の閾値を拒む（直接・変数経由・複数行）", () => {
    expect(lines("expect(fastestMs(2, () => f())).toBeLessThan(2000);")).toEqual([1]);
    expect(lines("expect(fastestMs(2, () => f())).toBeLessThanOrEqual(2000);")).toEqual([1]);
    expect(lines("expect(fastestMs(2, () => f())).not.toBeLessThan(5);")).toEqual([1]);
    expect(lines("const ms = fastestMs(2, () => f());\nexpect(ms).toBeLessThan(1500);")).toEqual([2]);
    expect(lines("const ms = fastestMs(2, () => f());\nexpect(ms < 1500).toBe(true);")).toEqual([2]);
    expect(lines("expect(\n  fastestMs(3, () => {\n    g(`${h(')')}`);\n  }),\n).toBeLessThan(900);")).toEqual([2]);
  });

  it("budgetMs を通した閾値と、下限の比較は通す", () => {
    expect(lines("expect(fastestMs(2, () => f())).toBeLessThan(budgetMs(2000));")).toEqual([]);
    expect(lines("const ms = fastestMs(2, () => f());\nexpect(ms).toBeLessThan(budgetMs(1_500));")).toEqual([]);
    expect(lines("expect(\n  fastestMs(3, () => f(')')),\n).toBeLessThan(budgetMs(900));")).toEqual([]);
    expect(lines("expect(fastestMs(1, () => f())).toBeGreaterThanOrEqual(150);")).toEqual([]);
  });

  it("コメントや文字列の中の fastestMs( は見ない", () => {
    expect(lines('// fastestMs(1, f) < 3\nconst s = "fastestMs(1, f)";\nconst t = `fastestMs(`;')).toEqual([]);
  });

  it("budget-exempt: の印がある呼び出しは検査しない", () => {
    expect(lines("// budget-exempt: 比\nconst t = fastestMs(3, f);\nexpect(t).toBeLessThan(9);")).toEqual([]);
  });

  it("使い方を判別できない形は拒む（見逃さない）", () => {
    expect(lines("check(fastestMs(2, () => f()));")).toEqual([1]);
    expect(lines("const ms = fastestMs(2, () => f());\nlog(ms);")).toEqual([1]);
  });
});
