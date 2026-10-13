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
      // 契約 §8② は「preserve に倒した語」に限る。translate に倒した確信のある語は対象外。
      term({ src: "attn", class: "established", rendering: "keep-original" }),
      term({ src: "safe", class: "established", rendering: "keep-original" }),
      term({ src: "plain", class: "established", rendering: "translate" }),
    ];
    const notes = buildNotes({
      resolved,
      firstOccurrenceBySrc: new Map([
        ["Val", "seg-0"],
        ["attn", "seg-0"],
        ["safe", "seg-1"],
        ["plain", "seg-1"],
      ]),
      hasConfirmed: (src) => src === "safe",
      segmentWarns: [{ segmentId: "seg-1", warnIssues: [{ severity: "warn", message: "hedging" }] }],
    });
    const triggers = notes.map((n) => n.trigger);
    expect(triggers).toContain("paper-defined-preserve");
    expect(triggers).toContain("low-confidence");
    expect(triggers).toContain("evaluator-warn");
    expect(notes.find((n) => n.src === "safe")).toBeUndefined();
    // translate に倒した語は確定訳が無くても訳注を出さない（契約より広く出していた）。
    expect(notes.find((n) => n.src === "plain")).toBeUndefined();
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

  it("segmentLints の未訳見出しを heading-untranslated 訳注に流す", () => {
    const notes = buildNotes({
      resolved: [],
      firstOccurrenceBySrc: new Map(),
      hasConfirmed: () => false,
      segmentWarns: [],
      segmentLints: [{ segmentId: "seg-2", untranslatedHeadings: ["Training", "Results"] }],
    });
    const headingNotes = notes.filter((n) => n.trigger === "heading-untranslated");
    expect(headingNotes).toHaveLength(2);
    expect(headingNotes[0]?.segmentId).toBe("seg-2");
    expect(headingNotes[0]?.text).toContain("Training");
    expect(headingNotes[1]?.text).toContain("Results");
  });
});

describe("未確認の語の訳注（契約付録 §4・issue #309）", () => {
  it("未確認の語はモデルの note や low-confidence より優先して、決まった文面で 1 件だけ出す", () => {
    const resolved = [
      term({ src: "Val", form: "値(Value)", class: "paper-defined", rendering: "bilingual", note: "初出のみ併記" }),
      term({ src: "attn", class: "established", rendering: "bilingual", note: "モデルの説明" }),
      term({ src: "absent", class: "established", rendering: "translate" }),
    ];
    const notes = buildNotes({
      resolved,
      firstOccurrenceBySrc: new Map([
        ["Val", "seg-0"],
        ["attn", "seg-1"],
      ]),
      hasConfirmed: () => false,
      segmentWarns: [],
      unverified: new Set(["Val", "attn", "absent"]),
    });
    expect(notes.map((n) => [n.trigger, n.src, n.segmentId])).toEqual([
      ["unverified-term", "Val", "seg-0"],
      ["unverified-term", "attn", "seg-1"],
    ]);
    expect(notes[0]!.text).toBe("Val の訳語「値(Value)」は、Web 検索で既存の日本語の用例を確かめられなかった（未確認）");
  });
});
