import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { usedModel, makeClaudeClient, MAX_TURNS, WEB_SEARCH_MAX_TURNS } from "./claude.js";
import { isTransient } from "../types/errors.js";
import type { LlmCallEvent } from "../types/contract.js";
import { writeFakeCli } from "../testing/fake-cli.js";
import { ShimError } from "../../bin/spawn-cli.mjs";

describe("makeClaudeClient", () => {
  it("result を抽出し・必須フラグを渡し・未指定なら model / effort は渡さない", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({}, {
      run: async (a) => {
        args = a;
        return JSON.stringify({ result: "訳文" });
      },
    });
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe("訳文");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--tools");
    expect(args).toContain("none");
    expect(args).toContain("SYS");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });

  it("指定された model / effort を claude CLI の引数で渡す", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({ model: "sonnet", effort: "medium" }, {
      run: async (a) => {
        args = a;
        return JSON.stringify({ result: "訳文" });
      },
    });
    await c.complete({ system: "SYS", user: "USR" });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });

  it("片方だけ指定したら、その片方だけを渡す", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({ effort: "high" }, {
      run: async (a) => {
        args = a;
        return JSON.stringify({ result: "訳文" });
      },
    });
    await c.complete({ system: "SYS", user: "USR" });
    expect(args).not.toContain("--model");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("プロンプト本文は引数に入れず stdin で渡す", async () => {
    let args: string[] = [];
    let input = "";
    const c = makeClaudeClient({}, {
      run: async (a, i) => {
        args = a;
        input = i;
        return JSON.stringify({ result: "訳文" });
      },
    });
    await c.complete({ system: "SYS", user: "USR" });
    expect(input).toBe("USR");
    expect(args).not.toContain("USR");
  });

  it("プロンプト本文は引数に入れず stdin で渡す", async () => {
    let args: string[] = [];
    let input = "";
    const c = makeClaudeClient({}, {
      run: async (a, i) => {
        args = a;
        input = i;
        return JSON.stringify({ result: "訳文" });
      },
    });
    await c.complete({ system: "SYS", user: "USR" });
    expect(input).toBe("USR");
    expect(args).not.toContain("USR");
  });

  it("--max-turns は 2 ターン以上（CLI が内部で 2 ターン使っても error_max_turns で落とさない）", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({}, { run: async (a) => ((args = a), JSON.stringify({ result: "r" })) });
    await c.complete({ system: "s", user: "u" });
    expect(args[args.indexOf("--max-turns") + 1]).toBe(String(MAX_TURNS));
    expect(MAX_TURNS).toBeGreaterThanOrEqual(2);
    expect(args[args.indexOf("--tools") + 1]).toBe("none"); // 安全境界はツール禁止が担う
  });

  it("webSearch の呼び出しだけ WebSearch を許し、ターン上限を広げる（契約付録 §4）", async () => {
    const seen: string[][] = [];
    const c = makeClaudeClient({}, { run: async (a) => (seen.push(a), JSON.stringify({ result: "r" })) });
    await c.complete({ system: "s", user: "u", webSearch: true });
    await c.complete({ system: "s", user: "u" });
    const [web, plain] = seen as [string[], string[]];
    expect(web[web.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(web[web.indexOf("--max-turns") + 1]).toBe(String(WEB_SEARCH_MAX_TURNS));
    expect(web).toContain("--safe-mode");
    expect(web[web.indexOf("--allowedTools") + 1]).toBe("WebSearch");
    expect(plain).not.toContain("--allowedTools");
    expect(plain[plain.indexOf("--tools") + 1]).toBe("none");
    expect(plain[plain.indexOf("--max-turns") + 1]).toBe(String(MAX_TURNS));
  });

  it("jsonMode は無視する（claude CLI にネイティブ機能が無く CLI フラグを増やさない）", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({}, {
      run: async (a) => {
        args = a;
        return JSON.stringify({ result: "訳文" });
      },
    });
    await c.complete({ system: "s", user: "u", jsonMode: true });
    expect(args).not.toContain("--format");
    expect(args.filter((a) => a === "--output-format")).toHaveLength(1); // 既存の envelope 用のみ
  });

  it("非 JSON 応答は transient な provider 失敗（withRetry 対象）", async () => {
    const c = makeClaudeClient({}, { run: async () => "not json" });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 2, kind: "provider" });
    await c.complete({ system: "s", user: "u" }).catch((e) => expect(isTransient(e)).toBe(true));
  });

  it("result 欠如は非 transient な provider 失敗（契約不一致＝retry せず即 surface）", async () => {
    const c = makeClaudeClient({}, { run: async () => JSON.stringify({ foo: "bar" }) });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 2, kind: "provider" });
    await c.complete({ system: "s", user: "u" }).catch((e) => expect(isTransient(e)).toBe(false));
  });

  it("ENOENT（未インストール）は非 transient の code 2", async () => {
    const c = makeClaudeClient({}, {
      run: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    });
    try {
      await c.complete({ system: "s", user: "u" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
      expect(isTransient(e)).toBe(false);
    }
  });

  it("shim を解けない（ShimError）ときは理由つきの非 transient の code 2", async () => {
    const c = makeClaudeClient({}, {
      run: async () => {
        throw new ShimError("C:\\npm\\claude.cmd を直接起動できません（環境変数を設定する shim）");
      },
    });
    const err = await c.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 2, kind: "provider", message: expect.stringContaining("環境変数を設定する shim") });
    expect(isTransient(err)).toBe(false);
  });

  it("成功呼び出しで usage/コスト/latency/meta をトレースに emit する", async () => {
    const events: LlmCallEvent[] = [];
    let t = 1000;
    const c = makeClaudeClient({}, {
      run: async () =>
        JSON.stringify({
          result: "訳文",
          model: "claude-x",
          num_turns: 1,
          total_cost_usd: 0.0123,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 7,
          },
        }),
      trace: (e) => events.push(e),
      now: () => (t += 40), // started→completed で 40ms 経過
    });
    await c.complete({
      system: "s",
      user: "u",
      meta: { role: "translator", phase: "translate", segmentId: "s1", pass: 2 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "claude",
      role: "translator",
      phase: "translate",
      segmentId: "s1",
      pass: 2,
      model: "claude-x",
      numTurns: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
      costUsd: 0.0123,
      latencyMs: 40,
    });
  });

  it("別名で呼んだときは modelUsage の鍵（実際に使われたモデル）をトレースの model にする", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeClaudeClient({ model: "sonnet" }, {
      run: async () => JSON.stringify({ result: "訳文", modelUsage: { "claude-sonnet-5-5": { costUSD: 0.01 } } }),
      trace: (e) => events.push(e),
    });
    await c.complete({ system: "s", user: "u" });
    expect(events[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("modelUsage に複数のモデルがあれば出力トークン（無ければ費用）が最大のものを選び、配列は無視する", () => {
    expect(
      usedModel({
        "claude-haiku-4-5": { outputTokens: 21, costUSD: 0.001 },
        "claude-sonnet-5-5": { outputTokens: 3000, costUSD: 0.02 },
      }),
    ).toBe("claude-sonnet-5-5");
    expect(usedModel({ a: { costUSD: 0.001 }, b: { costUSD: 0.05 } })).toBe("b");
    expect(usedModel(["x"])).toBeUndefined();
    expect(usedModel(null)).toBeUndefined();
    expect(usedModel({})).toBeUndefined();
  });

  it("失敗パス（result 欠如）ではトレースを emit しない", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeClaudeClient({}, {
      run: async () => JSON.stringify({ foo: "bar" }),
      trace: (e) => events.push(e),
    });
    await c.complete({ system: "s", user: "u" }).catch(() => {});
    expect(events).toHaveLength(0);
  });

  it("usage 欠損の応答でもトレースは emit（数値フィールドは未定義）", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeClaudeClient({}, {
      run: async () => JSON.stringify({ result: "訳文" }),
      trace: (e) => events.push(e),
    });
    await c.complete({ system: "s", user: "u", meta: { role: "evaluator" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.role).toBe("evaluator");
    expect(events[0]!.inputTokens).toBeUndefined();
    expect(events[0]!.costUsd).toBeUndefined();
  });

  it("非ゼロ終了・タイムアウトは transient な code 2（withRetry 対象）", async () => {
    for (const thrown of [Object.assign(new Error("exit 1"), { code: 1 }), { code: "ETIMEDOUT" }]) {
      const c = makeClaudeClient({}, {
        run: async () => {
          throw thrown;
        },
      });
      try {
        await c.complete({ system: "s", user: "u" });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as { code: number }).code).toBe(2);
        expect(isTransient(e)).toBe(true);
      }
    }
  });
});

