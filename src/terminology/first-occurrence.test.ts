import { describe, it, expect } from "vitest";
import { buildFirstOccurrenceIndex, isFirstOccurrence } from "./first-occurrence.js";

describe("buildFirstOccurrenceIndex", () => {
  it("初出セグメントを文書順で決定", () => {
    const segs = [
      { id: "seg-0000", latex: "intro attention here" },
      { id: "seg-0001", latex: "more attention and Transformer" },
    ];
    const idx = buildFirstOccurrenceIndex(segs, ["attention", "Transformer"]);
    expect(idx.get("attention")).toBe("seg-0000");
    expect(idx.get("Transformer")).toBe("seg-0001");
    expect(isFirstOccurrence(idx, "seg-0000", "attention")).toBe(true);
    expect(isFirstOccurrence(idx, "seg-0001", "attention")).toBe(false);
  });

  it("分割の仕方に依らず初出は同じ（分割不変）", () => {
    const whole = [{ id: "a", latex: "x term y term" }];
    const split = [
      { id: "a", latex: "x term y" },
      { id: "b", latex: "term" },
    ];
    expect(buildFirstOccurrenceIndex(whole, ["term"]).get("term")).toBe("a");
    expect(buildFirstOccurrenceIndex(split, ["term"]).get("term")).toBe("a");
  });

  it("未出現の語は index に無い", () => {
    const idx = buildFirstOccurrenceIndex([{ id: "a", latex: "hello" }], ["world"]);
    expect(idx.has("world")).toBe(false);
    expect(isFirstOccurrence(idx, "a", "world")).toBe(false);
  });
});
