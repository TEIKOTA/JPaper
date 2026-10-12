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
    // 形式の予算だけを使い切る。品質の予算は手つかずで残る（ADR 20260815）。
    expect(r.usedRevisions).toBe(r.maxRevisions / 2);
  });

  it("evaluator fail でも品質の予算が残る限り訳し直し、尽きたら code 4", async () => {
    // fail は「この訳が不可」であって「この節が訳せない」ではない。指摘を渡さずに
    // 捨てるのは、1 呼び出しを節約するために節 1 本を失う取引になる。ADR 20260815。
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"fail","issues":[]}'
        : '{"segmentId":"seg","ja":"訳文"}',
    );
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
    expect(r.usedRevisions).toBe(r.maxRevisions / 2);
  });

  it("品質で落ちた節は最後の evaluator の verdict と指摘を持つ（契約付録 §8）", async () => {
    let ev = 0;
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? `{"verdict":"revise","issues":[{"severity":"error","message":"指摘${String(ev++)}","span":"訳文"},{"severity":"warn","message":"軽微"}]}`
        : '{"segmentId":"seg","ja":"訳文"}',
    );
    const r = await runSectionLoop(c, seg, []);
    expect(r.failCode).toBe(4);
    expect(r.lastIssues).toEqual({
      by: "evaluator",
      verdict: "revise",
      issues: [
        { severity: "error", message: `指摘${String(ev - 1)}`, span: "訳文" },
        { severity: "warn", message: "軽微" },
      ],
    });
  });

  it("形式で落ちた節は最後の稿の形式検査の指摘を持ち、通った節は持たない", async () => {
    const withMath: Segment = { id: "seg", latex: "text $x$ here.", tokens: 100 };
    const failed = await runSectionLoop(new FakeLlmClient('{"segmentId":"seg","ja":"数式なしの訳"}'), withMath, []);
    expect(failed.lastIssues?.by).toBe("formal");
    expect(failed.lastIssues?.issues.map((i) => ("kind" in i ? i.kind : undefined))).toContain("math");
    const ok = await runSectionLoop(
      new FakeLlmClient((req) =>
        req.system.includes("審査者") ? '{"verdict":"pass","issues":[]}' : '{"segmentId":"seg-0000","ja":"訳文"}',
      ),
      seg,
      [],
    );
    expect(ok.lastIssues).toBeUndefined();
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
    expect(r.usedRevisions).toBe(r.maxRevisions / 2); // 品質の予算だけを使い切る
  });

  it("revise + [warn, error] 混在は error 扱いで通さない（warn に紛れた error を逃さない）", async () => {
    const c = new FakeLlmClient(evalReply("revise", `${WARN},${ERROR}`));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
  });

  it("fail は issues が warn/空でも pass にはしない（verdict が最優先）", async () => {
    // 再訳の機会は与えるが、fail のまま予算が尽きれば失敗させる。不変条件は変えない。
    const c = new FakeLlmClient(evalReply("fail", WARN));
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(4);
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

describe("数式の扱い（保護は既定で入れてある）", () => {
  const mathSeg: Segment = {
    id: "seg-0000",
    latex: "We set $\\alpha = 0.05$ and report $0.83 \\pm 0.05$ here.",
    tokens: 100,
  };

  it("数式は印へ差し替えて translator へ渡し、訳文へ復元する", async () => {
    // 保護の要否はモデルの能力で決まる。26B は印を扱えるが、保護が無いと似た綴りの
    // 略語を書き写せない。ADR 20260816-protection-depends-on-model-capability。
    let sawMath = false;
    let sawMark = false;
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      if (req.user.includes("\\alpha")) sawMath = true;
      if (req.user.includes("〔1〕")) sawMark = true;
      return "```tex\nここでは 〔1〕 を設定し、〔2〕 を報告する。\n```";
    });
    const r = await runSectionLoop(c, mathSeg, []);
    expect(sawMark).toBe(true);
    expect(sawMath).toBe(false); // 数式の中身はモデルへ渡らない＝書き写しの機会を与えない
    expect(r.passed).toBe(true);
    expect(r.ja).toContain("$\\alpha = 0.05$"); // 復元されている
    expect(r.ja).not.toContain("〔");
  });

  it("数式を落とした訳は math で差し戻し、直れば通る", async () => {
    let pass = 0;
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return pass++ === 0
        ? '{"segmentId":"seg-0000","ja":"ここでは $\\alpha = 0.05$ だけを設定する。"}'
        : JSON.stringify({
            segmentId: "seg-0000",
            ja: "ここでは $\\alpha = 0.05$ を設定し、$0.83 \\pm 0.05$ を報告する。",
          });
    });
    const r = await runSectionLoop(c, mathSeg, []);
    expect(r.passed).toBe(true);
    expect(r.usedRevisions).toBe(1);
  });

  it("直らなければ形式の予算を使い切って math で落ちる", async () => {
    const c = new FakeLlmClient((req) =>
      req.system.includes("審査者")
        ? '{"verdict":"pass","issues":[]}'
        : '{"segmentId":"seg-0000","ja":"数式のない訳文である。"}',
    );
    const r = await runSectionLoop(c, mathSeg, []);
    expect(r.passed).toBe(false);
    expect(r.failedKinds).toContain("math");
  });
});

