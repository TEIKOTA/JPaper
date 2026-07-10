// 契約付録 §1・§4。glossary-builder（純変換器・全文1回）。
import type { LlmClient, GlossaryBuilderIn } from "../types/contract.js";
import { GlossaryBuilderOut } from "../types/contract.js";
import { runAgent } from "../runtime/llm-client.js";
import { buildSystemPrompt } from "../runtime/system-prompt.js";

function renderUser(input: GlossaryBuilderIn): string {
  const cands = input.candidates
    .map((c) => {
      const globals = c.globalCandidates
        .map((g) => `${g.ja}${g.domain ? `(${g.domain})` : ""}`)
        .join(", ");
      return `- ${c.src}${c.definedInPaper ? " [論文内定義]" : ""}: ${globals || "候補なし"}`;
    })
    .join("\n");
  return [
    `# 論文 ${input.paperId} の用語確定`,
    "## 収集候補（src [論文内定義]: グローバル候補）",
    cands || "（候補なし）",
    "## 指示",
    "各用語の確定訳・class・rendering を定め、文書ブリーフ・文体契約（既定=である調・常体）とともに、GlossaryBuilderOut スキーマ（resolved/brief/style）の JSON だけで返す。firstOccurrence は付与しない。",
  ].join("\n\n");
}

export async function buildGlossary(
  client: LlmClient,
  input: GlossaryBuilderIn,
): Promise<GlossaryBuilderOut> {
  const system = buildSystemPrompt("glossary-builder", { glossary: [] });
  return runAgent(client, { system, user: renderUser(input) }, GlossaryBuilderOut);
}
