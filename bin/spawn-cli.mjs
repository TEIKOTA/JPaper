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

// npm（cmd-shim）・pnpm（@zkochan/cmd-shim）の .cmd の起動行（%* で終わる行）の、最後の引用された対象。
const LAUNCH_TARGET = /"((?:%~dp0\\|%dp0%\\|[A-Za-z]:\\)[^"%\r\n]+)"\s*%\*\s*$/;
const NODE_PROG = /^(?:"%_prog%"|"%~?dp0%?\\node\.exe"|node)$/i;
const ALLOWED_SET = /^@?SET\s+"?(?:NODE_PATH|dp0|PATHEXT|_prog)=/i;
const NODE_SET = /_prog=(?:node|%dp0%\\node\.exe)"?$/i;
const JS_EXT = new Set([".js", ".cjs", ".mjs"]);
const EXE_EXT = new Set([".exe", ".com"]);

export class ShimError extends Error {}

function findOnPath(cmd, env, exists) {
  const w = path.win32;
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e !== "")
    .map((e) => e.toLowerCase());
  const withExt = (base) => (exts.includes(w.extname(base).toLowerCase()) ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(cmd)) return withExt(cmd).find(exists);
  const dirs = (envValue(env, "PATH") || "")
    .split(";")
    .map((d) => d.replace(/^"(.*)"$/, "$1"))
    .filter((d) => w.isAbsolute(d));
  for (const dir of dirs) {
    for (const c of withExt(w.join(dir, cmd))) {
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
  if (found === undefined) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
  const ext = path.win32.extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: found, args };
  const shim = parseShim(read(found), found);
  return shim.node ? { command: execPath, args: [shim.target, ...args] } : { command: shim.target, args };
}

function parseShim(text, file) {
  const fail = (why) => {
    throw new ShimError(`${file} を直接起動できません（${why}）`);
  };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (const l of lines) if (/^@?SET\s/i.test(l) && !ALLOWED_SET.test(l)) fail("環境変数を設定する shim");
  for (const l of lines) if (/_prog=/i.test(l) && !NODE_SET.test(l)) fail("node 以外で起動する shim");
  const launches = lines.filter((l) => /%\*\s*$/.test(l));
  if (launches.length === 0) fail("npm・pnpm の shim ではない");
  const parsed = launches.map((l) => {
    const m = LAUNCH_TARGET.exec(l);
    if (m === null) return fail("起動する対象を読めない");
    const rel = m[1].replace(/^%~?dp0%?\\/, "");
    const target = /^[A-Za-z]:\\/.test(rel) ? rel : path.win32.join(path.win32.dirname(file), rel);
    const prog = l.slice(0, m.index).replace(/^.*&\s*/, "").replace(/^@/, "").trim();
    const targetExt = path.win32.extname(target).toLowerCase();
    if (prog === "") return EXE_EXT.has(targetExt) ? { node: false, target } : fail(`対象 ${target} が exe でない`);
    if (/^(?:"[^"]*"|\S+)/.exec(prog)?.[0] !== prog) return fail("node に追加の引数を渡す shim");
    if (!NODE_PROG.test(prog)) return fail("node 以外で起動する shim");
    return JS_EXT.has(targetExt) || targetExt === "" ? { node: true, target } : fail(`対象 ${target} が JS でない`);
  });
  const [first] = parsed;
  if (parsed.some((p) => p.node !== first.node || p.target !== first.target)) fail("起動行ごとに対象が違う");
  return first;
}

export function spawnOptions(opts = {}, platform = process.platform) {
  if (platform !== "win32") return opts;
  return { ...opts, detached: false, windowsHide: true };
}

const TASKKILL_TIMEOUT_MS = 10_000;

// 止められたら true。
function taskkill(pid, run, env) {
  const exe = path.win32.join(envValue(env, "SYSTEMROOT") || "C:\\Windows", "System32", "taskkill.exe");
  const r = run(exe, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: TASKKILL_TIMEOUT_MS });
  return r?.error === undefined && r?.status === 0;
}

export function killTree(pid, signal = "SIGKILL", deps = {}) {
  if (pid === undefined) return;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return void taskkill(pid, deps.run ?? spawnSync, deps.env ?? process.env);
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
  if (child.exitCode != null || child.signalCode != null) return;
  if (platform !== "win32") return void child.kill(signal);
  if (child.pid === undefined || !taskkill(child.pid, deps.run ?? spawnSync, deps.env ?? process.env)) child.kill(signal);
}
