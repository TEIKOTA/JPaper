import { describe, it, expect } from "vitest";
import { makeOllamaClient } from "./ollama.js";
import { DEFAULT_OLLAMA } from "../config.js";

describe("makeOllamaClient", () => {
  it("/api/chat の message.content を返す", async () => {
    let body: { model?: string; messages?: { content?: string }[] } = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: "応答" } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const c = makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl });
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe("応答");
    expect(body.model).toBe(DEFAULT_OLLAMA.model);
    expect(body.messages?.[0]?.content).toBe("SYS");
    expect(body.messages?.[1]?.content).toBe("USR");
  });

  it("!ok は code 2（プロバイダ利用不能）", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
    await expect(
      makeOllamaClient(DEFAULT_OLLAMA, { fetchImpl }).complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
