// 契約付録 §1・§3。evaluator（純変換器）。
import type {
  LlmClient,
  EvaluatorIn,
  ResolvedTerm,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
import { EvaluatorOut } from "../types/contract.js";
import { runAgent } from "../runtime/llm-client.js";
import { buildSystemPrompt } from "../runtime/system-prompt.js";

export interface EvalContext {
  glossary?: ResolvedTerm[];
  brief?: DocumentBrief;
  style?: StyleContract;
}

function renderUser(input: EvaluatorIn): string {
  return [
    `# セグメント ${input.segmentId}`,
    "## 原文 LaTeX",
    input.srcLatex,
    "## 訳文",
    input.ja,
    "## 指示",
    'JSON だけを返す。形式: {"verdict":"pass"|"revise"|"fail","issues":[{"severity":"error"|"warn","message":"指摘文","span":"該当箇所(任意)"}]}。' +
      "指摘が無ければ issues は空配列。issues は必ずこのオブジェクト形式（文字列の配列にしない）。",
  ].join("\n\n");
}

export async function evaluate(
  client: LlmClient,
  input: EvaluatorIn,
  ctx: EvalContext = {},
  pass?: number,
): Promise<EvaluatorOut> {
  const system = buildSystemPrompt("evaluator", {
    glossary: ctx.glossary ?? [],
    brief: ctx.brief,
    style: ctx.style,
  });
  return runAgent(
    client,
    {
      system,
      user: renderUser(input),
      meta: { role: "evaluator", phase: "evaluate", segmentId: input.segmentId, pass },
    },
    EvaluatorOut,
  );
}
