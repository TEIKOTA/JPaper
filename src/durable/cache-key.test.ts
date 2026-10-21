import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

  // Windows の mode は読み取り専用の属性だけを表し、読める主体はフォルダから継いだ ACL が決める。
  it.skipIf(process.platform === "win32")("鍵ファイルは所有者のみ読める（.run に書ける主体へ渡さない）", () => {
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

describe("loadCacheKey の同時作成（issue #395）", () => {
  it("鍵の無い home で複数のプロセスが同時に作っても落ちず、全員が同じ鍵を返す", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "jpaper-key-race-"));
    dirs.push(home);
    const mod = new URL("./cache-key.ts", import.meta.url).href;
    // 全プロセスが揃ってから一斉に作らせる（start のファイルが現れるまで待つ）。
    const start = path.join(home, "start");
    const script = `const { existsSync } = await import("node:fs");
const { loadCacheKey } = await import(${JSON.stringify(mod)});
while (!existsSync(${JSON.stringify(start)})) {}
process.stdout.write(loadCacheKey(${JSON.stringify(home)}).toString("hex"));`;
    const runs = Array.from({ length: 12 }, () =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("close", (code) => resolve({ code, out, err }));
      }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(start, "");
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code, r.err).toBe(0);
    expect(new Set(results.map((r) => r.out)).size).toBe(1);
    expect(readFileSync(path.join(home, "cache.key")).toString("hex")).toBe(results[0]!.out);
  }, 30_000);
});
