// 契約付録 §4（用語の検証）。issue #309。Web 検索を許した 1 回の呼び出しで、対象語の既存の日本語の用例を探す。
import type { LlmClient } from "../types/contract.js";
import { TermVerifyOut } from "../types/contract.js";
import { runAgent } from "../runtime/llm-client.js";
import { buildSystemPrompt } from "../runtime/system-prompt.js";
import { oneLine, MAX_TERM_CHARS } from "../runtime/untrusted.js";
import type { VerifyTarget } from "../terminology/verify.js";

export interface TermVerifierIn {
  paperId: string;
  // 論文の分野が分かる短い文脈（abstract の冒頭など）。
  context: string;
  targets: VerifyTarget[];
}

export const CONTEXT_CHARS = 600;

export function renderVerifierUser(input: TermVerifierIn): string {
  const terms = input.targets
    .map((t) => `- ${oneLine(t.src, MAX_TERM_CHARS)}（用語集の訳案: ${oneLine(t.form, MAX_TERM_CHARS)}）`)
    .join("\n");
  return [
    `# 論文 ${input.paperId} の用語の検証`,
    "## 論文の分野（abstract の冒頭）",
    `> ${oneLine(input.context, CONTEXT_CHARS)}`,
    "## 確かめる用語",
    terms,
    "## 探し方",
    [
      "- 日本語で検索する。訳案のカタカナ表記だけでなく、語の由来（人名・地名・作品名など）を漢字で書いた表記、原語のままの表記も候補にして検索する。",
      "- 日本語のページ（大学・研究所・企業の技術ブログ・学会の予稿・解説記事）を優先する。機械翻訳のまとめサイトは使わない。",
      "- 採るのは、検索で見つけたページに、この分野の意味でその表記がそのまま書かれているものだけ。検索結果に無い URL を作らない。",
      "- 見つけた日本語の表記は、割れていても全部を候補にし、表記ごとに出典を並べる（どれかを選ばない）。見つからなければ candidates を空にする。",
    ].join("\n"),
    "## 指示",
    "JSON だけを返す。形式:",
    '{"terms":[{"src":"原語（上の一覧のまま）","candidates":[{"form":"用例の日本語の表記","sources":[{"url":"https://...","quote":"その表記を含む本文の短い引用（そのまま）"}]}]}]}',
    "一覧の用語ごとに 1 件ずつ返す。form には原語の併記・括弧・句読点を付けない（40 字まで）。候補は 1 語 5 件、出典は 1 候補 5 件、引用は 400 字まで。",
  ].join("\n\n");
}

export async function verifyTerms(client: LlmClient, input: TermVerifierIn): Promise<TermVerifyOut> {
  return runAgent(
    client,
    {
      system: buildSystemPrompt("term-verifier"),
      user: renderVerifierUser(input),
      meta: { role: "term-verifier", phase: "verify" },
      webSearch: true,
    },
    TermVerifyOut,
    { retries: 1 },
  );
}
