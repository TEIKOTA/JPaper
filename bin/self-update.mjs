// jpaper の起動時に repo の更新を取り込む。契約付録 §5（issue #420）
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const FETCH_TIMEOUT_MS = 5000;
const BRANCH = "main";

const defaultRun = (root) => (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: opts.inherit ? ["ignore", 2, 2] : "pipe", timeout: opts.timeout });
  return { ok: r.error === undefined && r.status === 0, stdout: (r.stdout ?? "").trim() };
};

export function selfUpdate({ root, env = process.env, run = defaultRun(root), stderr = (s) => process.stderr.write(s), hasGit = existsSync(join(root, ".git")) }) {
  if (env.JPAPER_NO_UPDATE === "1" || !hasGit) return "skipped";
  const git = (args, opts) => run("git", args, opts);
  if (!git(["fetch", "--quiet", "origin", BRANCH], { timeout: FETCH_TIMEOUT_MS }).ok) return "offline";
  const head = git(["rev-parse", "HEAD"]).stdout;
  const remote = git(["rev-parse", `origin/${BRANCH}`]).stdout;
  if (head === "" || remote === "" || head === remote) return "current";
  if (!git(["merge-base", "--is-ancestor", head, remote]).ok) {
    if (git(["merge-base", "--is-ancestor", remote, head]).ok) return "ahead";
    stderr(`jpaper: 更新を取り込めません（手元の ${BRANCH} が origin/${BRANCH} と分かれています）。今の版で起動します\n`);
    return "blocked";
  }
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
  if (branch !== BRANCH) {
    stderr(`jpaper: 更新があります。${BRANCH} 以外（${branch || "detached HEAD"}）にいるので取り込みません。今の版で起動します\n`);
    return "blocked";
  }
  if (git(["status", "--porcelain", "--untracked-files=no"]).stdout !== "") {
    stderr("jpaper: 更新があります。未コミットの変更があるので取り込みません。今の版で起動します\n");
    return "blocked";
  }
  if (!git(["merge", "--ff-only", "--quiet", remote]).ok) {
    stderr("jpaper: 更新の取り込みに失敗しました。今の版で起動します\n");
    return "blocked";
  }
  const count = git(["rev-list", "--count", `${head}..${remote}`]).stdout;
  stderr(`jpaper: 更新を取り込みました（${head.slice(0, 7)} → ${remote.slice(0, 7)}、${count} 件）\n`);
  if (!git(["diff", "--quiet", head, remote, "--", "pnpm-lock.yaml"]).ok) {
    stderr("jpaper: 依存が変わったので pnpm install --frozen-lockfile を実行します\n");
    if (!run("pnpm", ["install", "--frozen-lockfile"], { inherit: true }).ok) {
      stderr("jpaper: pnpm install が失敗しました。jpaper の repo で pnpm install を実行してください\n");
    }
  }
  return "updated";
}
