// 契約付録 §5（jpaper コマンド）。issue #367。
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const launcher = join(repo, "bin", "jpaper.mjs");

describe("jpaper コマンド（bin/jpaper.mjs）", () => {
  it("package.json の bin が起動用のファイルを指す", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ jpaper: "bin/jpaper.mjs" });
  });

  it("repo の外の symlink から、repo の外のディレクトリで起動しても CLI が動く", () => {
    const dir = mkdtempSync(join(tmpdir(), "jpaper-bin-"));
    const link = join(dir, "jpaper");
    symlinkSync(launcher, link);
    const r = spawnSync(link, ["2601.20627", "--provider", "bogus"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r.stderr).toContain("--provider は ollama|claude|codex|openrouter のいずれか");
    expect(r.status).toBe(2);
  });
});
