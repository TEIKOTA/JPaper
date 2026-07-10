// 契約付録 §7.5・§8。core API（取り込み→用語バリア→並列翻訳→訳注→出力→RunSummary）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  JpaperInput,
  LlmClient,
  ResolvedTerm,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
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
import {
  renderGlossaryMd,
  parseGlossaryMd,
  renderBriefMd,
  renderStyleMd,
  type ResolvedRow,
} from "../terminology/glossary-io.js";
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

interface PaperContext {
  resolved: ResolvedRow[];
  brief: DocumentBrief;
  style: StyleContract;
  proposedAdded: number;
}

// glossary.md が有れば編集を正本として読み戻す（無ければ builder 実行＋md 描画）。既存 md は上書きしない。
async function loadOrBuildContext(
  runDir: string,
  outDir: string,
  client: LlmClient,
  db: GlossaryDb,
  paperId: string,
  cleanLatex: string,
): Promise<PaperContext> {
  const built = await checkpoint(runDir, "glossary", GlossaryCache, () =>
    buildPaperGlossary(client, db, paperId, cleanLatex),
  );
  mkdirSync(outDir, { recursive: true });
  const glossaryMd = path.join(outDir, "glossary.md");
  const briefMd = path.join(outDir, "brief.md");
  const styleMd = path.join(outDir, "style.md");

  let resolved: ResolvedRow[] = built.out.resolved;
  if (existsSync(glossaryMd)) {
    const edited = parseGlossaryMd(readFileSync(glossaryMd, "utf8"));
    if (edited.length > 0) resolved = edited;
  } else {
    writeFileSync(glossaryMd, renderGlossaryMd(built.out.resolved));
  }
  if (!existsSync(briefMd)) writeFileSync(briefMd, renderBriefMd(built.out.brief));
  if (!existsSync(styleMd)) writeFileSync(styleMd, renderStyleMd(built.out.style));

  return {
    resolved,
    brief: built.out.brief,
    style: built.out.style,
    proposedAdded: built.proposedAdded,
  };
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
  let db: GlossaryDb | undefined;

  try {
    if (deps.db) {
      db = deps.db;
    } else {
      const loc = deps.dbPath ?? dbPath();
      mkdirSync(path.dirname(loc), { recursive: true });
      db = new GlossaryDb(loc);
    }

    const ingested = await checkpoint(runDir, "ingest", IngestCache, () =>
      ingest(input, path.join(runDir, "source"), deps.ingest),
    );

    // 用語バリア: 並列翻訳の前に resolved/brief/style を確定する。
    const ctx = await loadOrBuildContext(
      runDir,
      outDir,
      client,
      db,
      ingested.paperId,
      ingested.cleanLatex,
    );
    const budget = segmentBudgetFor(contextWindowFor(opts.provider, opts.ollama));
    const segments = segment(ingested.cleanLatex, budget);
    const firstOcc = buildFirstOccurrenceIndex(
      segments,
      ctx.resolved.map((r) => r.src),
    );

    const results = await Promise.all(
      segments.map((seg) => {
        const slice = ctx.resolved
          .filter((t) => seg.latex.includes(t.src))
          .map((t) => ({ ...t, firstOccurrence: firstOcc.get(t.src) === seg.id })) as ResolvedTerm[];
        // 無効化は注入コンテキスト（当該セグメントの slice＋brief＋style）のハッシュ。
        const invalidation = hashContext(
          JSON.stringify(slice),
          JSON.stringify(ctx.brief),
          JSON.stringify(ctx.style),
        );
        return checkpoint(
          runDir,
          seg.id,
          SectionLoopCache,
          () => runSectionLoop(client, seg, slice, { brief: ctx.brief, style: ctx.style }),
          { invalidation },
        );
      }),
    );

    const notes = buildNotes({
      resolved: ctx.resolved.map((r) => ({ ...r, firstOccurrence: false })) as ResolvedTerm[],
      firstOccurrenceBySrc: firstOcc,
      hasConfirmed: (src) => db!.confirmedFor(src).length > 0,
      segmentWarns: results.map((r) => ({
        segmentId: r.segmentId,
        warnIssues: r.warnIssues,
      })),
    });

    const chaptersDir = path.join(outDir, "translation", "chapters");
    mkdirSync(chaptersDir, { recursive: true });
    for (const r of results) {
      writeFileSync(path.join(chaptersDir, `${r.segmentId}.tex`), r.ja);
    }
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
      glossary: { proposedAdded: ctx.proposedAdded },
      notes: { total: notes.length, byTrigger: countByTrigger(notes) },
      layout: null,
      buildOk: null,
      exitCode,
    });
    return { status: failed === 0 ? "ok" : "failed", exitCode, summary };
  } catch (e) {
    return failResult(paperId, outDir, e instanceof JpaperError ? e.code : 1);
  } finally {
    if (!deps.db) db?.close();
  }
}
