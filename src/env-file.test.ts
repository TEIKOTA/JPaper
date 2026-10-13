import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "./env-file.js";

const dirs: string[] = [];
const KEYS = ["JPAPER_TEST_ENV_A", "JPAPER_TEST_ENV_B"];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-envfile-"));
  dirs.push(d);
  return d;
};

describe("loadDotEnv（契約付録 §5・issue #273）", () => {
  it("ファイルの値をプロセスに載せ、既にある環境変数は上書きしない", () => {
    const f = path.join(tmp(), "dotenv");
    writeFileSync(f, "JPAPER_TEST_ENV_A=from-file\nJPAPER_TEST_ENV_B=b-from-file\n");
    process.env.JPAPER_TEST_ENV_A = "from-shell";
    expect(loadDotEnv(f)).toEqual({});
    expect(process.env.JPAPER_TEST_ENV_A).toBe("from-shell");
    expect(process.env.JPAPER_TEST_ENV_B).toBe("b-from-file");
  });

  it("ファイルが無ければ何もしない", () => {
    expect(loadDotEnv(path.join(tmp(), "missing"))).toEqual({});
  });

  it("読めない（ディレクトリなど）なら理由を返す", () => {
    const d = path.join(tmp(), "dir");
    mkdirSync(d);
    expect(loadDotEnv(d).error).toBeDefined();
  });

  it("ENOENT 以外の失敗は握りつぶさない", () => {
    const r = loadDotEnv("x", () => {
      throw Object.assign(new Error("parse failed"), { code: "EINVAL" });
    });
    expect(r).toEqual({ error: "parse failed" });
  });

  it("CLI は入口のガードの中でだけ読み、runCli では読まない", () => {
    const src = readFileSync(path.join(import.meta.dirname, "cli.ts"), "utf8");
    const guard = src.indexOf("if (import.meta.url === `file://${process.argv[1]}`)");
    expect(guard).toBeGreaterThan(-1);
    expect(src.indexOf("loadDotEnv(")).toBeGreaterThan(guard);
    expect(src.slice(0, guard)).not.toContain("loadDotEnv(");
  });
});

describe(".env.example", () => {
  it("キー名と説明だけで、値の入った行が無い", () => {
    const text = readFileSync(path.join(import.meta.dirname, "..", ".env.example"), "utf8");
    const active = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(active).toEqual([]);
    expect(text).toContain("# OPENROUTER_API_KEY=");
  });
});
