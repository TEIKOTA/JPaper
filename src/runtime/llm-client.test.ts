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
  it("スキーマ不一致は retry 上限まで試して throw", async () => {
    let n = 0;
    const client = {
      async complete() {
        n++;
        return '{"x":"no"}';
      },
    };
    await expect(
      runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
        retries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
    expect(n).toBe(3); // 初回＋2 retry（不正応答も transient 扱いで再試行）
  });

  it("応答の parse/検証失敗も retry する（不正JSON→次で正常なら成功）", async () => {
    let n = 0;
    const client = {
      async complete() {
        return n++ < 1 ? "json ではない散文応答" : '{"x":1}';
      },
    };
    const out = await runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
      sleep: async () => {},
    });
    expect(out).toEqual({ x: 1 });
    expect(n).toBe(2); // 1 回目の parse 失敗を retry して 2 回目で成功
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
