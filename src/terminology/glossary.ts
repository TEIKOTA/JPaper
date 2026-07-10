// 契約付録 §1・§4。glossary-builder 配線（収集→DB retrieval→確定→proposed 書き戻し）。
import type { LlmClient, GlossaryBuilderOut } from "../types/contract.js";
import type { GlossaryDb } from "./db.js";
import { collectCandidates } from "./collect.js";
import { buildGlossary } from "../agents/glossary-builder.js";

export interface PaperGlossaryResult {
  out: GlossaryBuilderOut;
  proposedAdded: number;
}

export async function buildPaperGlossary(
  client: LlmClient,
  db: GlossaryDb,
  paperId: string,
  cleanLatex: string,
): Promise<PaperGlossaryResult> {
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

  const out = await buildGlossary(client, { paperId, candidates });

  const proposedAdded = db.writeBackProposed(
    out.resolved.map((r) => ({
      src: r.src,
      ja: r.form,
      class: r.class,
      rendering: r.rendering,
      source: paperId,
    })),
  );

  return { out, proposedAdded };
}
