import { describe, it, expect } from "vitest";
import { summarizeTrace } from "./analyze-trace.js";
import type { LlmCallRecord } from "../types/contract.js";

const rec = (over: Partial<LlmCallRecord>): LlmCallRecord => ({
  runId: "r",
  ts: "2026-07-22T00:00:00.000Z",
  provider: "claude",
  latencyMs: 10,
  ...over,
});

describe("summarizeTrace", () => {
  it("role 別・pass 別に集計しコスト降順で並べる", () => {
    const s = summarizeTrace([
      rec({ role: "translator", pass: 0, costUsd: 0.02, inputTokens: 100, outputTokens: 50 }),
      rec({ role: "evaluator", pass: 0, costUsd: 0.06, inputTokens: 200, outputTokens: 10 }),
      rec({ role: "translator", pass: 1, costUsd: 0.03, inputTokens: 120, outputTokens: 60 }),
    ]);
    expect(s.totalCalls).toBe(3);
    expect(s.totalCostUsd).toBeCloseTo(0.11);
    // evaluator が最コスト → 先頭
    expect(s.byRole[0]!.key).toBe("evaluator");
    expect(s.byRole[0]!.costUsd).toBeCloseTo(0.06);
    const tr = s.byRole.find((g) => g.key === "translator")!;
    expect(tr.calls).toBe(2);
    expect(tr.costUsd).toBeCloseTo(0.05);
    expect(tr.inputTokens).toBe(220);
    // pass 別
    expect(s.byPass).toEqual([
      { pass: 0, calls: 2, costUsd: expect.closeTo(0.08) },
      { pass: 1, calls: 1, costUsd: expect.closeTo(0.03) },
    ]);
    // 再訳の無駄
    expect(s.reviseCalls).toBe(1);
    expect(s.reviseCostUsd).toBeCloseTo(0.03);
  });

  it("cache 書込/読出比を出す（≈1 は毎回再キャッシュの兆候）", () => {
    const s = summarizeTrace([
      rec({ cacheReadTokens: 1000, cacheCreationTokens: 950 }),
      rec({ cacheReadTokens: 1000, cacheCreationTokens: 1050 }),
    ]);
    expect(s.cacheReadTokens).toBe(2000);
    expect(s.cacheCreationTokens).toBe(2000);
    expect(s.cacheWriteReadRatio).toBeCloseTo(1);
  });

  it("欠損フィールド・role/pass 無しに頑健（0 と unknown/pass0 に寄せる）", () => {
    const s = summarizeTrace([rec({}), rec({ costUsd: 0.01 })]);
    expect(s.totalCalls).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(0.01);
    expect(s.byRole[0]!.key).toBe("unknown");
    expect(s.byPass[0]).toEqual({ pass: 0, calls: 2, costUsd: expect.closeTo(0.01) });
    expect(s.cacheWriteReadRatio).toBeNull(); // cacheRead=0 → 比は null
  });

  it("空トレースでも落ちない", () => {
    const s = summarizeTrace([]);
    expect(s.totalCalls).toBe(0);
    expect(s.byRole).toEqual([]);
    expect(s.cacheWriteReadRatio).toBeNull();
  });
});
