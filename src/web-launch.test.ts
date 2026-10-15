import path from "node:path";
import { describe, it, expect } from "vitest";
import { readsDotEnv, runCli } from "./cli.js";
import { DEV_SCRIPT, exitCodeOf, needsInstall, REPO_ROOT, serve, webEnv } from "./web-launch.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

const ROOT = "/repo";

function deps(installed: boolean, installCode: { code: number | undefined } = { code: 0 }) {
  const calls: string[] = [];
  const err: string[] = [];
  let served: NodeJS.ProcessEnv | undefined;
  return {
    calls,
    err,
    served: () => served,
    cli: {
      stderr: (s: string) => err.push(s),
      web: {
        root: ROOT,
        cwd: "/work",
        env: { JPAPER_HOME: "home", PATH: "/bin" },
        files: {
          exists: (p: string) => installed || !p.endsWith(path.join("apps", "web", "node_modules")),
          read: (p: string) => (p.endsWith("lock.yaml") ? "lock" : undefined),
        },
        install: (root: string) => {
          calls.push(`install ${root}`);
          return installCode.code;
        },
        serve: (root: string, env: NodeJS.ProcessEnv) => {
          calls.push(`serve ${root}`);
          served = env;
          return Promise.resolve(0);
        },
      },
    },
  };
}

describe("jpaper web（契約付録 §5・issue #410）", () => {
  it("依存があればそのまま Web アプリを立ち上げ、パスは実行した場所を基準にする", async () => {
    const d = deps(true);
    expect(await runCli(["node", "jpaper", "web"], d.cli)).toBe(0);
    expect(d.calls).toEqual([`serve ${ROOT}`]);
    expect(d.served()).toMatchObject({ JPAPER_ARTICLE_DIR: "/work/article", JPAPER_HOME: "/work/home", PATH: "/bin" });
  });

  it("Web アプリの依存が無ければ、先に repo で pnpm install を実行する", async () => {
    const d = deps(false);
    expect(await runCli(["node", "jpaper", "web"], d.cli)).toBe(0);
    expect(d.calls).toEqual([`install ${ROOT}`, `serve ${ROOT}`]);
  });

  it("pnpm install が失敗する・pnpm が無いときは立ち上げずに exit 2", async () => {
    for (const code of [1, undefined]) {
      const d = deps(false, { code });
      expect(await runCli(["node", "jpaper", "web"], d.cli)).toBe(2);
      expect(d.calls).toEqual([`install ${ROOT}`]);
      expect(d.err.join("")).toMatch(code === undefined ? /pnpm を起動できません/ : /pnpm install が失敗/);
    }
  });

  it("余計な引数は入力の誤り", async () => {
    const d = deps(true);
    expect(await runCli(["node", "jpaper", "web", "--port", "1"], d.cli)).toBe(2);
    expect(d.calls).toEqual([]);
    expect(d.err.join("")).toContain("./web");
  });

  it("jpaper web と -h・--help では作業ディレクトリの .env を読まない", () => {
    expect(readsDotEnv(["node", "jpaper", "web"])).toBe(false);
    expect(readsDotEnv(["node", "jpaper", "web", "-h"])).toBe(false);
    expect(readsDotEnv(["node", "jpaper", "2601.20627", "--provider", "claude"])).toBe(true);
  });

  it("入れた依存が pnpm-lock.yaml と違えば（git pull の後など）入れ直す", () => {
    const f = (installed: string | undefined, nm = true) => ({
      exists: () => nm,
      read: (p: string) => (p.endsWith(path.join(".pnpm", "lock.yaml")) ? installed : "v2"),
    });
    expect(needsInstall("/r", f("v2"))).toBe(false);
    expect(needsInstall("/r", f("v1"))).toBe(true);
    expect(needsInstall("/r", f(undefined))).toBe(true);
    expect(needsInstall("/r", f("v2", false))).toBe(true);
  });

  it("Web アプリの起動用のファイルは repo にあり、終了コード・シグナルでの終わりを伝える", async () => {
    expect(existsSync(path.join(REPO_ROOT, DEV_SCRIPT))).toBe(true);
    const dir = mkdtempSync(path.join(os.tmpdir(), "jpaper-web-"));
    try {
      mkdirSync(path.join(dir, "s"));
      writeFileSync(path.join(dir, "s", "exit.mjs"), "process.exit(Number(process.env.CODE));\n");
      writeFileSync(path.join(dir, "s", "kill.mjs"), "process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n");
      expect(await serve(dir, { ...process.env, CODE: "7" }, path.join("s", "exit.mjs"))).toBe(7);
      expect(await serve(dir, process.env, path.join("s", "kill.mjs"))).toBe(143);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(exitCodeOf(null, null)).toBe(1);
  });

  it("環境変数の相対パスは実行した場所から、絶対パスはそのまま", () => {
    expect(webEnv("/w", { JPAPER_ARTICLE_DIR: "papers", JPAPER_GLOSSARY_DB: "/abs/g.db" })).toMatchObject({
      JPAPER_ARTICLE_DIR: "/w/papers",
      JPAPER_GLOSSARY_DB: "/abs/g.db",
    });
  });
});
