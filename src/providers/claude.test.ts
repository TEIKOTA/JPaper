import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeClaudeClient, MAX_TURNS } from "./claude.js";
import { isTransient } from "../types/errors.js";
import type { LlmCallEvent } from "../types/contract.js";

describe("makeClaudeClient", () => {
  it("result を抽出し・必須フラグを渡し・model は渡さない", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({
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
  });

  it("プロンプト本文は引数に入れず stdin で渡す", async () => {
    let args: string[] = [];
    let input = "";
    const c = makeClaudeClient({
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
    const c = makeClaudeClient({ run: async (a) => ((args = a), JSON.stringify({ result: "r" })) });
    await c.complete({ system: "s", user: "u" });
    expect(args[args.indexOf("--max-turns") + 1]).toBe(String(MAX_TURNS));
    expect(MAX_TURNS).toBeGreaterThanOrEqual(2);
    expect(args[args.indexOf("--tools") + 1]).toBe("none"); // 安全境界はツール禁止が担う
  });

  it("jsonMode は無視する（claude CLI にネイティブ機能が無く CLI フラグを増やさない）", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({
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
    const c = makeClaudeClient({ run: async () => "not json" });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 2, kind: "provider" });
    await c.complete({ system: "s", user: "u" }).catch((e) => expect(isTransient(e)).toBe(true));
  });

  it("result 欠如は非 transient な provider 失敗（契約不一致＝retry せず即 surface）", async () => {
    const c = makeClaudeClient({ run: async () => JSON.stringify({ foo: "bar" }) });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 2, kind: "provider" });
    await c.complete({ system: "s", user: "u" }).catch((e) => expect(isTransient(e)).toBe(false));
  });

  it("ENOENT（未インストール）は非 transient の code 2", async () => {
    const c = makeClaudeClient({
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

  it("成功呼び出しで usage/コスト/latency/meta をトレースに emit する", async () => {
    const events: LlmCallEvent[] = [];
    let t = 1000;
    const c = makeClaudeClient({
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

  it("失敗パス（result 欠如）ではトレースを emit しない", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeClaudeClient({
      run: async () => JSON.stringify({ foo: "bar" }),
      trace: (e) => events.push(e),
    });
    await c.complete({ system: "s", user: "u" }).catch(() => {});
    expect(events).toHaveLength(0);
  });

  it("usage 欠損の応答でもトレースは emit（数値フィールドは未定義）", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeClaudeClient({
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
      const c = makeClaudeClient({
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "claude"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
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
    useFakeClaude("echo", `n=$(wc -c | tr -d ' ')\nprintf '{"result":"stdin=%s argc=%s"}' "$n" "$#"`);
    const user = "x".repeat(200_000);
    const c = makeClaudeClient();
    expect(await c.complete({ system: "SYS", user })).toBe("stdin=200000 argc=9");
  });

  it("stdin を読まずに終了しても親プロセスを落とさず provider 失敗にする", async () => {
    useFakeClaude("early-exit", "exit 3");
    const c = makeClaudeClient();
    await expect(c.complete({ system: "SYS", user: "x".repeat(1_000_000) })).rejects.toMatchObject({
      code: 2,
      kind: "provider",
    });
  });
});
