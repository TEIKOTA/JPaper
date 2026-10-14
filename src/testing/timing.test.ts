import { describe, it, expect } from "vitest";
import { fastestMs } from "./timing.js";

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
