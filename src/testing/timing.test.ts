import { describe, it, expect } from "vitest";
import { budgetMs, fastestMs, WINDOWS_BUDGET_FACTOR } from "./timing.js";

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const burnCpu = (ms: number): void => {
  const started = process.cpuUsage();
  for (;;) {
    const used = process.cpuUsage(started);
    if ((used.user + used.system) / 1000 >= ms) return;
  }
};

describe("fastestMs", () => {
  it("CPU を使わずに待っている時間は数えない", () => {
    expect(fastestMs(1, () => sleep(300))).toBeLessThan(100);
  });

  it("CPU を使った時間を数える", () => {
    expect(fastestMs(1, () => burnCpu(150))).toBeGreaterThanOrEqual(150);
  });

  it("試行のうち最小の値を返す", () => {
    let calls = 0;
    const ms = fastestMs(3, () => {
      calls++;
      if (calls === 1) burnCpu(150);
    });
    expect(calls).toBe(3);
    expect(ms).toBeLessThan(100);
  });
});

describe("budgetMs", () => {
  it("POSIX では閾値をそのまま返す", () => {
    for (const platform of ["linux", "darwin"] as const) expect(budgetMs(2000, platform)).toBe(2000);
  });

  it("Windows では WINDOWS_BUDGET_FACTOR 倍に広げる", () => {
    expect(budgetMs(2000, "win32")).toBe(2000 * WINDOWS_BUDGET_FACTOR);
  });

  it("windows-latest の実測（main-tex 2,235ms・resolve 3,110ms）を元の閾値 2,000ms から広げた閾値が収める", () => {
    expect(2235).toBeLessThan(budgetMs(2000, "win32"));
    expect(3110).toBeLessThan(budgetMs(2000, "win32"));
    expect(516).toBeLessThan(budgetMs(500, "win32"));
  });

  it("引数を省くと実行中の OS で決まる", () => {
    expect(budgetMs(1000)).toBe(budgetMs(1000, process.platform));
  });
});
