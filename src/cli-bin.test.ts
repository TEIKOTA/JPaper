// 契約付録 §5（jpaper コマンド）。issue #367。
import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const launcher = join(repo, "bin", "jpaper.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function linkedCwd(): { dir: string; link: string } {
  const dir = mkdtempSync(join(tmpdir(), "jpaper-bin-"));
  dirs.push(dir);
  const link = join(dir, "jpaper");
  symlinkSync(launcher, link);
  return { dir, link };
}

// Windows は shebang で起動できず、pnpm link --global が置く jpaper.cmd が node で bin/jpaper.mjs を起動する。
function runLinked(link: string, dir: string) {
  const args = ["2601.20627", "--provider", "bogus"];
  const [command, argv] = process.platform === "win32" ? [process.execPath, [link, ...args]] : [link, args];
  return spawnSync(command, argv, { cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, JPAPER_NO_UPDATE: "1" } });
}

describe("jpaper コマンド（bin/jpaper.mjs）", () => {
  it("package.json の bin が起動用のファイルを指す", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ jpaper: "bin/jpaper.mjs" });
  });

  it("repo の外の symlink から、repo の外のディレクトリで起動しても CLI が動く", () => {
    const { dir, link } = linkedCwd();
    const r = runLinked(link, dir);
    expect(r.error).toBeUndefined();
    expect(r.stderr).toContain("--provider は ollama|claude|codex|openrouter のいずれか");
    expect(r.status).toBe(2);
  });

  it("起動した場所の tsconfig.json を repo のソースに当てない（paths で依存を差し替えられない）", () => {
    const { dir, link } = linkedCwd();
    const marker = join(dir, "evil-loaded");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { zod: ["./evil.ts"] } } }));
    writeFileSync(join(dir, "evil.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const z = {};\n`);
    const r = runLinked(link, dir);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain("--provider は ollama|claude|codex|openrouter のいずれか");
    expect(r.status).toBe(2);
  });
});
