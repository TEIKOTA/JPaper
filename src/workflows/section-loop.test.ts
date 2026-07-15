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

// 敵対的: 品質ゲートを潜り抜けられないことを決定的に保証する（契約 §3）。
describe("runSectionLoop: 抜け穴を塞ぐ（敵対的）", () => {
  const evalReply = (verdict: string, issues: string) => (req: { system: string }) =>
    req.system.includes("審査者")
      ? `{"verdict":"${verdict}","issues":[${issues}]}`
      : '{"segmentId":"seg-0000","ja":"訳文"}';
  const WARN = '{"severity":"warn","message":"表記ゆれ"}';
  const ERROR = '{"severity":"error","message":"意味の反転"}';

  it("revise + warn のみ → 訳注化して pass（warn 1個で全体を落とさない＝seg-0001 修正）", async () => {
    const c = new FakeLlmClient(evalReply("revise", WARN));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(true);
    expect(r.usedRevisions).toBe(0); // 再訳を無駄に回さず即 pass
    expect(r.warnIssues.map((i) => i.message)).toEqual(["表記ゆれ"]);
  });

  it("pass verdict でも error 級 issue があれば通さない（重大問題の素通しを防ぐ）", async () => {
    const c = new FakeLlmClient(evalReply("pass", ERROR));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
    expect(r.usedRevisions).toBe(r.maxRevisions);
  });

  it("revise + [warn, error] 混在は error 扱いで通さない（warn に紛れた error を逃さない）", async () => {
    const c = new FakeLlmClient(evalReply("revise", `${WARN},${ERROR}`));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
  });

  it("fail は issues が warn/空でも即失敗（verdict が最優先）", async () => {
    const c = new FakeLlmClient(evalReply("fail", WARN));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
    expect(r.usedRevisions).toBe(0);
  });

  it("severity ラベルを信頼する（message 本文は解析しない）＝意味反転でも warn と付ければ通す設計", async () => {
    // 信頼境界の明示化: 決定的層は issue.message の散文を解釈しない（脆い文字列一致に頼らない）。
    // 意味反転など地の文の意味的欠陥の検出は evaluator の severity 割当に委ねる（契約 §3・EVAL_RUBRIC）。
    // 決定的に落とせるのは §7 形式検査（数式・引用・keep-original）だけ。ここはその設計を回帰で固定する。
    const c = new FakeLlmClient(evalReply("revise", '{"severity":"warn","message":"意味が反転している"}'));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(true); // message に「反転」とあっても warn ラベルなら訳注化して通す（by-design）
    expect(r.warnIssues.map((i) => i.message)).toEqual(["意味が反転している"]);
  });

  it("形式検査（数式欠落）は evaluator が pass と言っても迂回できない（決定的ハードゲート）", async () => {
    const withMath: Segment = { id: "seg", latex: "text $x$ here.", tokens: 100 };
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"pass","issues":[]}' // 評価者は通そうとするが
        : '{"segmentId":"seg","ja":"数式のない訳"}',
    );
    const r = await runSectionLoop(c, withMath, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(3); // 形式検査で確実に止まる
  });
});
