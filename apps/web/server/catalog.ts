// 契約付録 §9（Web アプリ）。article/ の論文と用語集、全体の用語 DB を画面向けに読む（読み取りだけ）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readStep } from "../../../src/durable/checkpoint.js";
import { segment } from "../../../src/segment/segmenter.js";
import type { GlossaryDb, TermEntry } from "../../../src/terminology/db.js";
import { parseGlossaryMd, type ResolvedRow } from "../../../src/terminology/glossary-io.js";
import { findOccurrences, isEditable, shieldsFor, termJa } from "../../../src/terminology/replace.js";
import { expandMacros, plainText, simpleMacros } from "../../../src/terminology/replace-preview.js";
import { extractPreamble } from "../../../src/tools/assemble-latex.js";
import { extractTitle, findBodyTitle, translatedTitle, TITLE_SEGMENT_ID } from "../../../src/tools/paper-title.js";
import { listDeliverables } from "../../../src/tools/pdf-name.js";
import { IngestCache, SectionLoopCache } from "../../../src/workflows/step-keys.js";

const PAPER_DIR = /^([A-Za-z0-9._-]+)-ja$/;

export type PdfKind = "ja" | "bilingual";

export interface PaperSummary {
  id: string;
  titleJa?: string;
  titleEn?: string;
  termCount: number;
  pdf: Record<PdfKind, boolean>;
}

export type DbStatus = "confirmed" | "confirmed-other" | "none";

export interface TermRow {
  src: string;
  form: string;
  ja: string;
  class: string;
  rendering: string;
  note?: string;
  count: number;
  editable: boolean;
  db: DbStatus;
}

// article/ の中の論文フォルダ（<ID>-ja/ で glossary.md を持つもの）。id → 絶対パス。
export function paperDirs(articleDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(articleDir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const m = PAPER_DIR.exec(name);
    if (!m) continue;
    const dir = path.join(articleDir, name);
    try {
      if (statSync(dir).isDirectory() && existsSync(path.join(dir, "glossary.md"))) out.set(m[1]!, dir);
    } catch {
      // 読めないフォルダは並べない。
    }
  }
  return out;
}

function readRows(outDir: string): ResolvedRow[] {
  try {
    return parseGlossaryMd(readFileSync(path.join(outDir, "glossary.md"), "utf8"));
  } catch {
    return [];
  }
}

export function paperTitles(outDir: string, key?: Buffer): { titleJa?: string; titleEn?: string } {
  const runDir = path.join(outDir, ".run");
  const out: { titleJa?: string; titleEn?: string } = {};
  try {
    const t = readStep(runDir, TITLE_SEGMENT_ID, key);
    const parsed = t === undefined ? undefined : SectionLoopCache.safeParse(t.value);
    const ja = parsed?.success ? translatedTitle(parsed.data.ja) : undefined;
    const i = readStep(runDir, "ingest", key);
    const ing = i === undefined ? undefined : IngestCache.safeParse(i.value);
    const latex = ing?.success ? ing.data.cleanLatex : "";
    const macros = simpleMacros(latex);
    if (ja !== undefined) out.titleJa = plainText(expandMacros(ja, macros));
    if (latex !== "") {
      const en = findBodyTitle(segment(latex, Number.MAX_SAFE_INTEGER))?.title ?? extractTitle(extractPreamble(latex));
      if (en !== undefined) out.titleEn = plainText(expandMacros(en.text, macros));
    }
  } catch {
    // タイトルは表示の補助。読めなければ ID だけで出す。
  }
  return out;
}

export function pdfPath(outDir: string, kind: PdfKind): string | undefined {
  const named = listDeliverables(outDir, kind)[0];
  if (named !== undefined) return path.join(outDir, named);
  const legacy = path.join(outDir, "translation", kind === "ja" ? "build" : "bilingual", "main.pdf");
  return existsSync(legacy) ? legacy : undefined;
}

