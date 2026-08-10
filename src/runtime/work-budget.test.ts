import { describe, it, expect } from "vitest";
import { withCallBudget, resolveWorkLimits, DEFAULT_WORK_LIMITS } from "./work-budget.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

describe("withCallBudget", () => {
  it("上限までは通し、超えたら too-large で落とす", async () => {
    const c = withCallBudget(new FakeLlmClient(() => "ok"), 2);
    expect(await c.complete({ system: "s", user: "u" })).toBe("ok");
    expect(await c.complete({ system: "s", user: "u" })).toBe("ok");
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      kind: "too-large",
      code: 2,
    });
  });

  it("失敗した呼び出しも数える（課金されるのは試行回数）", async () => {
    let n = 0;
    const c = withCallBudget(
      {
        complete: () => {
          n++;
          return Promise.reject(new Error("boom"));
        },
      },
      1,
    );
    await c.complete({ system: "s", user: "u" }).catch(() => {});
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      kind: "too-large",
    });
    expect(n).toBe(1); // 2 回目は下位まで届かない
  });

  it("上限は run ごとに独立（ラッパを作り直せば数え直す）", async () => {
    const base = new FakeLlmClient(() => "ok");
    const a = withCallBudget(base, 1);
    await a.complete({ system: "s", user: "u" });
    const b = withCallBudget(base, 1);
    expect(await b.complete({ system: "s", user: "u" })).toBe("ok");
  });
});

describe("resolveWorkLimits", () => {
  it("未指定は既定、部分指定はその項目だけ差し替える", () => {
    expect(resolveWorkLimits()).toEqual(DEFAULT_WORK_LIMITS);
    expect(resolveWorkLimits({ maxSegments: 3 })).toEqual({
      ...DEFAULT_WORK_LIMITS,
      maxSegments: 3,
    });
  });

  it("既定値は実論文（35 セグメント / 96 呼び出し）に十分な余裕がある", () => {
    expect(DEFAULT_WORK_LIMITS.maxSegments).toBeGreaterThan(35 * 2);
    expect(DEFAULT_WORK_LIMITS.maxLlmCalls).toBeGreaterThan(96 * 2);
  });
});
