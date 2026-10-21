// 契約付録 §5（jpaper web）。repo の Web アプリ（apps/web/scripts/dev.mjs）を、依存が無い・古ければ pnpm install してから立ち上げる。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killChild, resolveCommand, ShimError } from "../bin/spawn-cli.mjs";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEV_SCRIPT = path.join("apps", "web", "scripts", "dev.mjs");

// 実行した場所を基準に絶対パスへ直す環境変数。
const PATH_KEYS = ["JPAPER_GLOSSARY_DB", "JPAPER_HOME", "JPAPER_DUMP_RAW", "CODEX_HOME"] as const;

export function webEnv(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, JPAPER_ARTICLE_DIR: path.resolve(cwd, env.JPAPER_ARTICLE_DIR?.trim() || "article") };
  for (const k of PATH_KEYS) {
    const v = env[k]?.trim();
    if (v) out[k] = path.resolve(cwd, v);
  }
  return out;
}

export interface Files {
  exists: (p: string) => boolean;
  read: (p: string) => string | undefined;
}

const files: Files = {
  exists: existsSync,
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
};

// Web アプリの依存が無い、または入れた依存（node_modules/.pnpm/lock.yaml）が pnpm-lock.yaml と違う。
export function needsInstall(root: string, f: Files = files): boolean {
  if (!f.exists(path.join(root, "apps", "web", "node_modules"))) return true;
  const installed = f.read(path.join(root, "node_modules", ".pnpm", "lock.yaml"));
  return installed === undefined || installed !== f.read(path.join(root, "pnpm-lock.yaml"));
}

export interface WebDeps {
  root?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  files?: Files;
  // pnpm install（同期。終了コードを返す。起動できなければ undefined）。
  install?: (root: string) => number | undefined;
  // Web アプリ（終わるまで待ち、終了コードを返す）。
  serve?: (root: string, env: NodeJS.ProcessEnv) => Promise<number>;
  stderr?: (s: string) => void;
}

const install = (root: string): number | undefined => {
  let cmd: { command: string; args: string[] };
  try {
    cmd = resolveCommand("pnpm", ["install", "--frozen-lockfile"]);
  } catch (e) {
    if (e instanceof ShimError) return undefined;
    throw e;
  }
  const r = spawnSync(cmd.command, cmd.args, { cwd: root, stdio: "inherit" });
  return r.error === undefined ? (r.status ?? 1) : undefined;
};

// シグナルで終わった子の終了コード（128 + シグナルの番号）。
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal === null ? 1 : 128 + (constants.signals[signal] ?? 0);
}

export function serve(root: string, env: NodeJS.ProcessEnv, script = DEV_SCRIPT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, env, stdio: "inherit" });
    // SIGINT・SIGTERM・SIGHUP は子（dev.mjs）へ渡し、子の終わりを待つ。
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Windows の Ctrl+C は同じコンソールの子にも届く。
      if (process.platform === "win32" && signal === "SIGINT") return;
      killChild(child, signal);
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const s of signals) process.on(s, forward);
    const done = (code: number): void => {
      for (const s of signals) process.off(s, forward);
      resolve(code);
    };
    child.on("exit", (code, signal) => done(exitCodeOf(code, signal)));
    child.on("error", () => done(1));
  });
}

export async function runWeb(deps: WebDeps = {}): Promise<number> {
  const root = deps.root ?? REPO_ROOT;
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  if (needsInstall(root, deps.files)) {
    stderr(`Web アプリの依存が無い・古いので、${root} で pnpm install --frozen-lockfile を実行します\n`);
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
