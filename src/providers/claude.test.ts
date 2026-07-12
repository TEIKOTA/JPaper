import { describe, it, expect } from "vitest";
import { makeClaudeClient } from "./claude.js";
import { isTransient } from "../types/errors.js";

describe("makeClaudeClient", () => {
  it("result を抽出し・必須フラグを渡し・model は渡さない", async () => {
    let args: string[] = [];
    const c = makeClaudeClient({
      run: async (a) => {
        args = a;
        return JSON.stringify({ result: "訳文" });
      },
    });
    expect(await c.complete({ system: "SYS", user: "USR" })).toBe("訳文");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--tools");
    expect(args).toContain("none");
    expect(args).toContain("SYS");
    expect(args).toContain("USR");
    expect(args).not.toContain("--model");
  });

  it("非 JSON 応答は code 1", async () => {
    const c = makeClaudeClient({ run: async () => "not json" });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 1 });
  });

  it("result 欠如は code 1", async () => {
    const c = makeClaudeClient({ run: async () => JSON.stringify({ foo: "bar" }) });
    await expect(c.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: 1 });
  });

  it("ENOENT（未インストール）は非 transient の code 2", async () => {
    const c = makeClaudeClient({
      run: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    });
    try {
      await c.complete({ system: "s", user: "u" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
      expect(isTransient(e)).toBe(false);
    }
  });

  it("非ゼロ終了・タイムアウトは transient な code 2（withRetry 対象）", async () => {
    for (const thrown of [Object.assign(new Error("exit 1"), { code: 1 }), { code: "ETIMEDOUT" }]) {
      const c = makeClaudeClient({
        run: async () => {
          throw thrown;
        },
      });
      try {
        await c.complete({ system: "s", user: "u" });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as { code: number }).code).toBe(2);
        expect(isTransient(e)).toBe(true);
      }
    }
  });
});
