// 契約付録 §1-8 の zod 写経（値の正本＝docs/design/contract-appendix.md）。全モジュール統合の縫い目。
import { z } from "zod";

// ── §1 用語 ───────────────────────────────────────────────
export const TermClass = z.enum([
  "established",
  "paper-defined",
  "proper-noun",
  "do-not-translate",
]);
export type TermClass = z.infer<typeof TermClass>;

export const Rendering = z.enum(["translate", "bilingual", "keep-original"]);
export type Rendering = z.infer<typeof Rendering>;

export const ResolvedTerm = z.object({
  src: z.string(),
  form: z.string(),
  class: TermClass,
  rendering: Rendering,
  firstOccurrence: z.boolean(),
  note: z.string().optional(),
});
export type ResolvedTerm = z.infer<typeof ResolvedTerm>;

// ── §1 文書ブリーフ / 文体契約 ──
export const DocumentBrief = z.object({
  thesis: z.string(),
  sectionRoles: z.array(z.object({ id: z.string(), role: z.string() })),
  notationConventions: z.array(z.string()),
  claimStrengthNotes: z.array(z.string()).default([]),
});
export type DocumentBrief = z.infer<typeof DocumentBrief>;

export const StyleContract = z.object({
  register: z.enum(["plain", "polite"]).default("plain"),
  tensePolicy: z.string(),
  headingStyle: z.string(),
  numberStyle: z.string(),
  notes: z.array(z.string()).default([]),
});
export type StyleContract = z.infer<typeof StyleContract>;

// ── §1 translator ────────────────────────────────────────
export const TranslatorIn = z.object({
  segmentId: z.string(),
  latex: z.string(),
  glossarySlice: z.array(ResolvedTerm),
  priorJa: z.string().optional(),
  issues: z.array(z.string()).optional(),
});
export type TranslatorIn = z.infer<typeof TranslatorIn>;

export const TranslatorOut = z.object({ segmentId: z.string(), ja: z.string() });
export type TranslatorOut = z.infer<typeof TranslatorOut>;

// ── §1 evaluator ─────────────────────────────────────────
export const EvalIssue = z.object({
  severity: z.enum(["error", "warn"]),
  message: z.string(),
  span: z.string().optional(),
});
export type EvalIssue = z.infer<typeof EvalIssue>;

export const EvaluatorIn = z.object({
  segmentId: z.string(),
  srcLatex: z.string(),
  ja: z.string(),
});
export type EvaluatorIn = z.infer<typeof EvaluatorIn>;

export const EvaluatorOut = z.object({
  verdict: z.enum(["pass", "revise", "fail"]),
  issues: z.array(EvalIssue),
});
export type EvaluatorOut = z.infer<typeof EvaluatorOut>;

// ── §1 glossary-builder ──────────────────────────────────
export const GlossaryBuilderIn = z.object({
  paperId: z.string(),
  candidates: z.array(
    z.object({
      src: z.string(),
      globalCandidates: z.array(
        z.object({
          ja: z.string(),
          domain: z.string().optional(),
          description: z.string().optional(),
        }),
      ),
      definedInPaper: z.boolean(),
    }),
  ),
});
export type GlossaryBuilderIn = z.infer<typeof GlossaryBuilderIn>;

export const GlossaryBuilderOut = z.object({
  resolved: z.array(ResolvedTerm.omit({ firstOccurrence: true })),
  brief: DocumentBrief,
  style: StyleContract,
});
export type GlossaryBuilderOut = z.infer<typeof GlossaryBuilderOut>;

// ── §1 訳注（uncertainties） ──
export const NoteTrigger = z.enum([
  "paper-defined-preserve",
  "low-confidence",
  "evaluator-warn",
]);
export type NoteTrigger = z.infer<typeof NoteTrigger>;

export const TranslatorNote = z.object({
  id: z.string(),
  trigger: NoteTrigger,
  src: z.string().optional(),
  segmentId: z.string(),
  firstOccurrence: z.boolean(),
  text: z.string(),
});
export type TranslatorNote = z.infer<typeof TranslatorNote>;

// ── §5/§8 プロバイダ・入力・サマリ・結果 ──────────────────
export const Provider = z.enum(["ollama", "claude"]);
export type Provider = z.infer<typeof Provider>;

export const JpaperInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("arxiv"), id: z.string() }),
]);
export type JpaperInput = z.infer<typeof JpaperInput>;

export const RunSummary = z.object({
  paperId: z.string(),
  outDir: z.string(),
  segments: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  }),
  revisions: z.object({ max: z.number().int(), used: z.number().int() }),
  glossary: z.object({ proposedAdded: z.number().int() }),
  notes: z.object({
    total: z.number().int(),
    byTrigger: z.record(NoteTrigger, z.number().int()),
  }),
  layout: z.enum(["original", "template"]).nullable(),
  buildOk: z.boolean().nullable(),
  exitCode: z.number().int(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const Result = z.object({
  status: z.enum(["ok", "failed"]),
  pdfPath: z.string().optional(),
  exitCode: z.number().int(),
  summary: RunSummary,
});
export type Result = z.infer<typeof Result>;

// ── §8 LlmClient 境界 ──
export interface LlmRequest {
  model?: string;
  system: string;
  user: string;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}
