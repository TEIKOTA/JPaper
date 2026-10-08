import { describe, it, expect } from "vitest";
import { ArxivClient, ArxivError, ArxivQueryError, arxivQuery, parseArxivAtom } from "./arxiv.js";
import { ATOM } from "./arxiv.fixtures.js";

const ERROR_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id>
    <title>Error</title>
    <summary>incorrect id format for 1234</summary>
  </entry>
</feed>`;

describe("arXiv の Atom の解析", () => {
  it("entry の id（版を分ける）・title・summary・authors・published を取り出す", () => {
    expect(parseArxivAtom(ATOM)).toEqual({
      total: 42,
      entries: [
        {
          id: "2601.20627",
          version: "v2",
          title: "The Rashomon Set: Theory & Practice",
          summary: "We study <many> models — and α.",
          authors: ["Ada Lovelace", "Alan Turing"],
          published: "2026-01-28T18:00:00Z",
        },
        {
          id: "hep-th/9901001",
          version: "v1",
          title: "Old Style",
          summary: "s",
          authors: ["X"],
          published: "1999-01-01T00:00:00Z",
        },
      ],
    });
  });

  it("arXiv の誤りの entry は ArxivError", () => {
    expect(() => parseArxivAtom(ERROR_ATOM)).toThrow(ArxivError);
  });

  it("entry が無ければ空", () => {
    expect(parseArxivAtom("<feed></feed>")).toEqual({ entries: [] });
  });
});

describe("arXiv の問い合わせ", () => {
  it("arXiv ID は id_list、語は all: の AND", () => {
    expect(arxivQuery("arxiv:2601.20627v2").get("id_list")).toBe("2601.20627v2");
    expect(arxivQuery("hep-th/9901001").get("id_list")).toBe("hep-th/9901001");
    const q = arxivQuery(' rashomon  "set" (theory) OR ');
    expect(q.get("search_query")).toBe("all:rashomon AND all:set AND all:theory");
    expect(q.get("max_results")).toBe("20");
    expect(() => arxivQuery('  "" ')).toThrow(ArxivQueryError);
  });
});

function fakeClock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    waits,
  };
}

describe("arXiv の検索クライアント", () => {
  it("要求は 1 本ずつ、前の要求から 3 秒空ける。同じ問い合わせはキャッシュから返す", async () => {
    const clock = fakeClock();
    const urls: string[] = [];
    const client = new ArxivClient({
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        clock.advance(500);
        return new Response(ATOM, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const [a, b] = await Promise.all([client.search("rashomon"), client.search("turing")]);
    expect(a.entries).toHaveLength(2);
    expect(b.entries).toHaveLength(2);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^https:\/\/export\.arxiv\.org\/api\/query\?search_query=all%3Arashomon/);
    expect(clock.waits).toEqual([2500]);
    await client.search("rashomon");
    expect(urls).toHaveLength(2);
  });

  it("失敗: HTTP の誤り・タイムアウト・接続失敗は ArxivError（後続の要求は止めない）", async () => {
    const clock = fakeClock();
    const responses: (() => Response)[] = [
      () => new Response("busy", { status: 503 }),
      () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response(ATOM, { status: 200 }),
    ];
    const client = new ArxivClient({
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 20_000,
      fetchImpl: (async () => responses.shift()!()) as unknown as typeof fetch,
    });
    await expect(client.search("a")).rejects.toThrow("HTTP 503");
    await expect(client.search("b")).rejects.toThrow("20 秒以内に応答しませんでした");
    await expect(client.search("c")).rejects.toThrow("arXiv に接続できませんでした: fetch failed");
    expect((await client.search("d")).entries).toHaveLength(2);
  });
});
