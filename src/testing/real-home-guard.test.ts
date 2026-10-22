import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshot } from "./real-home-guard.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-guard-"));
  dirs.push(d);
  return d;
};

describe("real-home-guard の snapshot（#484）", () => {
  it("空の ~/.jpaper を作っただけでも差分になる", () => {
    const home = path.join(tmp(), ".jpaper");
    const before = snapshot(home);
    mkdirSync(home);
    expect(snapshot(home)).not.toEqual(before);
  });

  it("中のファイルの追加も差分になり、変えなければ同じ", () => {
    const home = path.join(tmp(), ".jpaper");
    mkdirSync(home);
    const before = snapshot(home);
    expect(snapshot(home)).toEqual(before);
    writeFileSync(path.join(home, "key"), "x");
    expect(snapshot(home)).not.toEqual(before);
  });
});
