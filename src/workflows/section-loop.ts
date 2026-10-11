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
import {
  protectMath,
  restoreMath,
  describeMarkIssues,
  MARK_OPEN,
  MARK_CLOSE,
} from "../segment/protect.js";
import { translate } from "../agents/translator.js";
import { commandSpans, removeSpans, type Span } from "../tools/tex-spans.js";
import { evaluate } from "../agents/evaluator.js";
import { normalizeSlug } from "../tools/pdf-name.js";

// 数式・記号を印へ差し替えるか。既定は true（ADR 20260816-protection-depends-on-model-capability）。
// モデル依存の既定で、切り替えはこの 1 行。判断材料は「落ちた節の数」と「1 節あたりの改稿回数」。
const PROTECT_SPANS = true;

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
  // segment.askPdfName のとき、通過した稿の名前を整えたもの（無い・不正なら undefined）。契約付録 §8
  pdfName?: string;
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
  // 保護区間は既定で入れる。ADR 20260816-protection-depends-on-model-capability。
  const keep = segment.keep;
  // 著者・所属は訳さず原文のまま残す。契約付録 §3
  const authors = commandSpans(segment.latex, "author");
  const guarded = protectMath(segment.latex, {
    off: !PROTECT_SPANS,
    ...(keep === undefined ? {} : { keep: [keep.start, keep.end] as [number, number] }),
    ...(authors.length === 0 ? {} : { frozen: authors }),
  });
  // 原文のまま残した \title・\author は形式検査・evaluator に見せない（訳されていないのが正しい）。契約付録 §3・§8
  const kept = guarded.keepMark;
  const frozenMarks = guarded.frozenMarks ?? [];
  const hidden: Span[] = [
    ...(kept === undefined || keep === undefined ? [] : [[keep.start, keep.end] as Span]),
    ...(frozenMarks.length === 0 ? [] : authors),
  ];
  const hiddenMarks = new Set([...(kept === undefined ? [] : [kept]), ...frozenMarks]);
  const checkedSrc = removeSpans(segment.latex, hidden);
  const checkedSpans = guarded.spans.map((s, i) => (hiddenMarks.has(i + 1) ? "" : s));
  let revisions = 0;
  let priorJa: string | undefined;
  let issues: string[] | undefined;
  let lastJa = "";
  let lastFailCode: 3 | 4 = 3;
  let lastKinds: FormalIssue["kind"][] = [];
  // 名前の行を最後に出した稿の値（改稿で行を落としても前の稿の名前を使う）。契約付録 §8
  let lastName: string | undefined;

  while (true) {
    const out = await translate(
      client,
      {
        segmentId: segment.id,
        latex: guarded.text,
        glossarySlice,
        priorJa,
        issues,
        ...(segment.askPdfName === true ? { askPdfName: true } : {}),
      },
      doc,
      revisions,
    );
    if (out.pdfName !== undefined) lastName = out.pdfName;
    const restored = restoreMath(out.ja, guarded.spans);
    lastJa = restored.text;
    const checked = hiddenMarks.size === 0 ? restored : restoreMath(out.ja, checkedSpans);

    // 印の欠落は formalCheck では「数式個数不一致」としか出ない。どの印かを名指しする。
    const markIssues = describeMarkIssues({
      ...restored,
      missing: restored.missing.filter((n) => !hiddenMarks.has(n)),
      duplicated: restored.duplicated.filter((n) => !hiddenMarks.has(n)),
    });
    const keptIssues: FormalIssue[] =
      kept !== undefined && (restored.missing.includes(kept) || restored.duplicated.includes(kept))
        ? [
            {
              kind: "title",
              message: `印 ${MARK_OPEN}${String(kept)}${MARK_CLOSE} は論文タイトルの差し替えです。訳さず消さず、原文と同じ位置にちょうど 1 回置いてください。`,
            },
          ]
        : [];
    const frozenIssues: FormalIssue[] = frozenMarks
      .filter((m) => restored.missing.includes(m) || restored.duplicated.includes(m))
      .map((m) => ({
        kind: "author",
        message: `印 ${MARK_OPEN}${String(m)}${MARK_CLOSE} は著者・所属の差し替えです。訳さず消さず、原文と同じ位置にちょうど 1 回置いてください。`,
      }));
    const formal = [...keptIssues, ...frozenIssues, ...formalCheck(checkedSrc, checked.text, glossarySlice)];
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
      { segmentId: segment.id, srcLatex: checkedSrc, ja: checked.text },
      { glossary: glossarySlice, brief: doc.brief, style: doc.style },
      revisions,
    );
    // 契約 §3: 出版可能＝verdict≠fail かつ error 級 issue が無い。warn は非ブロッキングで訳注へ流す。
    // error があれば pass verdict でも通さない（重大問題の素通しを防ぐ）。fail は常に失敗。
    const hasError = ev.issues.some((i) => i.severity === "error");
    if (ev.verdict !== "fail" && !hasError) {
      const pdfName = lastName === undefined ? undefined : normalizeSlug(lastName);
      return {
        ...(pdfName === undefined ? {} : { pdfName }),
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
