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
});
