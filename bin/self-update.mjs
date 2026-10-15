// jpaper の起動時に repo の更新を取り込む。契約付録 §5（issue #420）
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FETCH_TIMEOUT_MS = 5000;
export const WEB_PID_DIR = ".jpaper-web";
const BRANCH = "main";

export function gitEnv(env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete out[k];
  return out;
}

const defaultRun = (root, env) => (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: cmd === "git" ? gitEnv(env) : env,
    encoding: "utf8",
    stdio: opts.inherit ? ["ignore", 2, 2] : "pipe",
    timeout: opts.timeout,
  });
  return { ok: r.error === undefined && r.status === 0, stdout: (r.stdout ?? "").trim() };
};

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// 入れた依存（node_modules/.pnpm/lock.yaml）が pnpm-lock.yaml と違う。
export const lockStale = (root) => read(join(root, "node_modules", ".pnpm", "lock.yaml")) !== read(join(root, "pnpm-lock.yaml"));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Web アプリ（apps/web/scripts/dev.mjs）が <root>/.jpaper-web/<pid> を置いて動いている。
export function webRunning(root) {
  let names = [];
  try {
    names = readdirSync(join(root, WEB_PID_DIR));
  } catch {
    return false;
  }
  let running = false;
  for (const n of names) {
    if (!/^[0-9]+$/.test(n)) continue;
    if (alive(Number(n))) running = true;
    else rmSync(join(root, WEB_PID_DIR, n), { force: true });
  }
  return running;
}

export function selfUpdate({
  root,
  env = process.env,
  run = defaultRun(root, env),
  stderr = (s) => process.stderr.write(s),
  hasGit = existsSync(join(root, ".git")),
  web = () => webRunning(root),
  stale = () => lockStale(root),
}) {
  if (env.JPAPER_NO_UPDATE === "1" || !hasGit) return "skipped";
  const result = pull({ run, stderr, web, env });
  if (result !== "offline" && stale() && !web()) {
    stderr("jpaper: 依存が pnpm-lock.yaml と違うので pnpm install --frozen-lockfile を実行します\n");
    if (!run("pnpm", ["install", "--frozen-lockfile"], { inherit: true }).ok) {
      stderr("jpaper: pnpm install が失敗しました。jpaper の repo で pnpm install を実行してください\n");
    }
  }
  return result;
}

function pull({ run, stderr, web, env }) {
  const git = (args, opts) => run("git", args, opts);
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
  const ssh =
    env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined && git(["config", "--get", "core.sshCommand"]).stdout === ""
      ? ["-c", "core.sshCommand=ssh -o BatchMode=yes"]
      : [];
  if (!git([...ssh, "fetch", "--quiet", "origin", BRANCH], { timeout: FETCH_TIMEOUT_MS }).ok) return "offline";
  const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]);
  const remote = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]);
  if (!head.ok || !remote.ok || head.stdout === remote.stdout) return "current";
  if (branch !== BRANCH) {
    const contains = git(["merge-base", "--is-ancestor", remote.stdout, "HEAD"]).ok;
    if (!contains && git(["merge-base", "--is-ancestor", head.stdout, remote.stdout]).ok) {
      stderr(`jpaper: 更新があります。${BRANCH} 以外（${branch || "detached HEAD"}）にいるので取り込みません。今の版で起動します\n`);
    }
    return "blocked";
  }
  if (!git(["merge-base", "--is-ancestor", head.stdout, remote.stdout]).ok) {
    if (git(["merge-base", "--is-ancestor", remote.stdout, head.stdout]).ok) return "ahead";
    stderr(`jpaper: 更新を取り込めません（手元の ${BRANCH} が origin/${BRANCH} と分かれています）。今の版で起動します\n`);
    return "blocked";
  }
  if (git(["status", "--porcelain", "--untracked-files=no"]).stdout !== "") {
    stderr("jpaper: 更新があります。未コミットの変更があるので取り込みません。今の版で起動します\n");
    return "blocked";
  }
  if (web()) {
    stderr("jpaper: 更新があります。Web アプリ（jpaper web）が動いているので取り込みません。今の版で起動します\n");
    return "blocked";
  }
  if (!git(["merge", "--ff-only", "--quiet", remote.stdout]).ok) {
    stderr("jpaper: 更新の取り込みに失敗しました（追跡していないファイルと重なるなど）。今の版で起動します\n");
    return "blocked";
  }
  const count = git(["rev-list", "--count", `${head.stdout}..${remote.stdout}`]).stdout;
  stderr(`jpaper: 更新を取り込みました（${head.stdout.slice(0, 7)} → ${remote.stdout.slice(0, 7)}、${count} 件）\n`);
  return "updated";
}
