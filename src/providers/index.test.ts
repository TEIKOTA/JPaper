import { describe, it, expect } from "vitest";
import { makeLlmClient } from "./index.js";

describe("makeLlmClient", () => {
  it("provider に応じたクライアントを返す", () => {
    const claude = makeLlmClient("claude", { claudeDeps: { run: async () => "{}" } });
    const ollama = makeLlmClient("ollama");
    expect(typeof claude.complete).toBe("function");
    expect(typeof ollama.complete).toBe("function");
  });
});

