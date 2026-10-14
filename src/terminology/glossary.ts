// 契約付録 §1・§4。glossary-builder 配線（収集→DB retrieval→確定）と proposed 書き戻し。
import type { LlmClient, GlossaryBuilderOut } from "../types/contract.js";
import type { GlossaryDb } from "./db.js";
import { collectCandidates } from "./collect.js";
import { buildGlossary } from "../agents/glossary-builder.js";
import { paperExcerpt } from "./paper-excerpt.js";
import { oneLine, MAX_TERM_CHARS } from "../runtime/untrusted.js";
import { normalizeBilingualForms } from "./bilingual-form.js";
import { normalizeTermSrcs } from "./term-src.js";

// 一般語は「ほぼ全ての論文にヒットする」ため、汚染の運び屋になる。用語として受け付けない。
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "not",
  "但し",
  "および",
  "また",
  "する",
  "した",
  "その",
]);

// 書き戻す語として妥当か。長さ・文字種・一般語で機械的に判定する。
export function isAcceptableTerm(src: string): boolean {
  const s = src.trim();
  if (s.length < 3 || s.length > MAX_TERM_CHARS) return false;
  if (s !== oneLine(s, MAX_TERM_CHARS)) return false; // 改行・制御文字を含む
  if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(s)) return false; // 文字を含まない
  if (s.startsWith("\\")) return false; // 論文のマクロ（契約付録 §2）
  return !STOPWORDS.has(s.toLowerCase());
}

export async function buildPaperGlossary(
  client: LlmClient,
  db: GlossaryDb,
  paperId: string,
  cleanLatex: string,
): Promise<GlossaryBuilderOut> {
  const known = db.matchKnownTerms(cleanLatex);
  const candidates = collectCandidates(cleanLatex, known).map((c) => ({
    src: c.src,
    definedInPaper: c.definedInPaper,
    // 承認済みの語だけを他論文へ渡す。proposed は人手承認前の提案で、参照される資格がない。
    globalCandidates: db
      .confirmedFor(c.src)
      .filter((e) => e.ja !== null)
      .map((e) => ({
        ja: e.ja as string,
        domain: e.domain ?? undefined,
        description: e.description ?? undefined,
      })),
  }));
  const out = await buildGlossary(client, { paperId, candidates, excerpt: paperExcerpt(cleanLatex) });
  // 併記の原語は src そのものと契約で決まっている。モデルの綴り（大文字化など）を
  // 採ると、検査の完全一致が原文と噛み合わずその節が永久に通らない。契約付録 §1
  return { ...out, resolved: normalizeBilingualForms(normalizeTermSrcs(out.resolved)) };
}

// proposed 書き戻しは毎回実行（dedup で再実行は 0 件）＝実行ごとの追加件数を正しく返す。
export function writeBackResolved(
  db: GlossaryDb,
  out: GlossaryBuilderOut,
  paperId: string,
): number {
  return db.writeBackProposed(
    normalizeBilingualForms(normalizeTermSrcs(out.resolved))
      .filter((r) => isAcceptableTerm(r.src))
      .map((r) => ({
        src: oneLine(r.src, MAX_TERM_CHARS),
        ja: oneLine(r.form, MAX_TERM_CHARS),
        class: r.class,
        rendering: r.rendering,
        source: paperId,
      })),
  );
}
