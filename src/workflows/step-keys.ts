// 契約付録 §8（checkpoint の値の形と無効化キー）。translatePaper と用語集の編集（§9）が同じ関数で鍵を作る。
import { z } from "zod";
import type { DocumentBrief, ResolvedTerm, StyleContract } from "../types/contract.js";
import { EvalIssue } from "../types/contract.js";
import { hashContext } from "../durable/checkpoint.js";
import { segment, type Segment } from "../segment/segmenter.js";
import { firstCoveringSegment, uncoveredTerms, withoutPluralVariants } from "../terminology/term-coverage.js";
import type { ResolvedRow } from "../terminology/glossary-io.js";
import { extractPreamble } from "../tools/assemble-latex.js";
import {
  extractTitle,
  findBodyTitle,
  hasProse,
  type BodyTitle,
  type PaperTitle,
} from "../tools/paper-title.js";

export const IngestCache = z.object({
  cleanLatex: z.string(),
  figures: z.array(z.string()),
  paperId: z.string(),
  sourceDir: z.string(),
  mainDir: z.string(), // 旧キャッシュは mainDir 欠落で無効化され再取り込みされる（入れ子 main の図配置に必須）
  // 旧キャッシュには無いので既定 0（未解決件数を知らない＝警告を出さない側へ倒す）。
  unresolvedInputs: z.number().int().default(0),
});
export type IngestCache = z.infer<typeof IngestCache>;

export const SectionLoopCache = z.object({
  segmentId: z.string(),
  ja: z.string(),
  passed: z.boolean(),
  failCode: z.union([z.literal(3), z.literal(4)]).optional(),
  failedKinds: z.array(z.string()).default([]),
  usedRevisions: z.number().int(),
  maxRevisions: z.number().int(),
  warnIssues: z.array(EvalIssue),
  pdfName: z.string().optional(),
});
export type SectionLoopCache = z.infer<typeof SectionLoopCache>;

// title 節の checkpoint の無効化キーに足す版。名前を持たない旧 checkpoint を使わない。契約付録 §8
export const TITLE_STEP_VERSION = "pdf-name-v1";

export interface SegmentPlan {
  segments: Segment[];
  bodyTitle: BodyTitle | undefined;
}

// 本文で最初にタイトルを組む位置より前の \title は前文の \title より後に効く。その節では
// \title 命令を原文のまま残し（keep）、タイトルは title 節で 1 回だけ訳す。契約付録 §8
export function planSegments(cleanLatex: string, budget: number): SegmentPlan {
  const plain = segment(cleanLatex, budget);
  const bodyTitle = findBodyTitle(plain);
  const keepsTitle = bodyTitle?.title !== undefined && hasProse(bodyTitle.title.text);
  const segments: Segment[] = plain.map((s) =>
    keepsTitle && s.id === bodyTitle!.segmentId
      ? { ...s, keep: { start: bodyTitle!.start, end: bodyTitle!.end } }
      : s,
  );
  return { segments, bodyTitle };
}

// 本文の \title があればそちらが効くので前文は見ない。契約付録 §8
export function foundTitle(cleanLatex: string, plan: SegmentPlan): PaperTitle | undefined {
  return plan.bodyTitle !== undefined
    ? plan.bodyTitle.title
    : extractTitle(extractPreamble(cleanLatex));
}

export interface StepContext {
  resolved: readonly ResolvedRow[];
  brief: DocumentBrief;
  style: StyleContract;
}

export function segmentSlice(
  seg: Pick<Segment, "id" | "latex">,
  resolved: readonly ResolvedRow[],
  firstOcc: ReadonlyMap<string, string>,
): ResolvedTerm[] {
  return uncoveredTerms(seg.latex, withoutPluralVariants([...resolved]))
    .map((t) => ({ ...t, firstOccurrence: firstOcc.get(t.src) === seg.id })) as ResolvedTerm[];
}

// 各用語が segmentSlice で最初に効く節。契約付録 §1（節に効く用語）
export function segmentFirstOccurrence(
  segments: readonly Pick<Segment, "id" | "latex">[],
  resolved: readonly ResolvedRow[],
): Map<string, string> {
  return firstCoveringSegment([...segments], withoutPluralVariants([...resolved]));
}

// 無効化は原文＋注入コンテキスト（slice＋brief＋style）のハッシュ。
export function segmentInvalidation(
  seg: Pick<Segment, "latex" | "keep">,
  slice: readonly ResolvedTerm[],
  ctx: Pick<StepContext, "brief" | "style">,
): string {
  return hashContext(
    seg.latex,
    JSON.stringify(slice),
    JSON.stringify(ctx.brief),
    JSON.stringify(ctx.style),
    ...(seg.keep === undefined ? [] : [JSON.stringify(seg.keep)]),
  );
}

// 契約付録 §8（タイトルでは併記しない）
export function titleSlice(
  seg: Pick<Segment, "latex">,
  resolved: readonly ResolvedRow[],
): ResolvedTerm[] {
  return resolved
    .filter((t) => seg.latex.includes(t.src))
    .map((t) => ({ ...t, firstOccurrence: false })) as ResolvedTerm[];
}

export function titleInvalidation(
  seg: Pick<Segment, "latex">,
  slice: readonly ResolvedTerm[],
  ctx: Pick<StepContext, "brief" | "style">,
): string {
  return hashContext(
    seg.latex,
    JSON.stringify(slice),
    JSON.stringify(ctx.brief),
    JSON.stringify(ctx.style),
    TITLE_STEP_VERSION,
  );
}
