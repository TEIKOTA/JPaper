import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DOTENV_KEYS, describeDotEnv, loadDotEnv } from "./env-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-envfile-"));
  dirs.push(d);
  return d;
};

const DOTENV = ".env";

describe("loadDotEnv（契約付録 §8・issue #273）", () => {
  it("許可したキーのうち環境に無いものだけを載せ、既にあるものは上書きしない", () => {
    const f = path.join(tmp(), "dotenv");
    writeFileSync(f, "JPAPER_HOME=from-file\nJPAPER_DUMP_RAW=/raw-from-file\n");
    const env: NodeJS.ProcessEnv = { JPAPER_HOME: "from-shell" };
    expect(loadDotEnv(f, env)).toEqual({ loaded: ["JPAPER_DUMP_RAW"], ignored: [] });
    expect(env).toEqual({ JPAPER_HOME: "from-shell", JPAPER_DUMP_RAW: "/raw-from-file" });
  });

  it("空文字の環境変数も「既にある」として上書きしない", () => {
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "" };
    const r = loadDotEnv("x", env, () => "OPENROUTER_API_KEY=k\n");
    expect(r).toEqual({ loaded: [], ignored: [] });
    expect(env.OPENROUTER_API_KEY).toBe("");
  });

  it("許可していないキーは載せず、名前だけ返す", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv("x", env, () => "PATH=/evil\nNODE_OPTIONS=--require x\nCODEX_HOME=/c\n");
    expect(r).toEqual({ loaded: ["CODEX_HOME"], ignored: ["NODE_OPTIONS", "PATH"] });
    expect(env).toEqual({ CODEX_HOME: "/c" });
  });

  it("許可キーは .env.example に載せたものと同じ", () => {
    const text = readFileSync(path.join(import.meta.dirname, "..", ".env.example"), "utf8");
    const listed = [...text.matchAll(/^# ([A-Z0-9_]+)=$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...DOTENV_KEYS]);
  });

  it("ファイルが無ければ何もしない", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotEnv(path.join(tmp(), "missing"), env)).toEqual({ loaded: [], ignored: [] });
    expect(env).toEqual({});
  });

  it("読めない（ディレクトリ）なら理由のコードを返す", () => {
    const d = path.join(tmp(), "dir");
    mkdirSync(d);
    expect(loadDotEnv(d, {})).toEqual({ loaded: [], ignored: [], error: "EISDIR" });
  });

  it("コードの無い失敗は既定の文言を返し、例外の本文は出さない", () => {
    const r = loadDotEnv("x", {}, () => {
      throw new Error("secret=abc");
    });
    expect(r.error).toBe("読み込みに失敗しました");
  });
});

describe("loadDotEnv の値の扱い", () => {
  it("パスのキーの相対パスは .env のあるディレクトリを基準に解決する（CLI と Web で揃える）", () => {
    const d = tmp();
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(path.join(d, "dotenv"), env, () => "JPAPER_HOME=./home\nJPAPER_DUMP_RAW=/abs/raw\nCODEX_HOME=\nJPAPER_MAX_LLM_QUEUE=./3\n");
    expect(env).toEqual({
      JPAPER_HOME: path.join(d, "home"),
      JPAPER_DUMP_RAW: "/abs/raw",
      CODEX_HOME: "",
      JPAPER_MAX_LLM_QUEUE: "./3",
    });
  });

  it("パスのキーの先頭の ~/ はホームに展開する", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv("/r/dotenv", env, () => "JPAPER_HOME=~/jp\nCODEX_HOME=~\nJPAPER_DUMP_RAW=~x/raw\n", () => "/home/u");
    expect(env).toEqual({
      JPAPER_HOME: path.join("/home/u", "jp"),
      CODEX_HOME: path.join("/home/u"),
      JPAPER_DUMP_RAW: path.resolve("/r", "~x", "raw"),
    });
  });

  it("先頭の BOM を外して読む", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotEnv("x", env, () => "\uFEFFOPENROUTER_API_KEY=k\n").loaded).toEqual(["OPENROUTER_API_KEY"]);
    expect(env.OPENROUTER_API_KEY).toBe("k");
  });

  it("キー名の形でない行は名前を返さず、件数だけ返す", () => {
    const r = loadDotEnv("x", {}, () => "OPENROUTER_API_KEY sk-or-v1-zzz=\nc2VjcmV0=\nFOO=1\n");
    expect(r).toEqual({ loaded: [], ignored: ["FOO"], malformed: 2 });
    expect(describeDotEnv(r).join("\n")).not.toContain("sk-or");
  });
});

