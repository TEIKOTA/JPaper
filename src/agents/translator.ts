// 契約付録 §1。translator（純変換器）。
import type {
  LlmClient,
  TranslatorIn,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
import { TranslatorOut } from "../types/contract.js";
import { runAgent } from "../runtime/llm-client.js";
import { buildSystemPrompt, renderGlossaryBlock } from "../runtime/system-prompt.js";

export interface DocContext {
  brief?: DocumentBrief;
  style?: StyleContract;
}

function renderUser(input: TranslatorIn): string {
  const lines = [`# セグメント ${input.segmentId}`, "## 原文 LaTeX", input.latex];
  lines.push(renderGlossaryBlock(input.glossarySlice)); // per-segment 用語は user 側（system の cache prefix を保つ）
  if (input.priorJa) lines.push("## 前回の訳（改稿対象）", input.priorJa);
  if (input.issues && input.issues.length > 0) {
    lines.push("## 指摘（これらを直す）", input.issues.map((i) => `- ${i}`).join("\n"));
  }
  lines.push(
    "## 指示",
    '本文のみを日本語に訳し、{"segmentId": "…", "ja": "…"} の JSON だけを返す。',
  );
  return lines.join("\n\n");
}

export async function translate(
  client: LlmClient,
  input: TranslatorIn,
  doc: DocContext = {},
  pass?: number,
): Promise<TranslatorOut> {
  const system = buildSystemPrompt("translator", {
    brief: doc.brief,
    style: doc.style,
  });
  return runAgent(
    client,
    {
      system,
      user: renderUser(input),
      meta: { role: "translator", phase: "translate", segmentId: input.segmentId, pass },
    },
    TranslatorOut,
  );
}
