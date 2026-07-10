import { describe, it, expect } from "vitest";
import { runSectionLoop } from "./section-loop.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import type { Segment } from "../segment/segmenter.js";

const seg: Segment = { id: "seg-0000", latex: "Intro text.", tokens: 100 };

describe("runSectionLoop", () => {
  it("初回で pass", async () => {
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"pass","issues":[]}'
        : '{"segmentId":"seg-0000","ja":"訳文"}',
    );
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(true);
    expect(r.usedRevisions).toBe(0);
  });

  it("revise の後 pass（再訳を1回使う）", async () => {
    let ev = 0;
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("審査者")) {
        return ev++ === 0
          ? '{"verdict":"revise","issues":[{"severity":"error","message":"直す"}]}'
          : '{"verdict":"pass","issues":[]}';
      }
      return '{"segmentId":"seg-0000","ja":"訳文"}';
    });
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(true);
    expect(r.usedRevisions).toBe(1);
  });

  it("pass だが warn は warnIssues に載る", async () => {
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"pass","issues":[{"severity":"warn","message":"hedging"}]}'
        : '{"segmentId":"seg-0000","ja":"訳文"}',
    );
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(true);
    expect(r.warnIssues.map((i) => i.message)).toEqual(["hedging"]);
  });

  it("形式検査が MAX まで通らないと code 3", async () => {
    const withMath: Segment = { id: "seg", latex: "text $x$ here.", tokens: 100 };
    const c = new FakeLlmClient('{"segmentId":"seg","ja":"数式なしの訳"}');
    const r = await runSectionLoop(c, withMath, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(3);
    expect(r.usedRevisions).toBe(r.maxRevisions);
  });

  it("evaluator fail は即 code 4", async () => {
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"fail","issues":[]}'
        : '{"segmentId":"seg","ja":"訳文"}',
    );
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
    expect(r.usedRevisions).toBe(0);
  });
});
