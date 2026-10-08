import { describe, it, expect } from "vitest";
import { makeCodexClient } from "./codex.js";
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
