// 契約付録 §1-8 の写経（値の正本＝docs/design/contract-appendix.md）。
import { z } from "zod";
import {
  MAX_BRIEF_CHARS,
  MAX_BRIEF_ITEMS,
  MAX_ISSUE_CHARS,
  MAX_ISSUES,
  MAX_NOTE_CHARS,
  MAX_TERM_CHARS,
  MAX_TERMS,
} from "../runtime/untrusted.js";

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
  // 空の src は seg.latex.includes("") が常に真になり、全用語が全セグメントに乗る。
  src: z.string().min(1).max(MAX_TERM_CHARS),
  form: z.string().min(1).max(MAX_TERM_CHARS),
  class: TermClass,
  rendering: Rendering,
  firstOccurrence: z.boolean(),
  note: z.string().max(MAX_NOTE_CHARS).optional(),
});
export type ResolvedTerm = z.infer<typeof ResolvedTerm>;

// ── §1 文書ブリーフ / 文体契約 ──
// 上限の理由は resolved と同じ。brief は全セグメントのプロンプトに載る。
export const DocumentBrief = z.object({
  thesis: z.string().max(MAX_BRIEF_CHARS),
  sectionRoles: z
    .array(z.object({ id: z.string().max(MAX_TERM_CHARS), role: z.string().max(MAX_BRIEF_CHARS) }))
    .max(MAX_BRIEF_ITEMS),
  notationConventions: z.array(z.string().max(MAX_BRIEF_CHARS)).max(MAX_BRIEF_ITEMS),
  claimStrengthNotes: z.array(z.string().max(MAX_BRIEF_CHARS)).max(MAX_BRIEF_ITEMS).default([]),
});
export type DocumentBrief = z.infer<typeof DocumentBrief>;

export const StyleContract = z.object({
  register: z.enum(["plain", "polite"]).default("plain"),
  tensePolicy: z.string().max(MAX_BRIEF_CHARS),
  headingStyle: z.string().max(MAX_BRIEF_CHARS),
  numberStyle: z.string().max(MAX_BRIEF_CHARS),
  notes: z.array(z.string().max(MAX_BRIEF_CHARS)).max(MAX_BRIEF_ITEMS).default([]),
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

// 小さいモデルは `{"seg-0019": {"ja": "…"}}` の形をよく返す（実測: 出力 10KB の節で
// 再試行 1 回あたり 5 分を失った）。鍵が 1 つで中身に文字列 ja があるときだけ、
// 鍵を segmentId とみなして畳む。それ以外は従来どおり落とす。契約付録 §1
function foldSingleKeyed(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (typeof o.ja === "string") return v;
  const keys = Object.keys(o);
  if (keys.length !== 1) return v;
  const inner = o[keys[0]!];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return v;
  const ja = (inner as Record<string, unknown>).ja;
  return typeof ja === "string" ? { segmentId: keys[0]!, ja } : v;
}

export const TranslatorOut = z.preprocess(
  foldSingleKeyed,
  z.object({ segmentId: z.string(), ja: z.string() }),
);
export type TranslatorOut = z.infer<typeof TranslatorOut>;

// ── §1 evaluator ─────────────────────────────────────────
export const EvalIssue = z.object({
  severity: z.enum(["error", "warn"]),
  // 上限は prompt 膨張（＝コスト増幅）と指示文の埋め込みを抑えるため。プロンプト注入 ADR(20260811)。
  message: z.string().max(MAX_ISSUE_CHARS),
  span: z.string().max(MAX_ISSUE_CHARS).optional(),
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
  issues: z.array(EvalIssue).max(MAX_ISSUES),
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
  // 件数の上限はプロンプト膨張（＝コスト増幅）を抑えるため。EvalIssue と同じ理由。
  resolved: z.array(ResolvedTerm.omit({ firstOccurrence: true })).max(MAX_TERMS),
  brief: DocumentBrief,
  style: StyleContract,
});
export type GlossaryBuilderOut = z.infer<typeof GlossaryBuilderOut>;

// ── §1 訳注（uncertainties） ──
export const NoteTrigger = z.enum([
  "paper-defined-preserve",
  "low-confidence",
  "evaluator-warn",
  "heading-untranslated",
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
export const Provider = z.enum(["ollama", "claude", "openrouter"]);
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
  // 単一ユーザ既定にフォールバックした資源。マルチテナントでは空でなければ分離できていない。
  sharedDefaults: z.array(z.enum(["db", "cacheKey", "outDir", "limits", "work"])).default([]),
  // run 中に実際に発行した LLM 呼び出し回数（失敗した run でも返す＝課金相当の仕事量）。
  llmCalls: z.number().int().nonnegative().default(0),
  // 論文タイトルの翻訳結果。null は翻訳まで到達しなかった run。契約付録 §8
  title: z.enum(["translated", "failed", "absent"]).nullable().default(null),
  exitCode: z.number().int(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const ErrorKind = z.enum([
  "input",
  "conflict",
  "too-large",
  "provider",
  "formal",
  "quality",
  "typeset",
  "canceled",
  "timeout",
  "busy",
  "upstream",
  "infra",
  "internal",
]);

export const RunError = z.object({
  kind: ErrorKind,
  code: z.number().int(),
  message: z.string(),
  detail: z.string().optional(),
});
export type RunError = z.infer<typeof RunError>;

export const Result = z.object({
  status: z.enum(["ok", "failed"]),
  pdfPath: z.string().optional(),
  exitCode: z.number().int(),
  // 失敗の理由。status="failed" のとき必ず入る（契約付録 §8）。
  error: RunError.optional(),
  summary: RunSummary,
});
export type Result = z.infer<typeof Result>;

// ── §8 LlmClient 境界 ──
// meta は呼び出し文脈（誰が・どの段・何回目か）。トレース（LlmCallEvent）へ写すためだけに使い、変換結果には影響しない。
export interface LlmCallMeta {
  role: "translator" | "evaluator" | "glossary-builder";
  phase?: "translate" | "evaluate" | "glossary";
  segmentId?: string;
  pass?: number; // 節ループの再訳回数（0=初回）
}
export interface LlmRequest {
  model?: string;
  system: string;
  user: string;
  meta?: LlmCallMeta;
  // JSON 出力を期待する呼び出し。ネイティブ構造化出力を持つプロバイダ（Ollama）だけが強制に使う。
  // claude CLI は該当機能が無いので無視しプロンプト指定に委ねる。構造化出力 ADR。
  jsonMode?: boolean;
  // 呼び出し側の中断（web でクライアントが切断した等）。プロバイダは進行中の I/O を中止する。
  signal?: AbortSignal;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

// ── §8 LLM 呼び出しトレース（local JSONL・メタのみ。本文/訳文は含めない）。LLM トレース ADR。──
// プロバイダは runId を知らないので LlmCallEvent を emit し、run 層が runId を stamp して LlmCallRecord にする。
export interface LlmCallEvent {
  ts: string; // 呼び出し完了時刻（ISO8601）
  provider: Provider;
  role?: LlmCallMeta["role"];
  phase?: LlmCallMeta["phase"];
  segmentId?: string;
  pass?: number;
  model?: string;
  latencyMs: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  // 呼び出しが失敗したか。失敗した呼び出しも課金されるので、記録から落とすと過小計上になる。
  failed?: boolean;
}
export type LlmCallRecord = LlmCallEvent & { runId: string };
export type TraceSink = (ev: LlmCallEvent) => void;
