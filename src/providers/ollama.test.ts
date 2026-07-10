import { describe, it, expect } from "vitest";
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
    expect(calls).toBe(2);
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

  it("4xx はプロバイダ利用不能 code 2", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
    await expect(
      makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl }).complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
