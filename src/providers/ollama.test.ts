import { describe, it, expect } from "vitest";
import { extractJson } from "../runtime/llm-client.js";
import { makeOllamaClient } from "./ollama.js";
import { DEFAULT_OLLAMA } from "../config.js";
import { isTransient } from "../types/errors.js";

const okChat = (content: string) =>
  ({ ok: true, status: 200, json: async () => ({ message: { content } }) }) as unknown as Response;

describe("makeOllamaClient", () => {
  it("/api/chat の message.content を返す", async () => {
    let body: { model?: string; messages?: { content?: string }[] } = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return okChat("応答");
    }) as unknown as typeof fetch;
    const c = makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl });
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe("応答");
    expect(body.model).toBe(DEFAULT_OLLAMA.model);
    expect(body.messages?.[0]?.content).toBe("SYS");
  });

  it("jsonMode でも format を送らない（制約デコードが LaTeX の綴りを壊すため）", async () => {
    // JSON の文字列中で \c は不正なエスケープなので、format:"json" の制約デコードは
    // backslash の次に "\/bfnrtu しか出せない。モデルが \citep を書こうとすると \t / \n
    // に化け、実測で訳文から引用が 1 つ残らず消えた。ADR 20260815-drop-ollama-json-mode。
    let body: { format?: unknown } = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return okChat('{"ok":true}');
    }) as unknown as typeof fetch;
    const c = makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl });
    await c.complete({ system: "s", user: "u", jsonMode: true });
    expect(body.format).toBeUndefined();
    await c.complete({ system: "s", user: "u" });
    expect(body.format).toBeUndefined();
  });

  it("フェンス付きの応答でも JSON を取り出せる（format を外した経路の受け皿）", async () => {
    const fetchImpl = (async () =>
      okChat('```json\n{"ok":true}\n```')) as unknown as typeof fetch;
    const c = makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl });
    const raw = await c.complete({ system: "s", user: "u", jsonMode: true });
    expect(extractJson(raw)).toEqual({ ok: true });
  });

  describe("stream 受信", () => {
    // 能力問い合わせ（/api/show）を挟まない設定。ここで見たいのは /api/chat の受信だけ。
    const noThinkCfg = { ...DEFAULT_OLLAMA, think: undefined };

    // 実際のチャンク列（NDJSON）を返す Response。cancel されたかも見る。
    const streamRes = (parts: (string | Uint8Array)[], canceled?: { done: boolean }) =>
      ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            let i = 0;
            return {
              read: async () =>
                i < parts.length
                  ? {
                      done: false,
                      value:
                        typeof parts[i] === "string"
                          ? new TextEncoder().encode(parts[i++] as string)
                          : (parts[i++] as Uint8Array),
                    }
                  : { done: true, value: undefined },
              cancel: async () => {
                if (canceled) canceled.done = true;
              },
            };
          },
        },
      }) as unknown as Response;

    const chunk = (content: string, done = false, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ message: { content }, done, ...extra })}\n`;

    it("stream:true を送り、チャンクを連結して返す（統計は done チャンクから）", async () => {
      let body: { stream?: unknown } = {};
      let seen: { inputTokens?: number; outputTokens?: number } = {};
      const fetchImpl = (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return streamRes([
          chunk("訳"),
          chunk("文で"),
          chunk("ある。"),
          chunk("", true, { prompt_eval_count: 120, eval_count: 7 }),
        ]);
      }) as unknown as typeof fetch;
      const c = makeOllamaClient(noThinkCfg, {
        fetchImpl,
        trace: (r) => (seen = { inputTokens: r.inputTokens, outputTokens: r.outputTokens }),
      });
      expect(await c.complete({ system: "s", user: "u" })).toBe("訳文である。");
      expect(body.stream).toBe(true);
      expect(seen).toEqual({ inputTokens: 120, outputTokens: 7 });
    });

    it("チャンク境界が改行や多バイト文字を跨いでも壊さない", async () => {
      const line = chunk("日本語テキスト") + chunk("", true);
      const bytes = new TextEncoder().encode(line);
      // 「日」の途中でぶつ切りにする。
      const cut = 22;
      const fetchImpl = (async () =>
        streamRes([bytes.slice(0, cut), bytes.slice(cut)])) as unknown as typeof fetch;
      const c = makeOllamaClient(noThinkCfg, { fetchImpl });
      expect(await c.complete({ system: "s", user: "u" })).toBe("日本語テキスト");
    });

    it("上限を超えたら受信を打ち切り、reader を cancel する", async () => {
      const canceled = { done: false };
      const big = "あ".repeat(600_000);
      const fetchImpl = (async () =>
        streamRes([chunk(big), chunk(big), chunk("", true)], canceled)) as unknown as typeof fetch;
      const c = makeOllamaClient(noThinkCfg, { fetchImpl });
      await expect(c.complete({ system: "s", user: "u" })).rejects.toThrow(/上限/);
      expect(canceled.done).toBe(true);
    });

    it("改行が来ないまま膨らむ応答も打ち切る", async () => {
      const canceled = { done: false };
      const fetchImpl = (async () =>
        streamRes(["x".repeat(600_000), "x".repeat(600_000)], canceled)) as unknown as typeof fetch;
      const c = makeOllamaClient(noThinkCfg, { fetchImpl });
      await expect(c.complete({ system: "s", user: "u" })).rejects.toThrow(/上限/);
      expect(canceled.done).toBe(true);
    });

    it("ストリーム途中のエラー（HTTP は 200）を provider エラーにする", async () => {
      const fetchImpl = (async () =>
        streamRes([chunk("途中まで"), `${JSON.stringify({ error: "model runner has unexpectedly stopped" })}\n`])) as unknown as typeof fetch;
      const c = makeOllamaClient(noThinkCfg, { fetchImpl });
      const e = await c.complete({ system: "s", user: "u" }).catch((x: unknown) => x);
      expect((e as { kind?: string }).kind).toBe("provider");
      expect(String((e as Error).message)).toContain("model runner");
    });
  });

  describe("思考の制御", () => {
    const showing = (caps: unknown) =>
      ({ ok: true, status: 200, json: async () => ({ capabilities: caps }) }) as unknown as Response;

    const spy = (caps: unknown) => {
      const shown: string[] = [];
      const bodies: { think?: unknown }[] = [];
      const fetchImpl = (async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { model?: string; think?: unknown };
        if (url.endsWith("/api/show")) {
          shown.push(String(body.model));
          return showing(caps);
        }
        bodies.push(body);
        return okChat("応答");
      }) as unknown as typeof fetch;
      return { fetchImpl, shown, bodies };
    };

    it("think 未設定なら能力も引かず think も送らない", async () => {
      const s = spy(["thinking"]);
      const c = makeOllamaClient({ ...DEFAULT_OLLAMA, think: undefined }, { fetchImpl: s.fetchImpl });
      await c.complete({ system: "s", user: "u" });
      expect(s.shown).toEqual([]);
      expect(s.bodies[0]?.think).toBeUndefined();
    });

    it("thinking 能力があるモデルには think を送る", async () => {
      const s = spy(["completion", "thinking"]);
      const c = makeOllamaClient({ ...DEFAULT_OLLAMA, think: false }, { fetchImpl: s.fetchImpl });
      await c.complete({ system: "s", user: "u" });
      expect(s.bodies[0]?.think).toBe(false);
    });

    it("thinking 能力が無いモデルには think を送らない（送るとエラーになる相手）", async () => {
      const s = spy(["completion", "tools"]);
      const c = makeOllamaClient({ ...DEFAULT_OLLAMA, think: true }, { fetchImpl: s.fetchImpl });
      await c.complete({ system: "s", user: "u" });
      expect(s.bodies[0]?.think).toBeUndefined();
    });

    it("能力の問い合わせはモデルごとに 1 回だけ", async () => {
      const s = spy(["thinking"]);
      const c = makeOllamaClient({ ...DEFAULT_OLLAMA, think: true }, { fetchImpl: s.fetchImpl });
      await c.complete({ system: "s", user: "u" });
      await c.complete({ system: "s", user: "u" });
      await c.complete({ system: "s", user: "u", model: "other:1b" });
      expect(s.shown).toEqual([DEFAULT_OLLAMA.model, "other:1b"]);
    });

    it("能力を判定できなければ think を送らず、判定結果をキャッシュしない", async () => {
      let showCalls = 0;
      const bodies: { think?: unknown }[] = [];
      const fetchImpl = (async (url: string, init: { body: string }) => {
        if (url.endsWith("/api/show")) {
          showCalls++;
          if (showCalls === 1) return { ok: false, status: 500 } as unknown as Response;
          return showing(["thinking"]);
        }
        bodies.push(JSON.parse(init.body) as { think?: unknown });
        return okChat("応答");
      }) as unknown as typeof fetch;
      const c = makeOllamaClient({ ...DEFAULT_OLLAMA, think: false }, { fetchImpl });
      await c.complete({ system: "s", user: "u" });
      expect(bodies[0]?.think).toBeUndefined();
      // 一度の失敗で「思考なし」を焼き付けない。
      await c.complete({ system: "s", user: "u" });
      expect(bodies[1]?.think).toBe(false);
    });

    it("能力問い合わせの接続拒否は daemon 起動経路へ渡す", async () => {
      let ensured = false;
      let refused = true;
      const fetchImpl = (async (url: string) => {
        if (refused) {
          refused = false;
          throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }
        if (url.endsWith("/api/show")) return showing(["thinking"]);
        return okChat("起動後");
      }) as unknown as typeof fetch;
      const c = makeOllamaClient(
        { ...DEFAULT_OLLAMA, think: false },
        {
          fetchImpl,
          ensureDaemon: async () => {
            ensured = true;
          },
        },
      );
      expect(await c.complete({ system: "s", user: "u" })).toBe("起動後");
      expect(ensured).toBe(true);
    });
  });

  it("接続拒否時は daemon を起動して再試行", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
      return okChat("起動後");
    }) as unknown as typeof fetch;
    let ensured = false;
    const c = makeOllamaClient(DEFAULT_OLLAMA, {
      fetchImpl,
      ensureDaemon: async () => {
        ensured = true;
      },
    });
    expect(await c.complete({ system: "s", user: "u" })).toBe("起動後");
    expect(ensured).toBe(true);
    // 能力問い合わせ(拒否) → 起動 → 能力問い合わせ → /api/chat。
    expect(calls).toBe(3);
  });

  it("5xx は status を持つ一時エラー（withRetry で拾える）", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    try {
      await makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl }).complete({ system: "s", user: "u" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(isTransient(e)).toBe(true);
      expect((e as { status?: number }).status).toBe(503);
    }
  });

  it("ollama 実行ファイル欠如は code 2（プロセスを落とさない）", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const spawnImpl = (() => ({
      on(ev: string, cb: (e: Error) => void) {
        if (ev === "error") cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        return this;
      },
      unref() {
        return this;
      },
    })) as unknown as typeof import("node:child_process").spawn;
    await expect(
      makeOllamaClient(DEFAULT_OLLAMA, {
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      }).complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("custom port は OLLAMA_HOST を渡して daemon 起動する", async () => {
    const cfg = { ...DEFAULT_OLLAMA, port: 12345 };
    let calls = 0;
    let spawnOpts: { env?: Record<string, string> } = {};
    const fetchImpl = (async (url: string) => {
      calls++;
      // 最初に触る API（能力問い合わせ）が拒否される＝daemon 未起動。
      if (calls === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
      if (url.includes("/api/tags")) return { ok: true } as Response;
      return okChat("ok");
    }) as unknown as typeof fetch;
    const spawnImpl = ((_c: string, _a: string[], opts: { env?: Record<string, string> }) => {
      spawnOpts = opts;
      return {
        on() {
          return this;
        },
        unref() {
          return this;
        },
      };
    }) as unknown as typeof import("node:child_process").spawn;
    const c = makeOllamaClient(cfg, { fetchImpl, spawnImpl, sleep: async () => {} });
    expect(await c.complete({ system: "s", user: "u" })).toBe("ok");
    expect(spawnOpts.env?.OLLAMA_HOST).toBe("127.0.0.1:12345");
  });

  it("未 pull モデル(404)は pull 案内付き code 2", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
    try {
      await makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl }).complete({ system: "s", user: "u" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
      expect((e as { message: string }).message).toContain("pull");
      expect((e as { message: string }).message).toContain(DEFAULT_OLLAMA.model);
    }
  });

  it("4xx はプロバイダ利用不能 code 2", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
    await expect(
      makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl }).complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe("応答サイズの上限", () => {
  it("上限を超える本文は受信を打ち切って失敗する", async () => {
    // res.json() は本文を丸ごと載せる。応答を誘導できる相手にメモリを食わせられる。
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 2 * 1_000_000) controller.close();
        else {
          sent += chunk.length;
          controller.enqueue(chunk);
        }
      },
    });
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, body }) as unknown as Response) as unknown as typeof fetch;
    const c = makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toThrow(/上限/);
  });
});
