// 契約付録 §1。translator（純変換器）。
import type {
  LlmClient,
  TranslatorIn,
  TranslatorOut,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
import { runText, extractFenced, extractJson } from "../runtime/llm-client.js";
import { oneLine, MAX_ISSUE_CHARS } from "../runtime/untrusted.js";
import {
  buildSystemPrompt,
  renderGlossaryBlock,
  renderDocContextBlock,
} from "../runtime/system-prompt.js";

export interface DocContext {
  brief?: DocumentBrief;
  style?: StyleContract;
}

function renderUser(input: TranslatorIn, doc: DocContext): string {
  const lines = [`# セグメント ${input.segmentId}`, "## 原文 LaTeX", input.latex];
  const ctx = renderDocContextBlock(doc); // LLM 生成物は user 側（system は固定文のみ）
  if (ctx !== "") lines.push(ctx);
  lines.push(renderGlossaryBlock(input.glossarySlice)); // per-segment 用語は user 側（system の cache prefix を保つ）
  if (input.priorJa) lines.push("## 前回の訳（改稿対象）", input.priorJa);
  if (input.issues && input.issues.length > 0) {
    lines.push(
      "## 指摘（これらを直す）",
      input.issues.map((i) => `- ${oneLine(i, MAX_ISSUE_CHARS)}`).join("\n"),
    );
  }
  // 改稿でも「訳し直せ」と指示すると、モデルは同じ原文から同じ構造判断を再現する。
  // 実測（seg-0023）: 1 稿目と 2 稿目の差が句読点 2 文字だけで、指摘した数式は
  // 1 文字も変わらなかった。前稿を土台にした最小差分の修正として指示する。
  // 語順は逆にできない——「1 文字も変えない」を先に置くと、モデルは指摘箇所ごと
  // 前稿をそのまま返す（実測: 2 稿目が 1 稿目とバイト単位で一致）。契約付録 §1
  const FORMAT = "訳文だけを ```tex と ``` で囲んで返す。JSON にしない。囲みの外に説明を書かない。";
  lines.push(
    "## 指示",
    input.priorJa === undefined
      ? `本文と図表のキャプション（\\caption の中身）を日本語に訳し、LaTeX の構造・制御綴り・参照・数式・図のパスは原文どおり残す。${FORMAT}`
      : `指摘された箇所を必ず直す。直っていない訳をそのまま返さない。それ以外は前回の訳を土台にして残し、指摘と関係のない文を訳し直さない。直した全文を返し、${FORMAT}`,
  );
  return lines.join("\n\n");
}

export async function translate(
  client: LlmClient,
  input: TranslatorIn,
  doc: DocContext = {},
  pass?: number,
): Promise<TranslatorOut> {
  const system = buildSystemPrompt("translator");
  // 訳文は JSON 文字列で運ばない。頭文字が妥当なエスケープ（\t \n \b \f \r \u）の綴りが
  // 黙って壊れるため（実測: `\times` → TAB+`imes`）。ADR 20260815-translator-returns-plain-text。
  // 平文が既定。JSON で返ってきた場合も受けるが、その経路は \t 系の綴りが壊れる危険を
  // 残したままなので、あくまで後方互換の受け皿にとどめる。
  const takeJa = (raw: string): string | undefined => {
    const fenced = extractFenced(raw);
    if (fenced !== undefined) return fenced;
    try {
      const v = extractJson(raw) as { ja?: unknown };
      return typeof v.ja === "string" ? v.ja : undefined;
    } catch {
      return undefined;
    }
  };

  const ja = await runText(
    client,
    {
      system,
      user: renderUser(input, doc),
      meta: { role: "translator", phase: "translate", segmentId: input.segmentId, pass },
    },
    takeJa,
  );
  // segmentId は呼び出し側が既に知っているので、モデルに書かせない。
  return { segmentId: input.segmentId, ja };
}
