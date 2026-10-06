import { describe, it, expect } from "vitest";
import {
  withCallBudget,
  resolveWorkLimits,
  DEFAULT_WORK_LIMITS,
  WORK_LIMIT_CAPS,
} from "./work-budget.js";
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

describe("上限の解決はフェイルオープンしない", () => {
  it("明示的な undefined が既定値を消さない", () => {
    // web が work: { maxSegments: plan.maxSegments } と書き、plan に項目が無い場合。
    expect(
      resolveWorkLimits({ maxSegments: undefined, maxLlmCalls: undefined }),
    ).toEqual(DEFAULT_WORK_LIMITS);
  });

  it("不正値は既定へ落とし、過大な値は上限の上限で切る", () => {
    for (const bad of [NaN, Infinity, -5, 0, "10" as unknown as number]) {
      expect(resolveWorkLimits({ maxSegments: bad }).maxSegments).toBe(
        DEFAULT_WORK_LIMITS.maxSegments,
      );
    }
    expect(resolveWorkLimits({ maxLlmCalls: 1e9 }).maxLlmCalls).toBe(WORK_LIMIT_CAPS.maxLlmCalls);
    expect(resolveWorkLimits({ maxSegments: 7.9 }).maxSegments).toBe(7);
  });

  it("withCallBudget に壊れた上限を渡しても数え続ける", async () => {
    const c = withCallBudget(new FakeLlmClient(() => "ok"), NaN);
    // NaN との比較は常に false なので、素朴な実装では無制限になる。
    for (let i = 0; i < DEFAULT_WORK_LIMITS.maxLlmCalls; i++) {
      await c.complete({ system: "s", user: "u" });
    }
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      kind: "too-large",
    });
  });
});
