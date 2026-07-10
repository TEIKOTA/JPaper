// 実装契約の正本（docs/design/contract-appendix.md §1-8 の zod 写経）。
// ここが全モジュール統合の「縫い目」。値の乖離は変更管理の対象。
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

// per-paper 確定辞書の1エントリ（translator へ注入する形）
export const ResolvedTerm = z.object({
  src: z.string(),
  form: z.string(), // 確定訳/表記（例: "アテンション" / "値(Value)" / "Transformer"）
  class: TermClass,
  rendering: Rendering,
  firstOccurrence: z.boolean(), // このセグメントで初出か（決定的インデクサが算出）
  note: z.string().optional(), // 訳注の文面（LLM 生成）。preserve/低確信の理由
});
export type ResolvedTerm = z.infer<typeof ResolvedTerm>;

// ── §1 文書ブリーフ / 文体契約（brief.md / style.md の正本） ──
export const DocumentBrief = z.object({
  thesis: z.string(), // 論文の主張の核
  sectionRoles: z.array(z.object({ id: z.string(), role: z.string() })), // 各節の役割
  notationConventions: z.array(z.string()), // 記法規約
  claimStrengthNotes: z.array(z.string()).default([]), // 主張強度/hedging の注意
});
export type DocumentBrief = z.infer<typeof DocumentBrief>;

export const StyleContract = z.object({
  register: z.enum(["plain", "polite"]).default("plain"), // plain=である調・常体
  tensePolicy: z.string(), // 時制方針
  headingStyle: z.string(), // 見出し訳の方針
  numberStyle: z.string(), // 数字・単位表記
  notes: z.array(z.string()).default([]),
});
export type StyleContract = z.infer<typeof StyleContract>;

// ── §1 translator ────────────────────────────────────────
export const TranslatorIn = z.object({
  segmentId: z.string(),
  latex: z.string(), // クリーンな原文 LaTeX（当該セグメント）
  glossarySlice: z.array(ResolvedTerm),
  priorJa: z.string().optional(), // 再訳時: 前回の訳
  issues: z.array(z.string()).optional(), // 再訳時: evaluator の指摘
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
  verdict: z.enum(["pass", "revise", "fail"]), // pass=抜ける / revise=issuesで再訳 / fail=即failed
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
      definedInPaper: z.boolean(), // "we define/call", \newcommand, 強調初出 で検出
    }),
  ),
});
export type GlossaryBuilderIn = z.infer<typeof GlossaryBuilderIn>;

// firstOccurrence は翻訳配線側の決定的インデクサが後付け（translator に判定させない）
export const GlossaryBuilderOut = z.object({
  resolved: z.array(ResolvedTerm.omit({ firstOccurrence: true })), // note は残す
  brief: DocumentBrief, // 全文パスの副産物（全 translator に注入）
  style: StyleContract, // 文体契約（既定=である調・常体）
});
export type GlossaryBuilderOut = z.infer<typeof GlossaryBuilderOut>;

// ── §1 訳注（uncertainties）。採否=trigger は決定的 / 文面=LLM ──
export const NoteTrigger = z.enum([
  "paper-defined-preserve",
  "low-confidence",
  "evaluator-warn",
]);
export type NoteTrigger = z.infer<typeof NoteTrigger>;

export const TranslatorNote = z.object({
  id: z.string(),
  trigger: NoteTrigger,
  src: z.string().optional(), // 対象語（term 系 trigger のとき）
  segmentId: z.string(),
  firstOccurrence: z.boolean(), // 文書全体で初出か
  text: z.string(), // 文面（term=ResolvedTerm.note / warn=EvalIssue.message）
});
export type TranslatorNote = z.infer<typeof TranslatorNote>;

// ── §5/§8 プロバイダ・入力・サマリ・結果 ──────────────────
export const Provider = z.enum(["ollama", "claude"]);
export type Provider = z.infer<typeof Provider>;

// §8 JpaperInput（正本）: CLI の <input> 文字列を判定して正規化
export const JpaperInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("arxiv"), id: z.string() }),
]);
export type JpaperInput = z.infer<typeof JpaperInput>;

// §8 RunSummary。(A) 単体では buildOk/layout は null
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

// §8 core API の戻り値。例外は投げず status/exitCode で表現
export const Result = z.object({
  status: z.enum(["ok", "failed"]),
  pdfPath: z.string().optional(),
  exitCode: z.number().int(),
  summary: RunSummary,
});
export type Result = z.infer<typeof Result>;

// ── §8 LlmClient 境界の型（正本・型のみ。実装は src/runtime/llm-client.ts） ──
// 戻り値は JSON テキスト文字列（呼び出し側が extractJson→zod.parse）。
export interface LlmRequest {
  model?: string; // claude(subprocess) では未使用＝optional、Ollama/将来 API では必須
  system: string; // §13A の3部品ビルダー出力
  user: string;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}
