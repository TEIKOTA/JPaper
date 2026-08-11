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
import { formalCheck } from "./quality-gate.js";
import { translate } from "../agents/translator.js";
import { evaluate } from "../agents/evaluator.js";

export interface SectionLoopResult {
  segmentId: string;
  ja: string;
  passed: boolean;
  failCode?: 3 | 4;
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
  const maxRevisions = maxRevisionsFor(segment.tokens);
  let revisions = 0;
  let priorJa: string | undefined;
  let issues: string[] | undefined;
  let lastJa = "";
  let lastFailCode: 3 | 4 = 3;

  while (true) {
    const out = await translate(
      client,
      {
        segmentId: segment.id,
        latex: segment.latex,
        glossarySlice,
        priorJa,
        issues,
      },
      doc,
      revisions,
    );
    lastJa = out.ja;

    const formal = formalCheck(segment.latex, out.ja, glossarySlice);
    // 危険コマンドと文書構造の破壊は再訳の対象にしない（直せる誤りではなく、汚染の兆候
    // として即失敗させる）。\end{document} は組版が正常終了するぶん、素通しの害が大きい。
    if (formal.some((f) => f.kind === "unsafe-command" || f.kind === "structure")) {
      lastFailCode = 3;
      break;
    }
    if (formal.length > 0) {
      lastFailCode = 3;
      if (revisions >= maxRevisions) break;
      revisions++;
      priorJa = out.ja;
      issues = formal.map((f) => f.message);
      continue;
    }

    const ev = await evaluate(
      client,
      { segmentId: segment.id, srcLatex: segment.latex, ja: out.ja },
      { glossary: glossarySlice, brief: doc.brief, style: doc.style },
      revisions,
    );
    // 契約 §3: 出版可能＝verdict≠fail かつ error 級 issue が無い。warn は非ブロッキングで訳注へ流す。
    // error があれば pass verdict でも通さない（重大問題の素通しを防ぐ）。fail は常に失敗。
    const hasError = ev.issues.some((i) => i.severity === "error");
    if (ev.verdict !== "fail" && !hasError) {
      return {
        segmentId: segment.id,
        ja: out.ja,
        passed: true,
        usedRevisions: revisions,
        maxRevisions,
        warnIssues: ev.issues.filter((i) => i.severity === "warn"),
      };
    }
    lastFailCode = 4;
    if (ev.verdict === "fail" || revisions >= maxRevisions) break;
    revisions++;
    priorJa = out.ja;
    issues = ev.issues.map((i) => i.message);
  }

  return {
    segmentId: segment.id,
    ja: lastJa,
    passed: false,
    failCode: lastFailCode,
    usedRevisions: revisions,
    maxRevisions,
    warnIssues: [],
  };
}
