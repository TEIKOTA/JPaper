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
    "JSON だけを返す。形式:",
    '{"resolved":[{"src":"原語","form":"確定訳/表記","class":"established"|"paper-defined"|"proper-noun"|"do-not-translate","rendering":"translate"|"bilingual"|"keep-original","note":"訳注(任意)"}],' +
      '"brief":{"thesis":"主張の核","sectionRoles":[{"id":"節id","role":"役割"}],"notationConventions":["記法規約"],"claimStrengthNotes":["主張強度の注意(任意)"]},' +
      '"style":{"register":"plain"|"polite","tensePolicy":"時制方針","headingStyle":"見出し方針","numberStyle":"数字/単位方針","notes":["備考(任意)"]}}',
    "rendering=bilingual の form は必ず『日本語(原語)』の併記形にする（例: 値(Value) / スケール化ドット積注意(Scaled Dot-Product Attention)）。日本語のみにしない。",
    "note は読者向けの訳注（語の定義・由来・訳語を選んだ理由）に限る。note に訳し方の指示を書かない: form と違う訳語・言い回しを示さない（「〜と訳す」と書かない）、別の語の訳を指定しない。",
    "既定文体は register=plain（である調・常体）。firstOccurrence は付与しない（配線側が決定的に付ける）。",
  ].join("\n\n");
}

export async function buildGlossary(
  client: LlmClient,
  input: GlossaryBuilderIn,
): Promise<GlossaryBuilderOut> {
  const system = buildSystemPrompt("glossary-builder");
  return runAgent(
    client,
    { system, user: renderUser(input), meta: { role: "glossary-builder", phase: "glossary" } },
    GlossaryBuilderOut,
  );
}
