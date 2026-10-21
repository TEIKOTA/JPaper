// 外部コマンドの起動と停止の OS 差。契約付録 §5「Windows」（issue #462）。⚠ landmines.md
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const readText = (p) => readFileSync(p, "utf8");

const envValue = (env, name) => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

// npm（cmd-shim）・pnpm（@zkochan/cmd-shim）の .cmd が %* の直前に置く対象のパス。
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+)"\s+%\*/g;
const JS_EXT = new Set([".js", ".cjs", ".mjs"]);

export class ShimError extends Error {}

function findOnPath(cmd, env, exists) {
  const w = path.win32;
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e !== "")
    .map((e) => e.toLowerCase());
  const withExt = (base) => (exts.includes(w.extname(base).toLowerCase()) ? [base] : exts.map((e) => base + e));
  const dirs = /[\\/]/.test(cmd) ? [""] : (envValue(env, "PATH") || "").split(";").filter((d) => d !== "");
  for (const dir of dirs) {
    for (const c of withExt(dir === "" ? cmd : w.join(dir.replace(/^"(.*)"$/, "$1"), cmd))) {
      if (exists(c)) return c;
    }
  }
  return undefined;
}

export function resolveCommand(cmd, args, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command: cmd, args };
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? isFile;
  const read = deps.read ?? readText;
  const execPath = deps.execPath ?? process.execPath;
  const found = findOnPath(cmd, env, exists);
  if (found === undefined) return { command: cmd, args };
  const ext = path.win32.extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: found, args };
  const targets = [...read(found).matchAll(SHIM_TARGET)].map((m) => m[1]);
  const rel = targets.at(-1);
  if (rel === undefined) throw new ShimError(`${found} の中から起動する対象を読めません（npm・pnpm の shim ではない）`);
  const target = path.win32.join(path.win32.dirname(found), rel);
  const targetExt = path.win32.extname(target).toLowerCase();
  if (targetExt === ".exe") return { command: target, args };
  if (JS_EXT.has(targetExt) || (targetExt === "" && /node(\.exe)?"?\s*$|_prog=node/im.test(read(found)))) return { command: execPath, args: [target, ...args] };
  throw new ShimError(`${found} の起動する対象 ${target} を直接起動できません`);
}

export function spawnOptions(opts = {}, platform = process.platform) {
  if (platform !== "win32") return opts;
  return { ...opts, detached: false, windowsHide: true };
}

function taskkill(pid, run) {
  run("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

export function killTree(pid, signal = "SIGKILL", deps = {}) {
  if (pid === undefined) return;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return taskkill(pid, deps.run ?? spawnSync);
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(-pid, signal);
  } catch {
    try {
      kill(pid, signal);
    } catch {
      // 既に終了している
    }
  }
}

export function killChild(child, signal = "SIGKILL", deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return void child.kill(signal);
  if (child.pid !== undefined) taskkill(child.pid, deps.run ?? spawnSync);
}
