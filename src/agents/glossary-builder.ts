// 契約付録 §1・§4。glossary-builder（純変換器・本文の抜粋と用語候補から 1 回）。
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
  // 契約付録 §4
  const excerpt =
    input.excerpt === undefined || input.excerpt.trim() === ""
      ? "（抜粋なし）"
      : input.excerpt
          .split(/\r\n?|[\n\u0085\u2028\u2029]/)
          .map((l) => `> ${l.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`)
          .join("\n");
  return [
    `# 論文 ${input.paperId} の用語確定`,
    "## 本文の抜粋（abstract・見出し・各節の冒頭。§ の数が見出しの深さ）",
    excerpt,
    "## 収集候補（src [論文内定義]: グローバル候補）",
    cands || "（候補なし）",
    "## 指示",
    "JSON だけを返す。形式:",
    '{"resolved":[{"src":"原語","form":"確定訳/表記","class":"established"|"paper-defined"|"proper-noun"|"do-not-translate","rendering":"translate"|"bilingual"|"keep-original","note":"訳注(任意)"}],' +
      '"brief":{"thesis":"主張の核","sectionRoles":[{"id":"節id","role":"役割"}],"notationConventions":["記法規約"],"claimStrengthNotes":["主張強度の注意(任意)"]},' +
      '"style":{"register":"plain"|"polite","tensePolicy":"時制方針","headingStyle":"見出し方針","numberStyle":"数字/単位方針","notes":["備考(任意)"]}}',
    "brief（主張の核・節の役割・記法規約）は本文の抜粋に書かれていることから書く。抜粋に無い内容を推測で足さない。sectionRoles の id は抜粋の見出しをそのまま使う。",
    "rendering=bilingual の form は必ず『日本語(原語)』の併記形にする（例: 値(Value) / スケール化ドット積注意(Scaled Dot-Product Attention)）。日本語のみにしない。",
    "原語に数式の外のエスケープした特殊文字（\\& \\% \\_ など）を含む語は、form でもそのまま残す（例: Math \\& reasoning の form は「数学\\&推論」。「数学・推論」と書かない）。残せない語は rendering=keep-original にして form を原語にする。",
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
