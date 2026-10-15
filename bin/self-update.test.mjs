// 契約付録 §5（起動時の更新）。issue #420
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selfUpdate } from "./self-update.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
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
  return { root, upstream };
}
const advance = (upstream, file = "a.txt", text = "2") => {
  commit(upstream, file, text);
  git(upstream, "push", "--quiet", "origin", "main");
};

function update(root, env = {}) {
  let err = "";
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "pnpm") return { ok: true, stdout: "" };
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: opts.timeout });
    return { ok: r.error === undefined && r.status === 0, stdout: (r.stdout ?? "").trim() };
  };
  const result = selfUpdate({ root, env, run, stderr: (s) => (err += s), hasGit: true });
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

  it("main 以外の branch にいれば取り込まない", () => {
    const { root, upstream } = repos();
    advance(upstream);
    git(root, "checkout", "--quiet", "-b", "feat/x");
    const r = update(root);
    expect(r.result).toBe("blocked");
    expect(r.err).toContain("feat/x");
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

  it("JPAPER_NO_UPDATE=1 か .git が無ければ git を呼ばない", () => {
    const calls = [];
    const run = (cmd) => (calls.push(cmd), { ok: true, stdout: "" });
    expect(selfUpdate({ root: "/x", env: { JPAPER_NO_UPDATE: "1" }, run, hasGit: true })).toBe("skipped");
    expect(selfUpdate({ root: "/x", env: {}, run, hasGit: false })).toBe("skipped");
    expect(calls).toEqual([]);
  });
});
