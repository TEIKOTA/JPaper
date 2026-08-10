import { describe, it, expect } from "vitest";
import {
  makeGate,
  withGate,
  resolveMaxLlmConcurrency,
  DEFAULT_MAX_LLM_CONCURRENCY,
  llmGate,
  setLlmGate,
} from "./concurrency.js";
import type { LlmClient } from "../types/contract.js";

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("makeGate", () => {
  it("同時に走る本数が上限を超えない", async () => {
    const gate = makeGate(2);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => defer());
    const runs = gates.map((d) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await d.promise;
        active--;
      }),
    );
    await Promise.resolve();
    expect(gate.active()).toBe(2);
    expect(gate.waiting()).toBe(4);
    for (const d of gates) d.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(gate.active()).toBe(0);
  });

  it("失敗しても枠を返す（1 本の例外で詰まらない）", async () => {
    const gate = makeGate(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("上限は 1 未満にならない", () => {
    expect(makeGate(0).limit).toBe(1);
    expect(makeGate(-5).limit).toBe(1);
  });
});

describe("resolveMaxLlmConcurrency", () => {
  it("env で上書きでき、不正値は既定へ落ちる", () => {
    expect(resolveMaxLlmConcurrency({})).toBe(DEFAULT_MAX_LLM_CONCURRENCY);
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "3" })).toBe(3);
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "0" })).toBe(
      DEFAULT_MAX_LLM_CONCURRENCY,
    );
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "abc" })).toBe(
      DEFAULT_MAX_LLM_CONCURRENCY,
    );
  });

  it("プロセス全体で同じゲートを共有する（リクエストをまたいで効く）", () => {
    setLlmGate(undefined);
    expect(llmGate()).toBe(llmGate());
    setLlmGate(undefined);
  });
});

describe("withGate", () => {
  it("複数の run が同じゲートを共有すると全体の同時実行が抑えられる", async () => {
    const gate = makeGate(2);
    let active = 0;
    let peak = 0;
    const base: LlmClient = {
      complete: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return "{}";
      },
    };
    // 別々のリクエストを模して 2 つのクライアントを作り、同じゲートに載せる。
    const a = withGate(base, gate);
    const b = withGate(base, gate);
    await Promise.all([
      ...Array.from({ length: 5 }, () => a.complete({ system: "s", user: "u" })),
      ...Array.from({ length: 5 }, () => b.complete({ system: "s", user: "u" })),
    ]);
    expect(peak).toBe(2);
  });
});