describe("runSectionLoop: 改稿予算の配分", () => {
  const withMath: Segment = { id: "seg", latex: "text $x$ here.", tokens: 100 };

  it("形式で予算を使い切っても、品質の改稿はそこから始まる（実測 seg-0007 の経路）", async () => {
    // 形式で 3 回差し戻したあと形式を通過し、そこで初めて evaluator が走る。
    // 予算を共有していた頃は、この時点で残高ゼロ＝改稿を 1 度も試せずに落ちた。
    let translatorCalls = 0;
    let evaluatorCalls = 0;
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("審査者")) {
        evaluatorCalls++;
        return '{"verdict":"revise","issues":[{"severity":"error","message":"語調"}]}';
      }
      translatorCalls++;
      // 最初の 3 回は数式を落として形式検査に落ちる。
      return translatorCalls <= 3
        ? '{"segmentId":"seg","ja":"数式なしの訳"}'
        : '{"segmentId":"seg","ja":"訳文 $x$ である。"}';
    });
    const r = await runSectionLoop(c, withMath, []);
    expect(r.failCode).toBe(4); // 形式ではなく品質で落ちた＝形式は通過している
    expect(evaluatorCalls).toBeGreaterThan(1); // 品質の改稿が実際に走った
    expect(r.usedRevisions).toBe(r.maxRevisions); // 形式 3 + 品質 3
  });

  it("節あたりのコストは 1 + 形式上限 + 品質上限 で有界（往復しても止まる）", async () => {
    // 形式と品質を交互に落として往復させる。両方の予算が単調に減るので停止する。
    let n = 0;
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("審査者")) {
        return '{"verdict":"revise","issues":[{"severity":"error","message":"語調"}]}';
      }
      n++;
      return n % 2 === 1
        ? '{"segmentId":"seg","ja":"数式なしの訳"}'
        : '{"segmentId":"seg","ja":"訳文 $x$ である。"}';
    });
    const r = await runSectionLoop(c, withMath, []);
    expect(r.passed).toBe(false);
    expect(n).toBeLessThanOrEqual(1 + r.maxRevisions);
  });

  it("汚染系は予算に関係なく即失敗のまま（再訳しても直る性質ではない）", async () => {
    let translatorCalls = 0;
    const c = new FakeLlmClient(() => {
      translatorCalls++;
      return '{"segmentId":"seg","ja":"訳文 \\\\write18{rm -rf /} である。"}';
    });
    const r = await runSectionLoop(c, seg, []);
    expect(r.passed).toBe(false);
    expect(r.failedKinds).toContain("unsafe-command");
    expect(translatorCalls).toBe(1);
  });

  describe("keep（本文中の \\title を原文のまま残す。契約付録 §8）", () => {
    const latex = "\\title{Alpha Study}\n\\author{A}\n\nAlpha text is here.";
    const titleSeg: Segment = {
      id: "seg-0000",
      latex,
      tokens: 100,
      keep: { start: 0, end: "\\title{Alpha Study}".length },
    };

    it("\\title を印で伏せて送り、原文のまま復元する。evaluator には \\title を見せない", async () => {
      const users: string[] = [];
      const c = new FakeLlmClient((req) => {
        users.push(req.user);
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return "```tex\n〔1〕\n〔2〕\n\n甲の本文がここにある。\n```";
      });
      const r = await runSectionLoop(c, titleSeg, []);
      expect(r.passed).toBe(true);
      expect(r.ja).toBe("\\title{Alpha Study}\n\\author{A}\n\n甲の本文がここにある。");
      expect(users.every((u) => !u.includes("Alpha Study"))).toBe(true);
    });

    it("印を落とした訳は title で差し戻し、直れば通る", async () => {
      let n = 0;
      const translatorUsers: string[] = [];
      const c = new FakeLlmClient((req) => {
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        translatorUsers.push(req.user);
        return n++ === 0
          ? "```tex\n〔2〕\n\n甲の本文がここにある。\n```"
          : "```tex\n〔1〕\n〔2〕\n\n甲の本文がここにある。\n```";
      });
      const r = await runSectionLoop(c, titleSeg, []);
      expect(r.passed).toBe(true);
      expect(r.usedRevisions).toBe(1);
      expect(translatorUsers[1]).toContain("論文タイトルの差し替え");
      expect(r.ja.startsWith("\\title{Alpha Study}")).toBe(true);
    });

    it("印を最後まで落とし続けたら title で失敗する", async () => {
      const c = new FakeLlmClient((req) =>
        req.system.includes("審査者")
          ? '{"verdict":"pass","issues":[]}'
          : "```tex\n〔2〕\n\n甲の本文がここにある。\n```",
      );
      const r = await runSectionLoop(c, titleSeg, []);
      expect(r.passed).toBe(false);
      expect(r.failedKinds).toEqual(["title"]);
    });
  });

  describe("\\author（著者・所属を原文のまま残す。契約付録 §3）", () => {
    const latex = "\\author{Ann Lee \\\\ Nankai University\\\\ Bo Li \\\\ Berkeley Lab\\\\ }\n\nAlpha text is here.";
    const authorSeg: Segment = { id: "seg-0000", latex, tokens: 100 };
    const block = latex.slice(0, latex.indexOf("\n"));

    it("\\author を印で伏せて送り、原文のまま復元する。translator・evaluator には著者を見せない", async () => {
      const users: string[] = [];
      const c = new FakeLlmClient((req) => {
        users.push(req.user);
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return "```tex\n〔1〕\n\n甲の本文がここにある。\n```";
      });
      const r = await runSectionLoop(c, authorSeg, []);
      expect(r.passed).toBe(true);
      expect(r.ja).toBe(`${block}\n\n甲の本文がここにある。`);
      expect(users.every((u) => !u.includes("Nankai"))).toBe(true);
    });

    it("印を落とした訳は author で差し戻し、最後まで落とせば author で失敗する", async () => {
      const translatorUsers: string[] = [];
      const c = new FakeLlmClient((req) => {
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        translatorUsers.push(req.user);
        return "```tex\n甲の本文がここにある。\n```";
      });
      const r = await runSectionLoop(c, authorSeg, []);
      expect(r.passed).toBe(false);
      expect(r.failedKinds).toEqual(["author"]);
      expect(translatorUsers[1]).toContain("著者・所属・注記の差し替え");
    });

    it("伏せた \\author の前後の綴りをつなげて数えない（\\fi の直後に英字が続いても条件分岐の個数がそろう）", async () => {
      const src = "\\ifanon x\\fi\\author{A}and text.";
      const c = new FakeLlmClient((req) =>
        req.system.includes("審査者") ? '{"verdict":"pass","issues":[]}' : "```tex\n\\ifanon x\\fi〔1〕と本文。\n```",
      );
      const r = await runSectionLoop(c, { id: "seg-0000", latex: src, tokens: 100 }, []);
      expect(r.failedKinds).toEqual([]);
      expect(r.passed).toBe(true);
      expect(r.ja).toBe("\\ifanon x\\fi\\author{A}と本文。");
    });
  });
});
