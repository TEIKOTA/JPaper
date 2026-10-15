import { describe, it, expect } from "vitest";
import { makeLlmClient } from "./index.js";

describe("makeLlmClient", () => {
  it("provider に応じたクライアントを返す", () => {
    const claude = makeLlmClient("claude", { claudeDeps: { run: async () => "{}" } });
    const ollama = makeLlmClient("ollama");
    expect(typeof claude.complete).toBe("function");
    expect(typeof ollama.complete).toBe("function");
  });

  it("claude 設定を claude クライアントの引数へ渡す", async () => {
    let args: string[] = [];
    const claude = makeLlmClient("claude", {
      claude: { model: "sonnet", effort: "medium" },
      claudeDeps: {
        run: async (a) => {
          args = a;
          return JSON.stringify({ result: "r" });
        },
      },
    });
    await claude.complete({ system: "s", user: "u" });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });

  it("codex 設定を codex クライアントの引数へ渡す", async () => {
    let args: string[] = [];
    const codex = makeLlmClient("codex", {
      codex: { model: "gpt-6.1-sol", effort: "low" },
      codexDeps: {
        run: async (a) => {
          args = a;
          return "r";
        },
      },
    });
    expect(await codex.complete({ system: "s", user: "u" })).toBe("r");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="low"');
  });
});

describe("画像の入力（契約付録 §8 PDF 入力）", () => {
  it.each(["ollama", "openrouter"] as const)("%s に画像を渡すと、送らずに provider エラー", async (p) => {
    const c = makeLlmClient(p);
    await expect(
      c.complete({ system: "s", user: "u", images: [{ mediaType: "image/png", data: Buffer.from("x") }] }),
    ).rejects.toMatchObject({ code: 2, kind: "provider" });
  });
});
