// 契約付録 §7.5・§8。core API（取り込み→用語バリア→並列翻訳→訳注→出力→RunSummary）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { JpaperInput, LlmClient, ResolvedTerm } from "../types/contract.js";
import {
  GlossaryBuilderOut,
  EvalIssue,
  RunSummary,
  type Result,
  type Provider,
  type TranslatorNote,
} from "../types/contract.js";
import { JpaperError, resolveExitCode } from "../types/errors.js";
import { paperOutDir, dbPath, contextWindowFor, type OllamaConfig } from "../config.js";
import { makeLlmClient } from "../providers/index.js";
import { ingest, derivePaperId, type IngestDeps } from "../ingest/index.js";
import { GlossaryDb } from "../terminology/db.js";
import { buildPaperGlossary } from "../terminology/glossary.js";
import { buildFirstOccurrenceIndex } from "../terminology/first-occurrence.js";
import { segment, segmentBudgetFor } from "../segment/segmenter.js";
import { runSectionLoop } from "./section-loop.js";
import { buildNotes } from "./notes.js";
import { checkpoint, hashContext } from "../durable/checkpoint.js";

const IngestCache = z.object({
  cleanLatex: z.string(),
  figures: z.array(z.string()),
  paperId: z.string(),
  sourceDir: z.string(),
});
const GlossaryCache = z.object({
  out: GlossaryBuilderOut,
  proposedAdded: z.number().int(),
});
const SectionLoopCache = z.object({
  segmentId: z.string(),
  ja: z.string(),
  passed: z.boolean(),
  failCode: z.union([z.literal(3), z.literal(4)]).optional(),
  usedRevisions: z.number().int(),
  maxRevisions: z.number().int(),
  warnIssues: z.array(EvalIssue),
});

export interface TranslateOptions {
  provider: Provider;
  outDir?: string;
  ollama?: OllamaConfig;
}

export interface TranslateDeps {
  client?: LlmClient;
  db?: GlossaryDb;
  dbPath?: string;
  ingest?: IngestDeps;
}

function renderGlossaryMd(
  resolved: { src: string; form: string; class: string; rendering: string }[],
): string {
  const rows = resolved
    .map((r) => `| ${r.src} | ${r.form} | ${r.class} | ${r.rendering} |`)
    .join("\n");
  return `# 用語集\n\n| 原語 | 確定訳/表記 | 分類 | 表記方針 |\n|---|---|---|---|\n${rows}\n`;
}

function renderBriefMd(g: z.infer<typeof GlossaryBuilderOut>["brief"]): string {
  const roles = g.sectionRoles.map((r) => `- ${r.id}: ${r.role}`).join("\n");
  return `# 文書ブリーフ\n\n## 主張の核\n${g.thesis}\n\n## 節の役割\n${roles}\n\n## 記法規約\n${g.notationConventions.map((n) => `- ${n}`).join("\n")}\n\n## 主張強度の注意\n${g.claimStrengthNotes.map((n) => `- ${n}`).join("\n")}\n`;
}

function renderStyleMd(s: z.infer<typeof GlossaryBuilderOut>["style"]): string {
  return `# 文体契約\n\n- register: ${s.register}\n- 時制: ${s.tensePolicy}\n- 見出し: ${s.headingStyle}\n- 数字・単位: ${s.numberStyle}\n- 備考: ${s.notes.join(" / ")}\n`;
}

function countByTrigger(notes: TranslatorNote[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const n of notes) acc[n.trigger] = (acc[n.trigger] ?? 0) + 1;
  return acc;
}

function failResult(paperId: string, outDir: string, exitCode: number): Result {
  return {
    status: "failed",
    exitCode,
    summary: RunSummary.parse({
      paperId,
      outDir,
      segments: { total: 0, passed: 0, failed: 0 },
      revisions: { max: 0, used: 0 },
      glossary: { proposedAdded: 0 },
      notes: { total: 0, byTrigger: {} },
      layout: null,
      buildOk: null,
      exitCode,
    }),
  };
}

export async function translatePaper(
  input: JpaperInput,
  opts: TranslateOptions,
  deps: TranslateDeps = {},
): Promise<Result> {
  const paperId = derivePaperId(input);
  const outDir = paperOutDir(paperId, opts.outDir);
  const runDir = path.join(outDir, ".run");
  const client = deps.client ?? makeLlmClient(opts.provider, { ollama: opts.ollama });
  const db = deps.db ?? new GlossaryDb(deps.dbPath ?? dbPath());

  try {
    const ingested = await checkpoint(runDir, "ingest", IngestCache, () =>
      ingest(input, path.join(runDir, "source"), deps.ingest),
    );

    // 用語バリア: 並列翻訳の前に resolved/brief/style を確定する。
    const glossary = await checkpoint(runDir, "glossary", GlossaryCache, () =>
      buildPaperGlossary(client, db, ingested.paperId, ingested.cleanLatex),
    );
    const g = glossary.out;
    const invalidation = hashContext(
      JSON.stringify(g.resolved),
      JSON.stringify(g.brief),
      JSON.stringify(g.style),
    );

    const budget = segmentBudgetFor(contextWindowFor(opts.provider, opts.ollama));
    const segments = segment(ingested.cleanLatex, budget);
    const firstOcc = buildFirstOccurrenceIndex(
      segments,
      g.resolved.map((r) => r.src),
    );

    const results = await Promise.all(
      segments.map((seg) => {
        const slice: ResolvedTerm[] = g.resolved
          .filter((t) => seg.latex.includes(t.src))
          .map((t) => ({ ...t, firstOccurrence: firstOcc.get(t.src) === seg.id }));
        return checkpoint(
          runDir,
          seg.id,
          SectionLoopCache,
          () => runSectionLoop(client, seg, slice, { brief: g.brief, style: g.style }),
          { invalidation },
        );
      }),
    );

    const notes = buildNotes({
      resolved: g.resolved.map((r) => ({ ...r, firstOccurrence: false })),
      firstOccurrenceBySrc: firstOcc,
      hasConfirmed: (src) => db.confirmedFor(src).length > 0,
      segmentWarns: results.map((r) => ({
        segmentId: r.segmentId,
        warnIssues: r.warnIssues,
      })),
    });

    mkdirSync(path.join(outDir, "chapters"), { recursive: true });
    for (const r of results) {
      writeFileSync(path.join(outDir, "chapters", `${r.segmentId}.tex`), r.ja);
    }
    writeFileSync(path.join(outDir, "glossary.md"), renderGlossaryMd(g.resolved));
    writeFileSync(path.join(outDir, "brief.md"), renderBriefMd(g.brief));
    writeFileSync(path.join(outDir, "style.md"), renderStyleMd(g.style));
    writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const exitCode = resolveExitCode(
      results.filter((r) => !r.passed).map((r) => r.failCode ?? 4),
    );
    const summary = RunSummary.parse({
      paperId: ingested.paperId,
      outDir,
      segments: { total: results.length, passed, failed },
      revisions: {
        max: results.reduce((m, r) => Math.max(m, r.maxRevisions), 0),
        used: results.reduce((a, r) => a + r.usedRevisions, 0),
      },
      glossary: { proposedAdded: glossary.proposedAdded },
      notes: { total: notes.length, byTrigger: countByTrigger(notes) },
      layout: null,
      buildOk: null,
      exitCode,
    });
    return { status: failed === 0 ? "ok" : "failed", exitCode, summary };
  } catch (e) {
    const code = e instanceof JpaperError ? e.code : 1;
    return failResult(paperId, outDir, code);
  } finally {
    if (!deps.db) db.close();
  }
}
