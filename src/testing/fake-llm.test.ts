import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "./fake-llm.js";

describe("FakeLlmClient", () => {
  it("固定応答を返し、呼び出しを記録する", async () => {
    const c = new FakeLlmClient('{"ok":true}');
    expect(await c.complete({ system: "s", user: "u1" })).toBe('{"ok":true}');
    await c.complete({ system: "s", user: "u2" });
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1].user).toBe("u2");
  });

  it("キューは順に返し、尽きたら例外", async () => {
    const c = new FakeLlmClient(["a", "b"]);
    expect(await c.complete({ system: "s", user: "u" })).toBe("a");
    expect(await c.complete({ system: "s", user: "u" })).toBe("b");
    await expect(c.complete({ system: "s", user: "u" })).rejects.toThrow(
      /exhausted/,
    );
  });

  it("関数は req から計算する", async () => {
    const c = new FakeLlmClient((req) => `echo:${req.user}`);
    expect(await c.complete({ system: "s", user: "hello" })).toBe("echo:hello");
  });
});
