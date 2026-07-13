// 契約付録 §7.5・§8。core API（取り込み→用語バリア→並列翻訳→訳注→出力→RunSummary）。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { buildPaperGlossary, writeBackResolved } from "../terminology/glossary.js";
import {
  renderGlossaryMd,
  parseGlossaryMd,
  renderBriefMd,
  parseBriefMd,
  renderStyleMd,
  parseStyleMd,
  type ResolvedRow,
} from "../terminology/glossary-io.js";
import { buildFirstOccurrenceIndex } from "../terminology/first-occurrence.js";
import { segment, segmentBudgetFor } from "../segment/segmenter.js";
import { runSectionLoop } from "./section-loop.js";
import { buildNotes } from "./notes.js";
import { checkpoint, hashContext } from "../durable/checkpoint.js";
import { assembleWithMap, type Layout } from "../tools/assemble-latex.js";
import { runBuildGate, type LatexRunner, type BuildGateResult } from "../tools/build-gate.js";

const IngestCache = z.object({
  cleanLatex: z.string(),
  figures: z.array(z.string()),
  paperId: z.string(),
  sourceDir: z.string(),
  mainDir: z.string(), // 旧キャッシュは mainDir 欠落で無効化され再取り込みされる（入れ子 main の図配置に必須）
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
  concurrency?: number;
}

// subprocess プロバイダは無制限並列に耐えないため翻訳の同時実行数を制限する。
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

export interface TranslateDeps {
  client?: LlmClient;
  db?: GlossaryDb;
  dbPath?: string;
  ingest?: IngestDeps;
  onError?: (message: string) => void;
  latexRunner?: LatexRunner;
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
  const built = await checkpoint(
    runDir,
    "glossary",
    GlossaryBuilderOut,
    () => buildPaperGlossary(client, db, paperId, cleanLatex),
    { invalidation: hashContext(cleanLatex) },
  );
  const proposedAdded = writeBackResolved(db, built, paperId);
  mkdirSync(outDir, { recursive: true });
  const glossaryMd = path.join(outDir, "glossary.md");
  const briefMd = path.join(outDir, "brief.md");
  const styleMd = path.join(outDir, "style.md");

  let resolved: ResolvedRow[] = built.resolved;
  if (existsSync(glossaryMd)) {
    // 既存 md が正本（空にする編集も尊重する）。
    resolved = parseGlossaryMd(readFileSync(glossaryMd, "utf8"));
  } else {
    writeFileSync(glossaryMd, renderGlossaryMd(built.resolved));
  }

  let brief = built.brief;
  if (existsSync(briefMd)) brief = parseBriefMd(readFileSync(briefMd, "utf8"));
  else writeFileSync(briefMd, renderBriefMd(built.brief));

  let style = built.style;
  if (existsSync(styleMd)) style = parseStyleMd(readFileSync(styleMd, "utf8"));
  else writeFileSync(styleMd, renderStyleMd(built.style));

  return { resolved, brief, style, proposedAdded };
}

// ingest キャッシュの無効化キー: 入力が変わったら再取り込み（path 上書き・arXiv v1/v2 は paperId 共有）。
function inputSignature(input: JpaperInput): string {
  if (input.kind === "arxiv") return hashContext("arxiv", input.id);
  try {
    const st = statSync(input.path);
    return hashContext("path", path.resolve(input.path), String(st.mtimeMs), String(st.size));
  } catch {
    return hashContext("path", path.resolve(input.path));
  }
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

interface TypesetOutcome {
  layout: Layout | null;
  buildOk: boolean | null;
  pdfPath?: string;
  exitCode: number;
}

function summarizeGateFailure(g: BuildGateResult): string {
  const parts: string[] = [];
  if (g.failedSegments.length)
    parts.push(`翻訳起因: ${g.failedSegments.map((f) => `${f.id}(${f.line})`).join(", ")}`);
  if (g.structuralErrors.length) parts.push(`構造: ${g.structuralErrors.slice(0, 3).join(" / ")}`);
  if (g.missingFigures.length) parts.push(`欠図: ${g.missingFigures.join(", ")}`);
  if (g.droppedFigures.length) parts.push(`図欠落: ${g.droppedFigures.join(", ")}`);
  if (g.unresolvedRefs.length) parts.push(`未解決参照: ${g.unresolvedRefs.slice(0, 5).join(", ")}`);
  return parts.join(" | ") || "不明なビルド失敗";
}

// 全文組版ゲート: 原プリアンブル温存を試し、構造起因失敗のみ共通テンプレへ明示的にフォールバック（surface）。
function typeset(
  cleanLatex: string,
  segments: { id: string; tex: string }[],
  opts: { outDir: string; sourceDir: string; mainDir: string; figures: string[] },
  runner: LatexRunner | undefined,
  surface: (m: string) => void,
): TypesetOutcome {
  const buildDir = path.join(opts.outDir, "translation", "build");
  const run = (mode: Layout): BuildGateResult => {
    const { mainTex, sourceMap } = assembleWithMap({ cleanLatex, segments, mode });
    return runBuildGate(
      { buildDir, mainTex, sourceDir: opts.sourceDir, mainDir: opts.mainDir, figures: opts.figures, sourceMap },
      runner,
    );
  };
  // pdfPath は buildOk のときだけ返す（ゲート棄却済みの成果物を成功として渡さない）。
  const orig = run("original");
  if (orig.buildOk) return { layout: "original", buildOk: true, pdfPath: orig.pdfPath, exitCode: 0 };
  if (orig.failedSegments.length > 0) {
    // 翻訳起因のビルド失敗。再訳ループ(WP10)未実装のため明示的失敗として surface する。
    surface(`組版失敗(翻訳起因・要再訳): ${summarizeGateFailure(orig)}`);
    return { layout: "original", buildOk: false, exitCode: 5 };
  }
  surface(`原プリアンブルで組めず共通テンプレへフォールバック: ${summarizeGateFailure(orig)}`);
  const tmpl = run("template");
  if (tmpl.buildOk) return { layout: "template", buildOk: true, pdfPath: tmpl.pdfPath, exitCode: 0 };
  surface(`組版失敗(テンプレでも不可): ${summarizeGateFailure(tmpl)}`);
  return { layout: "template", buildOk: false, exitCode: 5 };
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

    const ingested = await checkpoint(
      runDir,
      "ingest",
      IngestCache,
      () => ingest(input, path.join(runDir, "source"), deps.ingest),
      { invalidation: inputSignature(input) },
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

    const results = await mapLimit(segments, opts.concurrency ?? 4, (seg) => {
      const slice = ctx.resolved
        .filter((t) => seg.latex.includes(t.src))
        .map((t) => ({ ...t, firstOccurrence: firstOcc.get(t.src) === seg.id })) as ResolvedTerm[];
      // 無効化は原文＋注入コンテキスト（slice＋brief＋style）のハッシュ。失敗結果は永続しない。
      const invalidation = hashContext(
        seg.latex,
        JSON.stringify(slice),
        JSON.stringify(ctx.brief),
        JSON.stringify(ctx.style),
      );
      return checkpoint(
        runDir,
        seg.id,
        SectionLoopCache,
        () => runSectionLoop(client, seg, slice, { brief: ctx.brief, style: ctx.style }),
        { invalidation, cacheable: (r) => r.passed },
      );
    });

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
    rmSync(chaptersDir, { recursive: true, force: true }); // 縮小時の古い chapter を残さない
    mkdirSync(chaptersDir, { recursive: true });
    for (const r of results) {
      writeFileSync(path.join(chaptersDir, `${r.segmentId}.tex`), r.ja);
    }
    writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    // 全節通過時のみ組版する（翻訳失敗の 3/4 は組版前に確定）。
    let layout: Layout | null = null;
    let buildOk: boolean | null = null;
    let pdfPath: string | undefined;
    let exitCode = resolveExitCode(results.filter((r) => !r.passed).map((r) => r.failCode ?? 4));
    if (failed === 0) {
      const outcome = typeset(
        ingested.cleanLatex,
        results.map((r) => ({ id: r.segmentId, tex: r.ja })),
        {
          outDir,
          sourceDir: ingested.sourceDir,
          mainDir: ingested.mainDir ?? ingested.sourceDir,
          figures: ingested.figures,
        },
        deps.latexRunner,
        (m) => deps.onError?.(m),
      );
      ({ layout, buildOk, pdfPath, exitCode } = outcome);
    }

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
      layout,
      buildOk,
      exitCode,
    });
    return { status: exitCode === 0 ? "ok" : "failed", exitCode, pdfPath, summary };
  } catch (e) {
    deps.onError?.(String((e as Error)?.message ?? e));
    return failResult(paperId, outDir, e instanceof JpaperError ? e.code : 1);
  } finally {
    if (!deps.db) db?.close();
  }
}
