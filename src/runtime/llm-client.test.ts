import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, runAgent } from "./llm-client.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

describe("extractJson", () => {
  it("素の JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("```json フェンス", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("前後に散文がある場合も取り出す", () => {
    expect(extractJson("結果:\n{\"a\":1}\nおわり")).toEqual({ a: 1 });
    expect(extractJson("prefix [1,2,3]")).toEqual([1, 2, 3]);
  });
  it("無効なブラケットの後にある JSON を見つける", () => {
    expect(extractJson('Note [draft]\n{"a":1}')).toEqual({ a: 1 });
  });
  it("文字列内の閉じ括弧を無視する", () => {
    expect(extractJson('x {"s":"a}b"} y')).toEqual({ s: "a}b" });
  });
  it("JSON が無ければ例外", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("runAgent", () => {
  it("complete→extractJson→zod.parse", async () => {
    const c = new FakeLlmClient('```json\n{"x":5}\n```');
    expect(await runAgent(c, { system: "s", user: "u" }, z.object({ x: z.number() }))).toEqual({
      x: 5,
    });
  });
  it("スキーマ不一致は throw", async () => {
    const c = new FakeLlmClient('{"x":"no"}');
    await expect(
      runAgent(c, { system: "s", user: "u" }, z.object({ x: z.number() })),
    ).rejects.toThrow();
  });

  it("一時エラーは client 境界でリトライする", async () => {
    let n = 0;
    const client = {
      async complete() {
        if (n++ < 1) throw { code: "ETIMEDOUT" };
        return '{"x":1}';
      },
    };
    const out = await runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
      sleep: async () => {},
    });
    expect(out).toEqual({ x: 1 });
    expect(n).toBe(2);
  });
});
