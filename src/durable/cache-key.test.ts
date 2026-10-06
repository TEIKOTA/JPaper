import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCacheKey } from "./cache-key.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-key-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadCacheKey", () => {
  it("初回に鍵を生成し、2回目は同じ鍵を返す", () => {
    const home = tmp();
    const first = loadCacheKey(home);
    expect(first.length).toBe(32);
    expect(loadCacheKey(home).equals(first)).toBe(true);
  });

  it("鍵ファイルは所有者のみ読める（.run に書ける主体へ渡さない）", () => {
    const home = tmp();
    loadCacheKey(home);
    const file = path.join(home, "cache.key");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("home が無ければ作る", () => {
    const home = path.join(tmp(), "nested", "home");
    expect(loadCacheKey(home).length).toBe(32);
  });
});
