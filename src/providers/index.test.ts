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

describe("プロセス全体の同時実行上限", () => {
  it("makeLlmClient で作ったクライアントはゲートを通る", async () => {
    const { makeGate } = await import("../runtime/concurrency.js");
    const gate = makeGate(1);
    let active = 0;
    let peak = 0;
    const client = makeLlmClient("claude", {
      gate,
      claudeDeps: {
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return JSON.stringify({ result: "{}" });
        },
      },
    });
    await Promise.all(
      Array.from({ length: 4 }, () => client.complete({ system: "s", user: "u" })),
    );
    expect(peak).toBe(1);
  });

  it("別リクエストのクライアント同士でも既定の共有ゲートで抑えられる", async () => {
    const { makeGate, setLlmGate } = await import("../runtime/concurrency.js");
    setLlmGate(makeGate(2));
    let active = 0;
    let peak = 0;
    const run = async (): Promise<string> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return JSON.stringify({ result: "{}" });
    };
    const a = makeLlmClient("claude", { claudeDeps: { run } });
    const b = makeLlmClient("claude", { claudeDeps: { run } });
    await Promise.all([
      ...Array.from({ length: 4 }, () => a.complete({ system: "s", user: "u" })),
      ...Array.from({ length: 4 }, () => b.complete({ system: "s", user: "u" })),
    ]);
    expect(peak).toBe(2);
    setLlmGate(undefined);
  });
});