describe("makeClaudeClient（既定の run: PATH 上の claude を起動）", () => {
  const origPath = process.env.PATH;
  let root = "";
  const useFakeClaude = (name: string, body: string): void => {
    const dir = path.join(root, name);
    writeFakeCli(dir, "claude", body);
    process.env.PATH = `${dir}${path.delimiter}${origPath ?? ""}`;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "jpaper-claude-"));
  });
  afterEach(() => {
    process.env.PATH = origPath;
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("大きなプロンプト本文を stdin で子プロセスへ渡し、引数には載せない", async () => {
    useFakeClaude(
      "echo",
      `const n = (await readStdin()).length;\nprocess.stdout.write(JSON.stringify({ result: \`stdin=\${n} argc=\${args.length}\` }));`,
    );
    const user = "x".repeat(200_000);
    const c = makeClaudeClient();
    expect(await c.complete({ system: "SYS", user })).toBe("stdin=200000 argc=10");
  });

  it("repo の外（os.tmpdir()）で --safe-mode 付きで起動し、利用者・プロジェクトの設定や hook を読ませない", async () => {
    useFakeClaude(
      "where",
      `await readStdin();\nconst safe = args.includes("--safe-mode") ? "yes" : "no";\n` +
        `process.stdout.write(JSON.stringify({ result: \`cwd=\${fs.realpathSync.native(process.cwd())} safe=\${safe}\` }));`,
    );
    const c = makeClaudeClient();
    const tmp = realpathSync.native(os.tmpdir());
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe(`cwd=${tmp} safe=yes`);
  });

  it("画像は stream-json の入力で渡し、出力の result 行を読む（契約付録 §8 PDF 入力）", async () => {
    useFakeClaude(
      "image",
      `const input = String(await readStdin());\nconst fmt = argAfter("--input-format") ?? "";\n` +
        `const img = /"type":"image".*UE5HREFUQQ==/s.test(input) ? "yes" : "no";\n` +
        `process.stdout.write('{"type":"system"}\\n' + JSON.stringify({ type: "result", result: \`fmt=\${fmt} img=\${img}\`, total_cost_usd: 0.03 }) + "\\n");`,
    );
    const c = makeClaudeClient();
    const out = await c.complete({
      system: "SYS",
      user: "USR",
      images: [{ mediaType: "image/png", data: Buffer.from("PNGDATA") }],
    });
    expect(out).toBe("fmt=stream-json img=yes");
  });

  it("stdin を読まずに終了しても親プロセスを落とさず provider 失敗にする", async () => {
    useFakeClaude("early-exit", "process.exit(3);");
    const c = makeClaudeClient();
    await expect(c.complete({ system: "SYS", user: "x".repeat(1_000_000) })).rejects.toMatchObject({
      code: 2,
      kind: "provider",
    });
  });
});
