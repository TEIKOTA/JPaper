import path from "node:path";
import { describe, it, expect } from "vitest";
import { runCli } from "./cli.js";
import { needsInstall, webEnv } from "./web-launch.js";

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
        exists: (p: string) => installed || !p.endsWith(path.join("apps", "web", "node_modules")),
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
  });

  it("環境変数の相対パスは実行した場所から、絶対パスはそのまま", () => {
    expect(webEnv("/w", { JPAPER_ARTICLE_DIR: "papers", JPAPER_GLOSSARY_DB: "/abs/g.db" })).toMatchObject({
      JPAPER_ARTICLE_DIR: "/w/papers",
      JPAPER_GLOSSARY_DB: "/abs/g.db",
    });
    expect(needsInstall("/r", (p) => p !== "/r/apps/web/node_modules")).toBe(true);
  });
});