describe("describeDotEnv", () => {
  it("読んだキー・読まないキーの名前だけを並べる", () => {
    expect(describeDotEnv({ loaded: ["CODEX_HOME", "JPAPER_HOME"], ignored: ["PATH"] })).toEqual([
      ".env から読んだ: CODEX_HOME, JPAPER_HOME",
      ".env の次のキーは読みません: PATH",
    ]);
    expect(describeDotEnv({ loaded: [], ignored: [], malformed: 2 })).toEqual([".env のキー名の形でない 2 行は読みません"]);
    expect(describeDotEnv({ loaded: [], ignored: [] })).toEqual([]);
  });
});

describe("CLI の入口", () => {
  const root = path.join(import.meta.dirname, "..");
  const run = (cwd: string, arg = "--no-such-option") =>
    spawnSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), path.join(root, "src", "cli.ts"), arg], {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

  it("読めない .env ならその 1 行だけを出し、標準出力を空のまま終了コード 2（runCli へ進まない）", () => {
    const d = tmp();
    mkdirSync(path.join(d, DOTENV));
    const r = run(d);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("エラー: .env を読めません: EISDIR\n");
  });

  it("読んだキーの名前を標準エラーに出し、値は出さない", () => {
    const d = tmp();
    writeFileSync(path.join(d, DOTENV), "JPAPER_DUMP_RAW=value-xyz\nFOO=bar-xyz\n");
    const r = run(d);
    expect(r.stderr).toContain(".env から読んだ: JPAPER_DUMP_RAW");
    expect(r.stderr).toContain(".env の次のキーは読みません: FOO");
    expect(r.stderr + r.stdout).not.toContain("xyz");
  });

  it("--help では .env を読まず、使い方だけを出して終了コード 0（issue #371）", () => {
    const d = tmp();
    mkdirSync(path.join(d, DOTENV));
    const r = run(d, "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("使い方: jpaper");
    expect(r.stderr).toBe("");
  });

  it("repo を空白・日本語を含むパスから起動しても、直接起動の main() が動く（issue #422）", () => {
    const d = tmp();
    const via = path.join(d, "論文 ツール", "JPaper");
    mkdirSync(path.dirname(via));
    symlinkSync(root, via);
    const r = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), path.join(via, "src", "cli.ts"), "--help"], {
      cwd: d,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("使い方: jpaper");
  });

  it("runCli では読まず、入口の main() の中の 1 か所だけで読む", () => {
    const src = readFileSync(path.join(import.meta.dirname, "cli.ts"), "utf8");
    const main = src.indexOf("export async function main(");
    expect(main).toBeGreaterThan(-1);
    const guard = src.indexOf("if (isMainModule(import.meta.url, process.argv[1]))");
    expect(guard).toBeGreaterThan(main);
    const calls = [...src.matchAll(/loadDotEnv\(/g)].map((m) => m.index);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(main);
    expect(calls[0]).toBeLessThan(guard);
    expect(src.indexOf("export async function runCli(")).toBeLessThan(main);
  });
});

describe(".env.example", () => {
  it("キー名と説明だけで、値の入った行が無い", () => {
    const text = readFileSync(path.join(import.meta.dirname, "..", ".env.example"), "utf8");
    const active = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(active).toEqual([]);
  });
});
