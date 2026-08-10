import { describe, it, expect, vi } from "vitest";
import { fetchArxivSource } from "./arxiv.js";

function okResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(body, "utf8"),
  } as unknown as Response;
}

describe("fetchArxivSource", () => {
  it("成功時に Buffer を返し User-Agent を付与する", async () => {
    const fetchImpl = vi.fn(async () => okResponse("SRC"));
    const buf = await fetchArxivSource("1706.03762", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      state: { lastRequestAt: 0 },
      now: () => 100000,
    });
    expect(buf.toString("utf8")).toBe("SRC");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/e-print/1706.03762");
    expect((init as RequestInit).headers).toMatchObject({
      "User-Agent": expect.stringContaining("JPaper"),
    });
  });

  it("直近リクエストから3秒未満なら待機する", async () => {
    const sleep = vi.fn(async () => {});
    const state = { lastRequestAt: 1000 };
    await fetchArxivSource("2203.06060", {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => 2000,
      sleep,
      minIntervalMs: 3000,
      state,
    });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(state.lastRequestAt).toBe(4000);
  });

  it("発火が遅延したら lastRequestAt を実時刻に補正する", async () => {
    let t = 0;
    const state = { lastRequestAt: 0 };
    await fetchArxivSource("2203.06060", {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => t,
      sleep: async () => {
        t = 6000; // 予定の 3000 を超えて遅延復帰
      },
      minIntervalMs: 3000,
      state,
    });
    expect(state.lastRequestAt).toBe(6000);
  });

  it("並行呼び出しでもスロットを予約して直列化する", async () => {
    const state = { lastRequestAt: 0 };
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const common = {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => 0,
      sleep,
      minIntervalMs: 3000,
      state,
    };
    await Promise.all([
      fetchArxivSource("2203.06060", common),
      fetchArxivSource("2203.06060", common),
    ]);
    expect(state.lastRequestAt).toBe(6000);
    expect(waits).toEqual([3000, 6000]);
  });

  it("間隔が空いていれば待機しない", async () => {
    const sleep = vi.fn(async () => {});
    await fetchArxivSource("2203.06060", {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => 99999,
      sleep,
      minIntervalMs: 3000,
      state: { lastRequestAt: 0 },
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("一時的な 5xx はバックオフ再試行する", async () => {
    const statuses = [503, 503, 200];
    const fetchImpl = vi.fn(async () => {
      const s = statuses.shift()!;
      return s === 200 ? okResponse("SRC") : ({ ok: false, status: s } as Response);
    });
    const buf = await fetchArxivSource("2203.06060", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 1e9,
      state: { lastRequestAt: 0 },
    });
    expect(buf.toString("utf8")).toBe("SRC");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("リトライ上限超過（429 継続）は exit 2", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
    await expect(
      fetchArxivSource("2203.06060", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
        now: () => 1e9,
        retries: 2,
        state: { lastRequestAt: 0 },
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("恒久エラー（404）は再試行せず exit 2", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    await expect(
      fetchArxivSource("2203.06060", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
        now: () => 1e9,
        state: { lastRequestAt: 0 },
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HTTP エラー・ネットワーク例外は exit 2", async () => {
    await expect(
      fetchArxivSource("2203.06060", {
        fetchImpl: (async () =>
          ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch,
        state: { lastRequestAt: 0 },
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 2 });

    await expect(
      fetchArxivSource("2203.06060", {
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
        state: { lastRequestAt: 0 },
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