export function listPapers(articleDir: string, key?: Buffer): PaperSummary[] {
  return [...paperDirs(articleDir)].map(([id, dir]) => ({
    id,
    ...paperTitles(dir, key),
    termCount: readRows(dir).length,
    pdf: { ja: pdfPath(dir, "ja") !== undefined, bilingual: pdfPath(dir, "bilingual") !== undefined },
  }));
}

function chaptersText(outDir: string): string {
  const dir = path.join(outDir, "translation", "chapters");
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".tex"))
      .sort()
      .map((n) => readFileSync(path.join(dir, n), "utf8"))
      .join("\n\n");
  } catch {
    return "";
  }
}

function dbStatus(entries: readonly TermEntry[], form: string): DbStatus {
  const confirmed = entries.filter((e) => e.status === "confirmed");
  if (confirmed.some((e) => e.ja === form)) return "confirmed";
  return confirmed.length > 0 ? "confirmed-other" : "none";
}

export function glossaryRows(outDir: string, db: GlossaryDb): TermRow[] {
  const rows = readRows(outDir);
  const text = chaptersText(outDir);
  return rows.map((r) => {
    const ja = termJa(r);
    const count =
      ja === undefined || ja === ""
        ? findOccurrences(text, r.src, []).length
        : findOccurrences(text, ja, shieldsFor(rows, r.src, ja)).filter((o) => o.shieldedBy === undefined).length;
    return {
      src: r.src,
      form: r.form,
      ja: ja ?? r.form,
      class: r.class,
      rendering: r.rendering,
      ...(r.note === undefined ? {} : { note: r.note }),
      count,
      editable: isEditable(r),
      db: dbStatus(db.confirmedFor(r.src), r.form),
    };
  });
}

export interface AffectedPaper {
  id: string;
  titleJa?: string;
  currentJa: string;
}

interface PaperTerm {
  id: string;
  dir: string;
  row: ResolvedRow;
}

function termsBySrc(articleDir: string): Map<string, PaperTerm[]> {
  const out = new Map<string, PaperTerm[]>();
  for (const [id, dir] of paperDirs(articleDir)) {
    for (const row of readRows(dir)) {
      const k = row.src.toLowerCase();
      out.set(k, [...(out.get(k) ?? []), { id, dir, row }]);
    }
  }
  return out;
}

function affectedIn(
  index: Map<string, PaperTerm[]>,
  src: string,
  form: string,
  exclude: string | undefined,
  key?: Buffer,
): AffectedPaper[] {
  return (index.get(src.toLowerCase()) ?? [])
    .filter((p) => p.id !== exclude && isEditable(p.row) && p.row.form !== form)
    .map((p) => ({ id: p.id, ...pick(paperTitles(p.dir, key)), currentJa: termJa(p.row) ?? p.row.form }));
}

function pick(t: { titleJa?: string }): { titleJa?: string } {
  return t.titleJa === undefined ? {} : { titleJa: t.titleJa };
}

// 全体の用語 DB の承認済みの訳と違う訳語で、既に訳した論文。
export function affectedPapers(
  articleDir: string,
  src: string,
  form: string,
  exclude?: string,
  key?: Buffer,
): AffectedPaper[] {
  return affectedIn(termsBySrc(articleDir), src, form, exclude, key);
}

export interface GlobalTerm {
  src: string;
  ja: string | null;
  class: string;
  rendering: string;
  status: "confirmed" | "proposed";
  source: string | null;
  affected: AffectedPaper[];
}

export function globalTerms(db: GlossaryDb, articleDir: string, key?: Buffer): GlobalTerm[] {
  const index = termsBySrc(articleDir);
  const out: GlobalTerm[] = [];
  for (const src of db.allSrcTerms().sort((a, b) => a.localeCompare(b))) {
    for (const e of db.allFor(src)) {
      out.push({
        src: e.src,
        ja: e.ja,
        class: e.class,
        rendering: e.rendering,
        status: e.status,
        source: e.source,
        affected: e.status === "confirmed" && e.ja !== null ? affectedIn(index, e.src, e.ja, undefined, key) : [],
      });
    }
  }
  return out;
}
