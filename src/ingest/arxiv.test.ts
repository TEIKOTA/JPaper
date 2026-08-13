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

  it("本体受信中の切断（undici の terminated）も再試行する", async () => {
    // 実測: 1 回目の実行が `arXiv 取得に失敗: terminated` で即死した。直後に curl で
    // 同じ URL を 5.8 秒で取得できたので、再試行すれば通る種類の失敗だった。
    let first = true;
    const fetchImpl = vi.fn(async () => {
      if (first) {
        first = false;
        throw new TypeError("terminated");
      }
      return okResponse("SRC");
    });
    const buf = await fetchArxivSource("2203.06060", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 1e9,
      state: { lastRequestAt: 0 },
    });
    expect(buf.toString("utf8")).toBe("SRC");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

describe("待ち行列の上限と中断", () => {
  const common = {
    fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
    now: () => 0,
    sleep: async () => {},
    minIntervalMs: 3000,
  };

  it("待ち時間が上限を超えるなら待たずに失敗する（無言で数分待たない）", async () => {
    const state = { lastRequestAt: 30_000 }; // 既に 30 秒先まで予約済み
    await expect(
      fetchArxivSource("2203.06060", { ...common, state, maxQueueWaitMs: 10_000 }),
    ).rejects.toMatchObject({ code: 2, kind: "busy" });
    // 断ったぶんで待ち行列をさらに伸ばさない。
    expect(state.lastRequestAt).toBe(30_000);
  });

  it("上限内なら従来どおり待って取得する", async () => {
    const state = { lastRequestAt: 3000 };
    const buf = await fetchArxivSource("2203.06060", {
      ...common,
      state,
      maxQueueWaitMs: 10_000,
    });
    expect(buf.toString("utf8")).toBe("S");
  });

  it("待機中に abort されたら中断として抜ける", async () => {
    const c = new AbortController();
    const state = { lastRequestAt: 5000 };
    const p = fetchArxivSource("2203.06060", {
      ...common,
      state,
      sleep: () => new Promise<void>(() => {}), // 永久に待つ
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 6, kind: "canceled" });
  });

  it("abort 済みなら fetch を 1 度も呼ばない", async () => {
    const c = new AbortController();
    c.abort();
    const fetchImpl = vi.fn(async () => okResponse("S"));
    await expect(
      fetchArxivSource("2203.06060", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        state: { lastRequestAt: 0 },
        signal: c.signal,
      }),
    ).rejects.toMatchObject({ kind: "canceled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("中断時の予約の巻き戻し", () => {
  it("待機中に中断されたら予約を返す（他のリクエストの待ちを伸ばさない）", async () => {
    const state = { lastRequestAt: 5000 };
    const c = new AbortController();
    const p = fetchArxivSource("2203.06060", {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => 0,
      sleep: () => new Promise<void>(() => {}),
      minIntervalMs: 3000,
      state,
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toMatchObject({ kind: "canceled" });
    // 予約を残すと、接続してすぐ切るだけで待ち行列を伸ばせる（fetch は 1 度も起きない）。
    expect(state.lastRequestAt).toBe(5000);
  });

  it("中断が連続しても正当なリクエストが締め出されない", async () => {
    const state = { lastRequestAt: 0 };
    const common = {
      fetchImpl: (async () => okResponse("S")) as unknown as typeof fetch,
      now: () => 0,
      minIntervalMs: 3000,
      maxQueueWaitMs: 10_000,
      state,
    };
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      const p = fetchArxivSource("2203.06060", {
        ...common,
        sleep: () => new Promise<void>(() => {}),
        signal: c.signal,
      });
      c.abort();
      await expect(p).rejects.toMatchObject({ kind: "canceled" });
    }
    const buf = await fetchArxivSource("2203.06060", { ...common, sleep: async () => {} });
    expect(buf.toString("utf8")).toBe("S");
  });
});
