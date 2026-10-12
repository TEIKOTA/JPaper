import { describe, it, expect } from "vitest";
import { providerLabel } from "./api.js";

describe("providerLabel", () => {
  it("codex は GPT と表示し、ほかは provider の名前のまま", () => {
    expect(providerLabel("codex")).toBe("GPT");
    expect(providerLabel("claude")).toBe("claude");
    expect(providerLabel("ollama")).toBe("ollama");
    expect(providerLabel("openrouter")).toBe("openrouter");
  });
});
