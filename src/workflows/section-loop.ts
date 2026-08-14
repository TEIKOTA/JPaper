// 契約付録 §3・§8。節ループ（形式検査＋evaluator＋再訳・MAX_REVISIONS）。
import type {
  LlmClient,
  ResolvedTerm,
  EvalIssue,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
import type { Segment } from "../segment/segmenter.js";
import { maxRevisionsFor } from "../segment/segmenter.js";
import { formalCheck, type FormalIssue } from "./quality-gate.js";
import { protectMath, restoreMath, describeMarkIssues } from "../segment/protect.js";
import { translate } from "../agents/translator.js";
import { evaluate } from "../agents/evaluator.js";

export interface SectionLoopResult {
  segmentId: string;
  ja: string;
  passed: boolean;
  failCode?: 3 | 4;
  // 落ちた形式検査の種別。「数式を 1 つ落とした」と「危険コマンドを注入された」を
  // 同じ見た目で返すと、運用者は汚染に気づけない（メッセージはどこにも出力されない）。
  failedKinds: FormalIssue["kind"][];
  usedRevisions: number;
  maxRevisions: number;
  warnIssues: EvalIssue[];
}

export interface DocContext {
  brief?: DocumentBrief;
  style?: StyleContract;
}

export async function runSectionLoop(
  client: LlmClient,
  segment: Segment,
  glossarySlice: ResolvedTerm[],
  doc: DocContext = {},
): Promise<SectionLoopResult> {
  // 形式と品質は別の予算を持つ。共有すると、形式で手こずった節は品質の改稿を
  // 1 度も試せずに落ちる。ADR 20260815。
  const perChecker = maxRevisionsFor(segment.tokens);
  const maxRevisions = perChecker * 2;
  let formalLeft = perChecker;
  let qualityLeft = perChecker;
  // 数式は印へ差し替えて渡す。ループは印のまま回し（差し戻す前回訳も印のまま）、
  // 検査と成果物の直前でだけ復元する。契約付録 §3。
  const guarded = protectMath(segment.latex);
  let revisions = 0;
  let priorJa: string | undefined;
  let issues: string[] | undefined;
  let lastJa = "";
  let lastFailCode: 3 | 4 = 3;
  let lastKinds: FormalIssue["kind"][] = [];

  while (true) {
    const out = await translate(
      client,
      {
        segmentId: segment.id,
        latex: guarded.text,
        glossarySlice,
        priorJa,
        issues,
      },
      doc,
      revisions,
    );
    const restored = restoreMath(out.ja, guarded.spans);
    lastJa = restored.text;

    // 印の欠落は formalCheck では「数式個数不一致」としか出ない。どの印かを名指しする。
    const markIssues = describeMarkIssues(restored);
    const formal = formalCheck(segment.latex, restored.text, glossarySlice);
    // 危険コマンドと文書構造の破壊は再訳の対象にしない（直せる誤りではなく、汚染の兆候
    // として即失敗させる）。\end{document} は組版が正常終了するぶん、素通しの害が大きい。
    lastKinds = [...new Set(formal.map((f) => f.kind))];
    if (formal.some((f) => f.kind === "unsafe-command" || f.kind === "structure")) {
      lastFailCode = 3;
      break;
    }
    if (formal.length > 0) {
      lastFailCode = 3;
      if (formalLeft <= 0) break;
      formalLeft--;
      revisions++;
      priorJa = out.ja;
      issues = [...markIssues, ...formal.map((f) => f.message)];
      continue;
    }

    const ev = await evaluate(
      client,
      { segmentId: segment.id, srcLatex: segment.latex, ja: restored.text },
      { glossary: glossarySlice, brief: doc.brief, style: doc.style },
      revisions,
    );
    // 契約 §3: 出版可能＝verdict≠fail かつ error 級 issue が無い。warn は非ブロッキングで訳注へ流す。
    // error があれば pass verdict でも通さない（重大問題の素通しを防ぐ）。fail は常に失敗。
    const hasError = ev.issues.some((i) => i.severity === "error");
    if (ev.verdict !== "fail" && !hasError) {
      return {
        segmentId: segment.id,
        ja: restored.text,
        passed: true,
        failedKinds: [],
        usedRevisions: revisions,
        maxRevisions,
        warnIssues: ev.issues.filter((i) => i.severity === "warn"),
      };
    }
    lastFailCode = 4;
    lastKinds = [];
    // fail は「この訳が不可」であって「この節が訳せない」ではない。指摘を渡さずに
    // 捨てるのは、1 呼び出しを節約するために節 1 本を失う取引になる。ADR 20260815。
    if (qualityLeft <= 0) break;
    qualityLeft--;
    revisions++;
    priorJa = out.ja;
    issues = ev.issues.map((i) => i.message);
  }

  return {
    segmentId: segment.id,
    ja: lastJa,
    passed: false,
    failCode: lastFailCode,
    failedKinds: lastKinds,
    usedRevisions: revisions,
    maxRevisions,
    warnIssues: [],
  };
}
