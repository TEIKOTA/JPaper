import { describe, it, expect } from "vitest";
import { makeClaudeClient } from "./claude.js";

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
    expect(args).toContain("--allowedTools");
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
});
