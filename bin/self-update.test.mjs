// 契約付録 §5（起動時の更新）。issue #420
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitEnv, lockStale, selfUpdate, WEB_PID_DIR, webRunning } from "./self-update.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 利用者の git 設定（署名など）に左右されない。
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: ENV }).trim();
const commit = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", file);
};

// origin（bare）と、その clone（root）と、origin を進める別の clone（upstream）。
function repos() {
  const base = mkdtempSync(join(tmpdir(), "jpaper-update-"));
  dirs.push(base);
  const origin = join(base, "origin.git");
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const upstream = join(base, "upstream");
  git(base, "clone", "--quiet", origin, upstream);
  git(upstream, "checkout", "--quiet", "-b", "main");
  commit(upstream, "a.txt", "1");
  commit(upstream, "pnpm-lock.yaml", "lock 1");
  git(upstream, "push", "--quiet", "origin", "main");
  const root = join(base, "root");
  git(base, "clone", "--quiet", origin, root);
  mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), "lock 1");
  return { root, upstream };
}
const advance = (upstream, file = "a.txt", text = "2") => {
  commit(upstream, file, text);
  git(upstream, "push", "--quiet", "origin", "main");
};

function update(root, { env = {}, web = false } = {}) {
  let err = "";
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "pnpm") return { ok: true, stdout: "" };
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: opts.timeout, env: gitEnv(ENV) });
    return { ok: r.error === undefined && r.status === 0, stdout: (r.stdout ?? "").trim() };
  };
  const result = selfUpdate({ root, env, run, stderr: (s) => (err += s), hasGit: true, web: () => web, stale: () => lockStale(root) });
  return { result, err, calls };
}

describe("起動時の更新（issue #420）", () => {
  it("main・変更なし・早送りできるなら取り込み、1 行で知らせる", () => {
    const { root, upstream } = repos();
    advance(upstream);
    const r = update(root);
    expect(r.result).toBe("updated");
    expect(git(root, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(r.err).toMatch(/^jpaper: 更新を取り込みました（[0-9a-f]{7} → [0-9a-f]{7}、1 件）\n$/);
    expect(r.calls.some((c) => c.startsWith("pnpm"))).toBe(false);
  });

  it("pnpm-lock.yaml が変われば pnpm install --frozen-lockfile を実行する", () => {
    const { root, upstream } = repos();
    advance(upstream, "pnpm-lock.yaml", "lock 2");
    const r = update(root);
    expect(r.result).toBe("updated");
    expect(r.calls).toContain("pnpm install --frozen-lockfile");
  });

  it("更新が無ければ何も出さない", () => {
    const { root } = repos();
    expect(update(root)).toMatchObject({ result: "current", err: "" });
  });

  it("追跡ファイルに未コミットの変更があれば取り込まず、理由を知らせる", () => {
    const { root, upstream } = repos();
    advance(upstream);
    const before = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "pnpm-lock.yaml"), "edited");
    const r = update(root);
    expect(r.result).toBe("blocked");
    expect(r.err).toContain("未コミットの変更");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("追跡していないファイルだけなら取り込む", () => {
    const { root, upstream } = repos();
    advance(upstream);
    writeFileSync(join(root, "notes.txt"), "x");
    expect(update(root).result).toBe("updated");
  });

  it("main 以外の branch にいれば取り込まず、分岐とは言わない", () => {
    const { root, upstream } = repos();
    advance(upstream);
    git(root, "checkout", "--quiet", "-b", "feat/x");
    commit(root, "b.txt", "topic");
    const before = git(root, "rev-parse", "HEAD");
    const r = update(root);
    expect(r.result).toBe("blocked");
    expect(r.err).toContain("main 以外（feat/x）");
    expect(r.err).not.toContain("分かれています");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("Web アプリが動いていれば取り込まず、依存も入れ直さない", () => {
    const { root, upstream } = repos();
    advance(upstream, "pnpm-lock.yaml", "lock 2");
    const before = git(root, "rev-parse", "HEAD");
    const r = update(root, { web: true });
    expect(r.result).toBe("blocked");
    expect(r.err).toContain("Web アプリ");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(r.calls.some((c) => c.startsWith("pnpm"))).toBe(false);
  });

  it("更新が無くても、入れた依存が pnpm-lock.yaml と違えば入れ直す（前回の失敗のやり直し）", () => {
    const { root } = repos();
    writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), "old");
    const r = update(root);
    expect(r.result).toBe("current");
    expect(r.calls).toContain("pnpm install --frozen-lockfile");
  });

  it("origin/main が無ければ（fetch の対象に main が無い clone など）分岐と言わない", () => {
    const { root } = repos();
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    git(root, "config", "remote.origin.fetch", "+refs/heads/nothing:refs/remotes/origin/nothing");
    const r = update(root);
    expect(r.err).not.toContain("分かれています");
  });

  it("手元の main が分かれていれば取り込まない", () => {
    const { root, upstream } = repos();
    advance(upstream);
    commit(root, "b.txt", "local");
    const before = git(root, "rev-parse", "HEAD");
    const r = update(root);
    expect(r.result).toBe("blocked");
    expect(r.err).toContain("分かれています");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("手元が先に進んでいるだけなら何も出さない", () => {
    const { root } = repos();
    commit(root, "b.txt", "local");
    expect(update(root)).toMatchObject({ result: "ahead", err: "" });
  });

  it("fetch に失敗したら黙って今の版で起動する", () => {
    const { root } = repos();
    git(root, "remote", "set-url", "origin", join(root, "missing.git"));
    expect(update(root)).toMatchObject({ result: "offline", err: "" });
  });

  it("git には端末のプロンプトを出させず、GIT_DIR などを引き継がない", () => {
    const e = gitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_INDEX_FILE: "i", PATH: "/bin" });
    expect(e).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", PATH: "/bin" });
    expect(e.GIT_DIR).toBeUndefined();
    expect(e.GIT_WORK_TREE).toBeUndefined();
    expect(e.GIT_INDEX_FILE).toBeUndefined();
    expect(gitEnv({ GIT_SSH_COMMAND: "ssh -i k" }).GIT_SSH_COMMAND).toBe("ssh -i k");
  });

  it("Web アプリの目印は、生きているプロセスのものだけを数える", () => {
    const base = mkdtempSync(join(tmpdir(), "jpaper-web-"));
    dirs.push(base);
    expect(webRunning(base)).toBe(false);
    mkdirSync(join(base, WEB_PID_DIR));
    writeFileSync(join(base, WEB_PID_DIR, "999999"), "");
    expect(webRunning(base)).toBe(false);
    writeFileSync(join(base, WEB_PID_DIR, String(process.pid)), "");
    expect(webRunning(base)).toBe(true);
  });

  it("JPAPER_NO_UPDATE=1 か .git が無ければ git を呼ばない", () => {
    const calls = [];
    const run = (cmd) => (calls.push(cmd), { ok: true, stdout: "" });
    expect(selfUpdate({ root: "/x", env: { JPAPER_NO_UPDATE: "1" }, run, hasGit: true })).toBe("skipped");
    expect(selfUpdate({ root: "/x", env: {}, run, hasGit: false })).toBe("skipped");
    expect(calls).toEqual([]);
  });
});
