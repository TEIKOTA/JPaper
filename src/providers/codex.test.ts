import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_DISABLED_FEATURES, codexEnv, makeCodexClient } from "./codex.js";
import { isTransient } from "../types/errors.js";
import type { LlmCallEvent } from "../types/contract.js";

const ISOLATED = [
  "exec",
  "--ephemeral",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  ...CODEX_DISABLED_FEATURES.flatMap((f) => ["-c", `features.${f}=false`]),
  "-c",
  'web_search="disabled"',
];

describe("makeCodexClient（契約付録 §5）", () => {
  it("利用者の設定・ルールを読まずに起動し、stdin で入力を渡して最終メッセージを返す", async () => {
    let args: string[] = [];
    let prompt = "";
    const c = makeCodexClient({}, {
      run: async (a, p) => {
        args = a;
        prompt = p;
        return "訳文";
      },
    });
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe("訳文");
    expect(args).toEqual(ISOLATED);
    expect(prompt).toContain("<system>\nSYS\n</system>");
    expect(prompt).toContain("<input>\nUSR\n</input>");
  });

  it("model・effort は指定したときだけ渡す（effort は model_reasoning_effort の設定値）", async () => {
    let args: string[] = [];
    const c = makeCodexClient({ model: "gpt-6.1-sol", effort: "low" }, {
      run: async (a) => {
        args = a;
        return "訳文";
      },
    });
    await c.complete({ system: "s", user: "u" });
    expect(args).toEqual([...ISOLATED, "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"']);
  });

  it("webSearch の呼び出しだけ Web 検索を live にする（シェル等は止めたまま。契約付録 §4）", async () => {
    const seen: string[][] = [];
    const c = makeCodexClient({}, { run: async (a) => (seen.push(a), "r") });
    await c.complete({ system: "s", user: "u", webSearch: true });
    await c.complete({ system: "s", user: "u" });
    expect(seen[0]).toEqual([...ISOLATED.slice(0, -1), 'web_search="live"']);
    expect(seen[1]).toEqual(ISOLATED);
  });

  it("ENOENT は非 transient の code 2", async () => {
    const c = makeCodexClient({}, {
      run: async () => {
        throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      },
    });
    const err = await c.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 2, kind: "provider" });
    expect(isTransient(err)).toBe(false);
  });

  it("非ゼロ終了は transient な provider 失敗", async () => {
    const c = makeCodexClient({}, {
      run: async () => {
        throw Object.assign(new Error("exit 1"), { code: 1 });
      },
    });
    const err = await c.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 2, kind: "provider" });
    expect(isTransient(err)).toBe(true);
  });

  it("成功呼び出しで meta と指定モデルをトレースに emit する", async () => {
    const events: LlmCallEvent[] = [];
    let t = 1000;
    const c = makeCodexClient({ model: "gpt-6.1-sol" }, {
      run: async () => "訳文",
      trace: (e) => events.push(e),
      now: () => (t += 40),
    });
    await c.complete({
      system: "s",
      user: "u",
      meta: { role: "translator", phase: "translate", segmentId: "s1", pass: 2 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      role: "translator",
      segmentId: "s1",
      pass: 2,
      latencyMs: 40,
    });
  });
});

describe("codexEnv", () => {
  it("CMUX_ で始まる環境変数だけを落とす", () => {
    expect(codexEnv({ PATH: "/bin", CMUX_SURFACE_ID: "x", CMUX_CODEX_HOOKS: "1", HOME: "/h" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    });
  });
});

describe("makeCodexClient（既定の run: PATH 上の codex を起動）", () => {
  const origPath = process.env.PATH;
  const origSurface = process.env.CMUX_SURFACE_ID;
  let root = "";
  const useFakeCodex = (name: string, body: string): void => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "codex"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${origPath ?? ""}`;
  };
  // -o の次の引数（最終メッセージの書き出し先）へ書く。
  const WRITE_LAST = 'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done';
  const leftovers = (): string[] => readdirSync(os.tmpdir()).filter((f) => f.startsWith("jpaper-codex-"));

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "jpaper-fakecodex-"));
  });
  afterEach(() => {
    process.env.PATH = origPath;
    if (origSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = origSurface;
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("一時ディレクトリで起動して -o のファイルから最終メッセージを読み、終わったら一時ディレクトリを消す", async () => {
    useFakeCodex(
      "ok",
      `${WRITE_LAST}\nn=$(wc -c | tr -d ' ')\nprintf 'stdin=%s cwd=%s cmux=%s' "$n" "$(basename "$(pwd -P)" | cut -c1-13)" "\${CMUX_SURFACE_ID:-none}" > "$out"`,
    );
    process.env.CMUX_SURFACE_ID = "surface-1";
    const before = leftovers();
    const out = await makeCodexClient().complete({ system: "S", user: "x".repeat(200_000) });
    expect(out).toMatch(/^stdin=2\d{5} cwd=jpaper-codex- cmux=none$/);
    expect(leftovers()).toEqual(before);
  });

  it("stdin を読まずに終了しても親プロセスを落とさず provider 失敗にし、一時ディレクトリを消す", async () => {
    useFakeCodex("early-exit", "echo 'error: unexpected argument' >&2\nexit 2");
    const before = leftovers();
    await expect(makeCodexClient().complete({ system: "S", user: "x".repeat(1_000_000) })).rejects.toMatchObject({
      kind: "provider",
    });
    expect(leftovers()).toEqual(before);
  });

  it("-o に書かずに終われば provider 失敗（transient）", async () => {
    useFakeCodex("no-output", "cat >/dev/null");
    const e = await makeCodexClient()
      .complete({ system: "S", user: "U" })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "provider" });
    expect(isTransient(e)).toBe(true);
    expect(String((e as Error).message)).toContain("最終メッセージを書き出しませんでした");
  });

  it("画像は一時ディレクトリに書いて --image で渡す（契約付録 §8 PDF 入力）", async () => {
    useFakeCodex(
      "image",
      `${WRITE_LAST}\ncat >/dev/null\nimg=""; for a in "$@"; do case "$a" in --image=*) img="\${a#--image=}";; esac; done\nprintf 'image=%s' "$(cat "$img")" > "$out"`,
    );
    const before = leftovers();
    const out = await makeCodexClient().complete({
      system: "S",
      user: "U",
      images: [{ mediaType: "image/png", data: Buffer.from("PNGDATA") }],
    });
    expect(out).toBe("image=PNGDATA");
    expect(leftovers()).toEqual(before);
  });

  it("stderr が多くても成功した呼び出しは落とさない", async () => {
    useFakeCodex("noisy", `${WRITE_LAST}\ncat >/dev/null\nhead -c 3000000 /dev/zero | tr '\\0' 'e' >&2\nprintf '訳文' > "$out"`);
    expect(await makeCodexClient().complete({ system: "S", user: "U" })).toBe("訳文");
  });

  it("中断で子プロセスを止め、canceled で返す", async () => {
    useFakeCodex("slow", "cat >/dev/null\nexec sleep 30");
    const ac = new AbortController();
    const p = makeCodexClient().complete({ system: "S", user: "U", signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ kind: "canceled" });
  });

  it("PATH に codex が無ければ再試行しない provider 失敗", async () => {
    process.env.PATH = path.join(root, "nothing-here");
    const e = await makeCodexClient()
      .complete({ system: "S", user: "x".repeat(200_000) })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "provider" });
    expect(isTransient(e)).toBe(false);
    expect(existsSync(path.join(root, "nothing-here"))).toBe(false);
  });
});
