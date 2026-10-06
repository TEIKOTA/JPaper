import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inputSignature } from "./translate-paper.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-sig-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// tar / cp -p / rsync -t は mtime を秒単位で復元する。同一パス・同一サイズ・同一 mtime の
// 別論文が同じ入力とみなされると、論文 B を投げた利用者に論文 A の訳文が exit 0 で返る
// （LLM 呼び出し 0 回）。無効化キーは入力の内容を代表しなければならない。
describe("inputSignature", () => {
  const T = 1_700_000_000;

  it("mtime とサイズが同じでも内容が違えば署名が変わる", () => {
    const d = tmp();
    const p = path.join(d, "paper.tex");
    writeFileSync(p, "PAPER-A".padEnd(100, "."));
    utimesSync(p, T, T);
    const a = inputSignature({ kind: "path", path: p });
    writeFileSync(p, "PAPER-B".padEnd(100, "."));
    utimesSync(p, T, T);
    expect(inputSignature({ kind: "path", path: p })).not.toBe(a);
  });

  it("内容が同じなら署名は変わらない（再開が効き続ける）", () => {
    const d = tmp();
    const p = path.join(d, "paper.tex");
    writeFileSync(p, "SAME");
    const a = inputSignature({ kind: "path", path: p });
    utimesSync(p, T + 999, T + 999);
    expect(inputSignature({ kind: "path", path: p })).toBe(a);
  });

  it("ディレクトリ入力も中身の差を反映する", () => {
    const d = tmp();
    const src = path.join(d, "src");
    mkdirSync(path.join(src, "sections"), { recursive: true });
    writeFileSync(path.join(src, "main.tex"), "\\input{sections/intro}");
    writeFileSync(path.join(src, "sections", "intro.tex"), "A");
    const a = inputSignature({ kind: "path", path: src });
    writeFileSync(path.join(src, "sections", "intro.tex"), "B");
    utimesSync(path.join(src, "sections", "intro.tex"), T, T);
    expect(inputSignature({ kind: "path", path: src })).not.toBe(a);
  });

  it("存在しないパスでも例外にしない", () => {
    expect(inputSignature({ kind: "path", path: path.join(tmp(), "nope.tex") })).toMatch(/^[0-9a-f]+$/);
  });
});
