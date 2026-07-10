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
    'verdict（pass/revise/fail）と issues を {"verdict": "…", "issues": [...]} の JSON だけで返す。',
  ].join("\n\n");
}

export async function evaluate(
  client: LlmClient,
  input: EvaluatorIn,
  ctx: EvalContext = {},
): Promise<EvaluatorOut> {
  const system = buildSystemPrompt("evaluator", {
    glossary: ctx.glossary ?? [],
    brief: ctx.brief,
    style: ctx.style,
  });
  return runAgent(client, { system, user: renderUser(input) }, EvaluatorOut);
}
