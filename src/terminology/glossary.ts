// 契約付録 §1・§4。glossary-builder 配線（収集→DB retrieval→確定）と proposed 書き戻し。
import type { LlmClient, GlossaryBuilderOut } from "../types/contract.js";
import type { GlossaryDb } from "./db.js";
import { collectCandidates } from "./collect.js";
import { buildGlossary } from "../agents/glossary-builder.js";

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
    globalCandidates: db
      .allFor(c.src)
      .filter((e) => e.ja !== null)
      .map((e) => ({
        ja: e.ja as string,
        domain: e.domain ?? undefined,
        description: e.description ?? undefined,
      })),
  }));
  return buildGlossary(client, { paperId, candidates });
}

// proposed 書き戻しは毎回実行（dedup で再実行は 0 件）＝実行ごとの追加件数を正しく返す。
export function writeBackResolved(
  db: GlossaryDb,
  out: GlossaryBuilderOut,
  paperId: string,
): number {
  return db.writeBackProposed(
    out.resolved.map((r) => ({
      src: r.src,
      ja: r.form,
      class: r.class,
      rendering: r.rendering,
      source: paperId,
    })),
  );
}
