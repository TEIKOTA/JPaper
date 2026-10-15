// 契約付録 §5（jpaper web）。repo の Web アプリ（apps/web/scripts/dev.mjs）を、依存が無ければ pnpm install してから立ち上げる。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 実行した場所を基準に絶対パスへ直す環境変数。
const PATH_KEYS = ["JPAPER_GLOSSARY_DB", "JPAPER_HOME"] as const;

export function webEnv(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, JPAPER_ARTICLE_DIR: path.resolve(cwd, env.JPAPER_ARTICLE_DIR?.trim() || "article") };
  for (const k of PATH_KEYS) {
    const v = env[k]?.trim();
    if (v) out[k] = path.resolve(cwd, v);
  }
  return out;
}

export function needsInstall(root: string, exists: (p: string) => boolean = existsSync): boolean {
  return !exists(path.join(root, "apps", "web", "node_modules"));
}

export interface WebDeps {
  root?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  // pnpm install（同期。終了コードを返す。起動できなければ undefined）。
  install?: (root: string) => number | undefined;
  // Web アプリ（終わるまで待ち、終了コードを返す）。
  serve?: (root: string, env: NodeJS.ProcessEnv) => Promise<number>;
  stderr?: (s: string) => void;
}

const install = (root: string): number | undefined => {
  const r = spawnSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
  return r.error === undefined ? (r.status ?? 1) : undefined;
};

const serve = (root: string, env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "apps", "web", "scripts", "dev.mjs")], { cwd: root, env, stdio: "inherit" });
    // SIGINT・SIGTERM は子（dev.mjs）へ渡し、子の終わりを待つ。
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null) child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("exit", (code) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? 0);
    });
    child.on("error", () => resolve(1));
  });

export async function runWeb(deps: WebDeps = {}): Promise<number> {
  const root = deps.root ?? REPO_ROOT;
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  if (needsInstall(root, deps.exists)) {
    stderr(`Web アプリの依存が無いので、${root} で pnpm install を実行します\n`);
    const code = (deps.install ?? install)(root);
    if (code === undefined) {
      stderr("エラー: pnpm を起動できません（pnpm を入れてから、もう一度 jpaper web を実行してください）\n");
      return 2;
    }
    if (code !== 0) {
      stderr(`エラー: pnpm install が失敗しました（終了コード ${String(code)}）\n`);
      return 2;
    }
  }
  return (deps.serve ?? serve)(root, webEnv(deps.cwd ?? process.cwd(), deps.env ?? process.env));
}
