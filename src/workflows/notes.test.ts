import { describe, it, expect } from "vitest";
import { buildNotes } from "./notes.js";
import type { ResolvedTerm } from "../types/contract.js";

const term = (over: Partial<ResolvedTerm> & { src: string }): ResolvedTerm => ({
  form: over.form ?? over.src,
  class: over.class ?? "established",
  rendering: over.rendering ?? "translate",
  firstOccurrence: false,
  ...over,
});

describe("buildNotes", () => {
  it("preserve / low-confidence / evaluator-warn を採り、確定語は採らない", () => {
    const resolved = [
      term({ src: "Val", form: "値(Value)", class: "paper-defined", rendering: "bilingual" }),
      term({ src: "attn", class: "established", rendering: "translate" }),
      term({ src: "safe", class: "established", rendering: "translate" }),
    ];
    const notes = buildNotes({
      resolved,
      firstOccurrenceBySrc: new Map([
        ["Val", "seg-0"],
        ["attn", "seg-0"],
        ["safe", "seg-1"],
      ]),
      hasConfirmed: (src) => src === "safe",
      segmentWarns: [{ segmentId: "seg-1", warnIssues: [{ severity: "warn", message: "hedging" }] }],
    });
    const triggers = notes.map((n) => n.trigger);
    expect(triggers).toContain("paper-defined-preserve");
    expect(triggers).toContain("low-confidence");
    expect(triggers).toContain("evaluator-warn");
    expect(notes.find((n) => n.src === "safe")).toBeUndefined();
    expect(notes.find((n) => n.src === "Val")?.segmentId).toBe("seg-0");
  });

  it("本文に出現しない語は対象外", () => {
    const notes = buildNotes({
      resolved: [term({ src: "X", class: "paper-defined", rendering: "keep-original" })],
      firstOccurrenceBySrc: new Map(),
      hasConfirmed: () => false,
      segmentWarns: [],
    });
    expect(notes).toEqual([]);
  });
});
