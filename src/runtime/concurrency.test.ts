import { describe, it, expect } from "vitest";
import {
  makeGate,
  withGate,
  resolveMaxLlmConcurrency,
  DEFAULT_MAX_LLM_CONCURRENCY,
  MAX_LLM_CONCURRENCY_CAP,
  llmGate,
  setLlmGate,
  resolveMaxLlmQueue,
  DEFAULT_MAX_LLM_QUEUE,
  MAX_LLM_QUEUE_CAP,
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
  it("env で上書きできる（10 進整数のみ）", () => {
    expect(resolveMaxLlmConcurrency({})).toBe(DEFAULT_MAX_LLM_CONCURRENCY);
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "3" })).toBe(3);
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: " 3 " })).toBe(3);
  });

  it("整数でない値は既定へ落ちる（指数・16 進で上限を無効化させない）", () => {
    for (const bad of ["abc", "1e9", "0x10", "Infinity", "-1", "2.5", ""]) {
      expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: bad })).toBe(
        DEFAULT_MAX_LLM_CONCURRENCY,
      );
    }
  });

  it("範囲外は既定ではなく端へ丸める（設定ミスが緩める方向に倒れない）", () => {
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "0" })).toBe(1);
    expect(resolveMaxLlmConcurrency({ JPAPER_MAX_LLM_CONCURRENCY: "1000000000" })).toBe(
      MAX_LLM_CONCURRENCY_CAP,
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

describe("待機解除後の再検査（barge-in で上限を破らせない）", () => {
  it("release と待機者の再開の間に新規到着が割り込んでも上限を超えない", async () => {
    const gate = makeGate(1);
    const a = defer();
    const q = defer();
    const never = new Promise<void>(() => {});

    void gate.run(() => a.promise); // A: 枠を取る
    void gate.run(() => never); // B: 待ち行列へ
    // A の release と B の再開の間に走る microtask から新規投入する。
    void q.promise.then(() => {
      void gate.run(() => never); // C
    });
    a.resolve();
    q.resolve();

    await new Promise((r) => setTimeout(r, 20));
    expect(gate.active()).toBeLessThanOrEqual(gate.limit);
  });
});

describe("待ち行列の上限", () => {
  it("上限に達したら busy で即断る（返らないリクエストを積み上げない）", async () => {
    const gate = makeGate(1, 2);
    const held = gate.run(() => new Promise<void>(() => undefined));
    await Promise.resolve();
    const w1 = gate.run(async () => "a");
    const w2 = gate.run(async () => "b");
    await Promise.resolve();
    expect(gate.waiting()).toBe(2);
    await expect(gate.run(async () => "c")).rejects.toMatchObject({ kind: "busy", code: 2 });
    void held;
    void w1;
    void w2;
  });

  it("上限は 10 進整数だけ受け付け、範囲外は端へ丸める", () => {
    expect(resolveMaxLlmQueue({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_LLM_QUEUE);
    expect(resolveMaxLlmQueue({ JPAPER_MAX_LLM_QUEUE: "1e9" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_LLM_QUEUE,
    );
    expect(resolveMaxLlmQueue({ JPAPER_MAX_LLM_QUEUE: "99999" } as NodeJS.ProcessEnv)).toBe(
      MAX_LLM_QUEUE_CAP,
    );
    expect(resolveMaxLlmQueue({ JPAPER_MAX_LLM_QUEUE: "0" } as NodeJS.ProcessEnv)).toBe(1);
  });
});

describe("中断済み待機者の掃除", () => {
  it("待ち行列から取り除き、上限判定を汚さない", async () => {
    const gate = makeGate(1, 2);
    const held = gate.run(() => new Promise<void>(() => undefined));
    await Promise.resolve();

    const c = new AbortController();
    const doomed = [
      gate.run(async () => "a", c.signal).catch(() => "canceled"),
      gate.run(async () => "b", c.signal).catch(() => "canceled"),
    ];
    await Promise.resolve();
    expect(gate.waiting()).toBe(2);
    c.abort();
    expect(await Promise.all(doomed)).toEqual(["canceled", "canceled"]);
    expect(gate.waiting()).toBe(0);

    // 墓標が残っていれば、ここで busy になる（待ち行列は本当は空）。
    const next = gate.run(async () => "ok").catch((e: unknown) => e);
    await Promise.resolve();
    expect(gate.waiting()).toBe(1);
    void held;
    void next;
  });
});
