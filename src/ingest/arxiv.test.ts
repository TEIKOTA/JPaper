import { describe, it, expect, vi } from "vitest";
import { fetchArxivSource } from "./arxiv.js";
import { DEFAULT_LIMITS } from "./limits.js";

function okResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(body, "utf8"),
  } as unknown as Response;
}

// 本体の途中で切れる（undici の terminated）/ 最後まで届く、を fake で作る。
function streamResponse(
  status: number,
  bytes: Uint8Array,
  opts: { cut?: boolean; contentRange?: string } = {},
): Response {
  const headers = new Headers();
  let sent = false;
  if (opts.contentRange) headers.set("content-range", opts.contentRange);
  return {
    ok: true,
    status,
    headers,
    // error() は積んだ chunk を捨てるので、chunk を読ませてから次の pull で切る。
    body: new ReadableStream({
      pull(c) {
        if (sent) {
          if (opts.cut) c.error(new TypeError("terminated"));
          else c.close();
          return;
        }
        sent = true;
        if (bytes.byteLength > 0) c.enqueue(bytes);
      },
    }),
  } as unknown as Response;
}

const rangeOf = (init?: RequestInit): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.["Range"];

describe("fetchArxivSource", () => {
  it("成功時に Buffer を返し User-Agent を付与する", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse("SRC"));
    const buf = await fetchArxivSource("1706.03762", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      state: { lastRequestAt: 0 },
      now: () => 100000,
    });
    expect(buf.toString("utf8")).toBe("SRC");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/e-print/1706.03762");
    expect(init?.headers).toMatchObject({
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

  describe("途中で切れたら Range で続きを取る（#506）", () => {
    const FULL = Uint8Array.from({ length: 10 }, (_, i) => i);
    const common = {
      sleep: async () => {},
      now: () => 0,
      state: { lastRequestAt: 0 },
      maxQueueWaitMs: 1e9,
    };

    it("切れる → 206 で続き → 揃う。同じ endpoint・3 秒間隔を通す", async () => {
      const calls: { url: string; range?: string }[] = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, range: rangeOf(init) });
        if (calls.length === 1) return streamResponse(200, FULL.slice(0, 4), { cut: true });
        if (calls.length === 2) {
          return streamResponse(206, FULL.slice(4, 7), { cut: true, contentRange: "bytes 4-9/10" });
        }
        return streamResponse(206, FULL.slice(7), { contentRange: "bytes 7-9/10" });
      });
      const sleeps: number[] = [];
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        minIntervalMs: 3000,
        retries: 0,
      });
      expect([...buf]).toEqual([...FULL]);
      expect(calls.map((c) => c.range)).toEqual([undefined, "bytes=4-", "bytes=7-"]);
      expect(new Set(calls.map((c) => c.url))).toEqual(
        new Set(["https://export.arxiv.org/e-print/2206.13089"]),
      );
      // 各要求の前に 3 秒間隔の予約を通る（retries: 0 でも進んだ試行は数えない）。
      expect(sleeps.filter((ms) => ms >= 3000)).toEqual([3000, 6000, 9000]);
    });

    it("Range が効かず 200 が返ったら、受け取った分を捨てて初めから取る", async () => {
      let n = 0;
      const fetchImpl = vi.fn(async () =>
        ++n === 1
          ? streamResponse(200, FULL.slice(0, 4), { cut: true })
          : streamResponse(200, FULL),
      );
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...buf]).toEqual([...FULL]);
    });

    it("Content-Range の開始が受け取った長さと違う 206 は足さず、初めから取る", async () => {
      const ranges: (string | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        ranges.push(rangeOf(init));
        if (ranges.length === 1) return streamResponse(200, FULL.slice(0, 4), { cut: true });
        if (ranges.length === 2) {
          return streamResponse(206, FULL.slice(5), { contentRange: "bytes 5-9/10" });
        }
        return streamResponse(200, FULL);
      });
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...buf]).toEqual([...FULL]);
      expect(ranges).toEqual([undefined, "bytes=4-", undefined]);
    });

    it("上限サイズは続きを足した合計で検査する", async () => {
      let n = 0;
      const fetchImpl = vi.fn(async () =>
        ++n === 1
          ? streamResponse(200, FULL.slice(0, 6), { cut: true })
          : streamResponse(206, FULL.slice(6), { contentRange: "bytes 6-9/10" }),
      );
      await expect(
        fetchArxivSource("2206.13089", {
          ...common,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          limits: { ...DEFAULT_LIMITS, maxArchiveBytes: 8 },
        }),
      ).rejects.toMatchObject({ kind: "too-large" });
    });

    it("進まない切断は retries で打ち切る", async () => {
      const fetchImpl = vi.fn(async () => streamResponse(200, new Uint8Array(0), { cut: true }));
      await expect(
        fetchArxivSource("2206.13089", {
          ...common,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          retries: 2,
        }),
      ).rejects.toMatchObject({ code: 2, kind: "upstream" });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("続きの要求への 416 は、受け取った分を捨てて初めから取る", async () => {
      const ranges: (string | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        ranges.push(rangeOf(init));
        if (ranges.length === 1) return streamResponse(200, FULL.slice(0, 4), { cut: true });
        if (ranges.length === 2) return { ok: false, status: 416 } as Response;
        return streamResponse(200, FULL);
      });
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...buf]).toEqual([...FULL]);
      expect(ranges).toEqual([undefined, "bytes=4-", undefined]);
    });

    it("続きの前後で Content-Range の総サイズが変わったら、捨てて初めから取る", async () => {
      const ranges: (string | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        ranges.push(rangeOf(init));
        if (ranges.length === 1) return streamResponse(200, FULL.slice(0, 2), { cut: true });
        if (ranges.length === 2) {
          return streamResponse(206, FULL.slice(2, 4), { cut: true, contentRange: "bytes 2-9/10" });
        }
        if (ranges.length === 3) {
          return streamResponse(206, FULL.slice(4), { contentRange: "bytes 4-11/12" });
        }
        return streamResponse(200, FULL);
      });
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...buf]).toEqual([...FULL]);
      expect(ranges).toEqual([undefined, "bytes=2-", "bytes=4-", undefined]);
    });

    it("最後に総サイズと受け取った長さが一致しなければ、揃ったとみなさない", async () => {
      const ranges: (string | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        ranges.push(rangeOf(init));
        if (ranges.length === 1) return streamResponse(200, FULL.slice(0, 4), { cut: true });
        // 総サイズ 10 なのに 3 バイトで閉じる（短い 206）。
        if (ranges.length === 2) {
          return streamResponse(206, FULL.slice(4, 7), { contentRange: "bytes 4-9/10" });
        }
        return streamResponse(206, FULL.slice(7), { contentRange: "bytes 7-9/10" });
      });
      const buf = await fetchArxivSource("2206.13089", {
        ...common,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...buf]).toEqual([...FULL]);
      expect(ranges).toEqual([undefined, "bytes=4-", "bytes=7-"]);
    });

    it("受け取った分がある状態で中断されたら canceled で抜ける", async () => {
      const c = new AbortController();
      const fetchImpl = vi.fn(async () => {
        let sent = false;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream({
            pull(ctl) {
              if (!sent) {
                sent = true;
                ctl.enqueue(FULL.slice(0, 4));
                return;
              }
              c.abort();
              ctl.error(new TypeError("terminated"));
            },
          }),
        } as unknown as Response;
      });
      await expect(
        fetchArxivSource("2206.13089", {
          ...common,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          signal: c.signal,
        }),
      ).rejects.toMatchObject({ code: 6, kind: "canceled" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("進む → 進まない 3 回を繰り返しても、試行の総数に上限がある", async () => {
      let n = 0;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        n++;
        if (n % 4 !== 1) return { ok: false, status: 503 } as Response;
        const start = Number(/bytes=(\d+)-/.exec(rangeOf(init) ?? "")?.[1] ?? 0);
        return streamResponse(start === 0 ? 200 : 206, new Uint8Array(1), {
          cut: true,
          contentRange: `bytes ${start}-${start}/1000`,
        });
      });
      await expect(
        fetchArxivSource("2206.13089", {
          ...common,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 2, kind: "upstream" });
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(24);
    });

    it("進み続けても続きの回数に上限がある", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const start = Number(/bytes=(\d+)-/.exec(rangeOf(init) ?? "")?.[1] ?? 0);
        return streamResponse(start === 0 ? 200 : 206, new Uint8Array(1), {
          cut: true,
          contentRange: `bytes ${start}-${start}/1000`,
        });
      });
      await expect(
        fetchArxivSource("2206.13089", {
          ...common,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          retries: 0,
        }),
      ).rejects.toMatchObject({ code: 2, kind: "upstream" });
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(24);
    });
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
