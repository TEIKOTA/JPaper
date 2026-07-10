import { describe, it, expect } from "vitest";
import { withRetry } from "./session.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("成功はそのまま返す", async () => {
    expect(await withRetry(async () => 42, { sleep: noSleep })).toBe(42);
  });

  it("一時エラーはリトライして成功", async () => {
    let n = 0;
    const r = await withRetry(
      async () => {
        if (n++ < 2) throw { code: "ETIMEDOUT" };
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("非一時エラーは即 throw（リトライしない）", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("task failed");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("task failed");
    expect(n).toBe(1);
  });

  it("上限超過は最後の一時エラーを throw", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw { code: "ECONNRESET" };
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(n).toBe(3);
  });

  it("バックオフは初期1s×2・上限10s", async () => {
    const waits: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (n++ < 4) throw { code: "ETIMEDOUT" };
        return 1;
      },
      { retries: 5, capMs: 10000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });
});
