import { describe, it, expect, afterEach } from "vitest";
import { makeOpenRouterClient, API_KEY_ENV } from "./openrouter.js";
import { DEFAULT_OPENROUTER } from "../config.js";
import { JpaperError } from "../types/errors.js";
import { isTransient } from "../types/errors.js";
import type { LlmCallEvent } from "../types/contract.js";

function sse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l + "\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const chunk = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

const usage = (p: number, c: number, cost: number): string =>
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, cost } })}`;

const REQ = { system: "s", user: "u" };

describe("openrouter プロバイダ", () => {
  const saved = process.env[API_KEY_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = saved;
  });

  it("SSE のチャンクを連結して本文を返す", async () => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () => sse([chunk("訳"), chunk("文"), "data: [DONE]"]),
    });
    expect(await c.complete(REQ)).toBe("訳文");
  });

  // keep-alive のコメント行が定期的に流れる。data: 以外を parse しようとすると落ちる。
  it("コメント行と空行を読み飛ばす", async () => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () => sse([": OPENROUTER PROCESSING", "", chunk("本文"), "data: [DONE]"]),
    });
    expect(await c.complete(REQ)).toBe("本文");
  });

  it("最終チャンクの usage をトレースへ流す（コストも記録する）", async () => {
    const events: LlmCallEvent[] = [];
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      trace: (e) => events.push(e),
      fetchImpl: async () => sse([chunk("x"), usage(81, 43, 0.0012), "data: [DONE]"]),
    });
    await c.complete({ ...REQ, meta: { role: "translator", phase: "translate" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "openrouter",
      role: "translator",
      inputTokens: 81,
      outputTokens: 43,
      costUsd: 0.0012,
    });
  });

  it("body を持たない応答（まとめ受け）も読める", async () => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          body: null,
          json: async () => ({ choices: [{ message: { content: "まとめ" } }] }),
        }) as unknown as Response,
    });
    expect(await c.complete(REQ)).toBe("まとめ");
  });

  it("鍵が無ければ終了コード 2 で落ちる（呼び出しに行かない）", async () => {
    delete process.env[API_KEY_ENV];
    let called = false;
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      fetchImpl: async () => {
        called = true;
        return sse([]);
      },
    });
    await expect(c.complete(REQ)).rejects.toThrow(new RegExp(API_KEY_ENV));
    expect(called).toBe(false);
  });

  it("環境変数の鍵を使う", async () => {
    process.env[API_KEY_ENV] = "from-env";
    let auth: string | undefined;
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      fetchImpl: async (_u, init) => {
        auth = (init?.headers as Record<string, string>).authorization;
        return sse([chunk("ok"), "data: [DONE]"]);
      },
    });
    await c.complete(REQ);
    expect(auth).toBe("Bearer from-env");
  });

  // 無料モデルは 20 req/分・50 req/日で 429 を返す。再訳 1 本を落とすのではなく待って直す。
  it.each([429, 500, 503])("HTTP %i は一時障害として再試行に載せる", async (status) => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () => new Response("", { status }),
    });
    const err = await c.complete(REQ).catch((e: unknown) => e);
    expect(isTransient(err)).toBe(true);
    expect(err).not.toBeInstanceOf(JpaperError);
  });

  it.each([
    [401, /拒否/],
    [402, /残高/],
    [404, /見つかりません/],
  ])("HTTP %i は再試行せず終了コード 2 で落とす", async (status, re) => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () => new Response("", { status }),
    });
    const err = (await c.complete(REQ).catch((e: unknown) => e)) as JpaperError;
    expect(err).toBeInstanceOf(JpaperError);
    expect(err.code).toBe(2);
    expect(err.message).toMatch(re);
    expect(isTransient(err)).toBe(false);
  });

  it("応答の中の error は provider エラーにする（200 で来ても素通しにしない）", async () => {
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () =>
        sse([`data: ${JSON.stringify({ error: { message: "上流が落ちています" } })}`]),
    });
    await expect(c.complete(REQ)).rejects.toThrow(/上流が落ちています/);
  });

  it("中断は canceled へ写す（再試行対象から外す）", async () => {
    const ctl = new AbortController();
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async () => {
        ctl.abort();
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      },
    });
    const err = (await c.complete({ ...REQ, signal: ctl.signal }).catch((e: unknown) => e)) as {
      kind?: string;
    };
    expect(err.kind).toBe("canceled");
  });

  // 制約デコードは JSON 文字列中に \c を出せず LaTeX の綴りを壊す（ADR 20260815）。
  it("format 強制を送らない", async () => {
    let sent: Record<string, unknown> = {};
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([chunk("x"), "data: [DONE]"]);
      },
    });
    await c.complete({ ...REQ, jsonMode: true });
    expect(sent.response_format).toBeUndefined();
    expect(sent.stream).toBe(true);
    expect((sent.stream_options as { include_usage?: boolean }).include_usage).toBe(true);
  });

  it("req.model が cfg.model より優先される", async () => {
    let sentModel: unknown;
    const c = makeOpenRouterClient(DEFAULT_OPENROUTER, {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        sentModel = (JSON.parse(String(init?.body)) as { model: unknown }).model;
        return sse([chunk("x"), "data: [DONE]"]);
      },
    });
    await c.complete({ ...REQ, model: "openai/gpt-oss-20b:free" });
    expect(sentModel).toBe("openai/gpt-oss-20b:free");
  });
});
