// 契約付録 §9。用語集の訳語の編集: 置換の計画・適用（checkpoint の署名し直し＋LLM なしの再組版）・元に戻す。
import { isMacroDefinitionsOnly } from "../segment/macro-only.js";
import { recheckFormal } from "./section-loop.js";
import { FORMAL_GATE } from "./quality-gate.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  GlossaryBuilderOut,
  VerifiedGlossary,
  type JpaperInput,
  type LlmClient,
  type Result,
} from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import {
  DEFAULT_CLAUDE_CW,
  DEFAULT_OLLAMA,
  DEFAULT_OPENROUTER,
  dbPath as defaultDbPath,
} from "../config.js";
import { loadCacheKey } from "../durable/cache-key.js";
import { readStep, writeStep, type StoredStep } from "../durable/checkpoint.js";
import { acquireRunLock } from "../durable/run-lock.js";
import { isArxivId } from "../ingest/detect-input.js";
import { segmentBudgetFor, type Segment } from "../segment/segmenter.js";
import { GlossaryDb } from "../terminology/db.js";
import { isAcceptableTerm } from "../terminology/glossary.js";
import {
  parseBriefMd,
  parseGlossaryMd,
  parseStyleMd,
  renderBriefMd,
  renderGlossaryMd,
  renderStyleMd,
  type ResolvedRow,
} from "../terminology/glossary-io.js";
import {
  editedForm,
  findOccurrences,
  isEditable,
  rewriteGlossaryMd,
  rewriteStrings,
  rewriteText,
  sameJaTerms,
  shieldsFor,
  termJa,
  validateTermJa,
  rewriteMdBody,
  type Shield,
  type TermRewrite,
} from "../terminology/replace.js";
import {
  sentencePreviews,
  simpleMacros,
  sourceSentences,
  type Macros,
  type Piece,
  type SentencePreview,
} from "../terminology/replace-preview.js";
import type { LatexRunner } from "../tools/build-gate.js";
import { hasProse, titleSegment, translatedTitle, TITLE_SEGMENT_ID } from "../tools/paper-title.js";
import { listDeliverables } from "../tools/pdf-name.js";
import { formalCheck } from "./quality-gate.js";
import {
  IngestCache,
  SectionLoopCache,
  foundTitle,
  planSegments,
  segmentInvalidation,
  segmentSlice,
  segmentFirstOccurrence,
  titleInvalidation,
  titleSlice,
  type StepContext,
} from "./step-keys.js";
import { inputSignature, SHARED_DEFAULT_NOTICE, translatePaper, VERIFY_STEP } from "./translate-paper.js";

// 節の checkpoint と分割が一致する文脈長を探す候補。契約付録 §9
export const CONTEXT_WINDOW_CANDIDATES: readonly number[] = [
  DEFAULT_CLAUDE_CW,
  DEFAULT_OPENROUTER.contextWindow,
  DEFAULT_OLLAMA.contextWindow,
  4096,
  16_384,
  32_768,
  65_536,
  131_072,
  1_000_000,
];

// 引き継ぎ（migrated）のとき、原文と訳文の対応を確かめる形式検査の種別。契約付録 §9
const ALIGNMENT_KINDS = new Set(["math", "graphics", "label", "reference", "structure", "unsafe-command"]);

const SEG_STEP = /^(seg-\d+)\.[0-9a-f]+\.json$/;

export interface EditDeps {
  cacheKey?: Buffer;
  db?: GlossaryDb;
  dbPath?: string;
  latexRunner?: LatexRunner;
  signal?: AbortSignal;
  now?: () => Date;
}

// マクロ定義だけの節の、原文のまま通過した checkpoint 相当。
function passThroughStep(seg: Segment, invalidation: string): StoredStep {
  const value: SectionLoopCache = {
    segmentId: seg.id,
    ja: seg.latex,
    passed: true,
    failedKinds: [],
    usedRevisions: 0,
    maxRevisions: 0,
    warnIssues: [],
  };
  return { file: "", invalidation, value };
}

interface StepEntry {
  id: string;
  source: Segment;
  stored: StoredStep;
  value: SectionLoopCache;
  // 今の版の無効化キーで署名されているか。
  current: boolean;
}

export interface PaperState {
  outDir: string;
  runDir: string;
  paperId: string;
  key: Buffer;
  input: JpaperInput;
  contextWindow: number;
  ingest: IngestCache;
  md: { glossary: string; brief: string; style: string };
  ctx: StepContext;
  glossaryStep: { stored: StoredStep; value: GlossaryBuilderOut };
  segments: StepEntry[];
  title: StepEntry | undefined;
  // 今の版の無効化キーと違う checkpoint を引き継ぐか。
  migrated: boolean;
}

function inputError(message: string): JpaperError {
  return new JpaperError(2, "input", message);
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw inputError(`${path.basename(file)} がありません。CLI で一度翻訳を完了させてください`);
  }
}

// 取り込みの checkpoint の鍵から、元の入力（arXiv ID）を復元する。
function arxivInputFor(paperId: string, invalidation: string): JpaperInput | undefined {
  for (const id of [paperId, ...Array.from({ length: 20 }, (_, i) => `${paperId}v${String(i + 1)}`)]) {
    if (!isArxivId(id)) continue;
    const input: JpaperInput = { kind: "arxiv", id };
    if (inputSignature(input) === invalidation) return input;
  }
  return undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function segmentIdsInSteps(runDir: string): Set<string> {
  try {
    return new Set(
      readdirSync(path.join(runDir, "steps")).flatMap((n) => {
        const m = SEG_STEP.exec(n);
        return m ? [m[1]!] : [];
      }),
    );
  } catch {
    return new Set();
  }
}

function alignmentIssues(source: Segment, ja: string): string[] {
  return formalCheck(source.latex, ja, [])
    .filter((i) => ALIGNMENT_KINDS.has(i.kind))
    .map((i) => i.kind);
}

// 契約付録 §9。出力先の checkpoint と md から、置換と再組版に要る状態を読む。LLM 無しで組めない状態なら投げる。
export function loadPaperState(outDir: string, key: Buffer = loadCacheKey()): PaperState {
  const runDir = path.join(outDir, ".run");
  const ingestStored = readStep(runDir, "ingest", key);
  if (ingestStored === undefined) {
    throw inputError("取り込みの checkpoint がありません。CLI で一度翻訳を完了させてください");
  }
  const ingest = IngestCache.parse(ingestStored.value);
  const input = arxivInputFor(ingest.paperId, ingestStored.invalidation);
  if (input === undefined) {
    throw inputError("arXiv ID 以外の入力から訳した論文は、元の入力が分からないため組み直せません");
  }
  const glossaryStored = readStep(runDir, "glossary", key);
  if (glossaryStored === undefined) {
    throw inputError("用語集の checkpoint がありません。CLI で一度翻訳を完了させてください");
  }
  const glossaryValue = GlossaryBuilderOut.parse(glossaryStored.value);
  const md = {
    glossary: readText(path.join(outDir, "glossary.md")),
    brief: readText(path.join(outDir, "brief.md")),
    style: readText(path.join(outDir, "style.md")),
  };
  const ctx: StepContext = {
    resolved: parseGlossaryMd(md.glossary),
    brief: parseBriefMd(md.brief),
    style: parseStyleMd(md.style),
  };

  const stepIds = segmentIdsInSteps(runDir);
  const stored = new Map<string, StoredStep>();
  for (const id of stepIds) {
    const s = readStep(runDir, id, key);
    if (s !== undefined) stored.set(id, s);
  }

  let chosen: { cw: number; entries: StepEntry[]; segments: Segment[]; bodyPlan: ReturnType<typeof planSegments> } | undefined;
  const tried = new Set<number>();
  for (const cw of CONTEXT_WINDOW_CANDIDATES) {
    const budget = segmentBudgetFor(cw);
    if (tried.has(budget)) continue;
    tried.add(budget);
    const plan = planSegments(ingest.cleanLatex, budget);
    // マクロ定義だけの節は LLM へ送らず checkpoint も残さない（契約付録 §1）。原文のまま通過した節として扱う。
    const needed = plan.segments.filter((s) => stored.has(s.id) || !isMacroDefinitionsOnly(s.latex));
    if (needed.length !== stored.size || needed.some((s) => !stored.has(s.id))) continue;
    const firstOcc = segmentFirstOccurrence(plan.segments, ctx.resolved);
    const entries = plan.segments.map((seg) => {
      const st = stored.get(seg.id) ?? passThroughStep(seg, segmentInvalidation(seg, segmentSlice(seg, ctx.resolved, firstOcc), ctx));
      const value = SectionLoopCache.parse(st.value);
      const key0 = segmentInvalidation(seg, segmentSlice(seg, ctx.resolved, firstOcc), ctx);
      return { id: seg.id, source: seg, stored: st, value, current: st.invalidation === key0 };
    });
    if (entries.every((e) => e.current)) {
      chosen = { cw, entries, segments: plan.segments, bodyPlan: plan };
      break;
    }
    chosen ??= { cw, entries, segments: plan.segments, bodyPlan: plan };
  }
  if (chosen === undefined) {
    throw inputError("節の checkpoint が原文の分割と合いません。CLI で再実行して翻訳を完了させてから編集してください");
  }
  for (const e of chosen.entries) {
    if (!e.value.passed) throw inputError(`節 ${e.id} の翻訳が完了していません。CLI で再実行してから編集してください`);
  }

  let title: StepEntry | undefined;
  const found = foundTitle(ingest.cleanLatex, chosen.bodyPlan);
  if (found !== undefined && hasProse(found.text)) {
    const seg = titleSegment(found);
    const st = readStep(runDir, TITLE_SEGMENT_ID, key);
    const value = st === undefined ? undefined : SectionLoopCache.parse(st.value);
    if (st === undefined || value === undefined || !value.passed || translatedTitle(value.ja) === undefined) {
      throw inputError("タイトルの checkpoint がありません。CLI で再実行してタイトルを訳してから編集してください");
    }
    const key0 = titleInvalidation(seg, titleSlice(seg, ctx.resolved), ctx);
    title = { id: TITLE_SEGMENT_ID, source: seg, stored: st, value, current: st.invalidation === key0 };
  }

  const all = [...(title === undefined ? [] : [title]), ...chosen.entries];
  // 形式検査の版が違う節は、組み直しの中で訳し直しになる（LLM が要る）ので先に検査する。契約付録 §8（形式検査の版）・§9
  const occ = segmentFirstOccurrence(chosen.segments, ctx.resolved);
  for (const e of all) {
    const v = e.value;
    if (v.marked === undefined || v.gate === FORMAL_GATE) continue;
    const slice = e.id === TITLE_SEGMENT_ID ? titleSlice(e.source, ctx.resolved) : segmentSlice(e.source, ctx.resolved, occ);
    if ((recheckFormal(e.source, slice, v.marked, v.ja) ?? []).length > 0) {
      throw inputError(`節 ${e.id} は今の形式検査に通りません。CLI で再実行してから編集してください`);
    }
  }
  const migrated = all.some((e) => !e.current);
  if (migrated) {
    // 作った版が違う checkpoint を引き継ぐ条件: md が最後の用語集の生成から変わっていない＋原文と訳文が対応する。
    // 用語の検証で差し替えた run は、検証の後の用語集・brief・style とも比べる。契約付録 §4
    const verifiedStored = readStep(runDir, VERIFY_STEP, key);
    const verified = verifiedStored === undefined ? undefined : VerifiedGlossary.safeParse(verifiedStored.value);
    const matches = (base: GlossaryBuilderOut): boolean =>
      sameJson(parseGlossaryMd(renderGlossaryMd(base.resolved)), ctx.resolved) &&
      sameJson(parseBriefMd(renderBriefMd(base.brief)), ctx.brief) &&
      sameJson(parseStyleMd(renderStyleMd(base.style)), ctx.style);
    // 用語集の編集は glossary の step を書き直すので、どちらかと一致すれば未編集とみなす。
    const untouched = matches(glossaryValue) || (verified?.success === true && matches(verified.data));
    if (!untouched) {
      throw inputError(
        "glossary.md・brief.md・style.md が最後の翻訳のあとで編集されています。CLI で再実行して反映してから編集してください",
      );
    }
    for (const e of all.filter((x) => !x.current)) {
      const issues = alignmentIssues(e.source, e.value.ja);
      if (issues.length > 0) {
        throw inputError(`節 ${e.id} の checkpoint が原文と対応しません（${issues.join(", ")}）。CLI で再実行してから編集してください`);
      }
    }
  }

  return {
    outDir,
    runDir,
    paperId: ingest.paperId,
    key,
    input,
    contextWindow: chosen.cw,
    ingest,
    md,
    ctx,
    glossaryStep: { stored: glossaryStored, value: glossaryValue },
    segments: chosen.entries,
    title,
    migrated,
  };
}

export interface PreviewItem extends SentencePreview {
  where: string;
  label: string;
  source?: Piece[];
}

export interface EditPlan {
  paperId: string;
  src: string;
  rendering: string;
  oldForm: string;
  newForm: string;
  oldJa: string;
  newJa: string;
  shields: Shield[];
  sameJa: string[];
  // 訳文（タイトルと節）で置換する件数・ほかの語の一部なので置換しない件数。
  replaced: number;
  shielded: number;
  items: PreviewItem[];
  // 用語集の訳注・文書ブリーフ・文体契約・評価の訳注での書き換え。
  contextItems: PreviewItem[];
  migrated: boolean;
  writes: {
    md: { glossary: string; brief: string; style: string };
    steps: { id: string; value: unknown; invalidation: string }[];
  };
}

function sectionLabels(segments: readonly Segment[]): Map<string, string> {
  const labels = new Map<string, string>();
  let n = 0;
  for (const s of segments) {
    n += (s.latex.match(/\\section\*?\s*\{/g) ?? []).length;
    labels.set(s.id, n === 0 ? "冒頭" : `第 ${String(n)} 節`);
  }
  return labels;
}

function textItems(
  where: string,
  label: string,
  text: string,
  r: TermRewrite,
  macros: Macros,
  source?: Piece[][],
): PreviewItem[] {
  const occs = findOccurrences(text, r.oldJa, r.shields);
  if (occs.length === 0) return [];
  return sentencePreviews(text, occs, r.newJa, macros).map((p, i) => {
    const src = source === undefined || source.length === 0 ? undefined : source[Math.min(i, source.length - 1)];
    return { where, label, ...p, ...(src === undefined ? {} : { source: src }) };
  });
}

function findRow(rows: readonly ResolvedRow[], src: string): ResolvedRow {
  const hits = rows.filter((r) => r.src === src);
  if (hits.length === 0) throw inputError(`用語集に ${src} がありません`);
  if (hits.length > 1) throw inputError(`用語集に ${src} の行が ${String(hits.length)} 行あります。glossary.md を直してください`);
  return hits[0]!;
}

// 契約付録 §9。訳語の編集の計画（置換・書き直す checkpoint・確認画面の断片）。ファイルは書かない。
export function planTermEdit(state: PaperState, src: string, input: string): EditPlan {
  const row = findRow(state.ctx.resolved, src);
  if (!isEditable(row)) throw inputError(`${src} は原語のまま扱う語なので訳語を編集できません`);
  const bad = validateTermJa(input);
  if (bad !== undefined) throw inputError(bad);
  const oldJa = termJa(row)!;
  const next = editedForm(row, input);
  const badJa = validateTermJa(next.ja);
  if (badJa !== undefined) throw inputError(badJa);
  if (next.form === row.form) throw inputError("訳語が今と同じです");
  const r: TermRewrite = { oldJa, newJa: next.ja, shields: shieldsFor(state.ctx.resolved, src, oldJa) };

  const md = {
    glossary: rewriteGlossaryMd(state.md.glossary, src, next.form, r),
    brief: rewriteMdBody(state.md.brief, r, false),
    style: rewriteMdBody(state.md.style, r, true),
  };
  const ctx: StepContext = {
    resolved: parseGlossaryMd(md.glossary),
    brief: parseBriefMd(md.brief),
    style: parseStyleMd(md.style),
  };
  const sources = state.segments.map((e) => e.source);
  const firstOcc = segmentFirstOccurrence(sources, ctx.resolved);
  const labels = sectionLabels(sources);
  const macros = simpleMacros(state.ingest.cleanLatex);

  const items: PreviewItem[] = [];
  const contextItems: PreviewItem[] = [];
  const steps: EditPlan["writes"]["steps"] = [];
  let replaced = 0;
  let shielded = 0;
  const entries = [...(state.title === undefined ? [] : [state.title]), ...state.segments];
  for (const e of entries) {
    const occs = findOccurrences(e.value.ja, r.oldJa, r.shields);
    replaced += occs.filter((o) => o.shieldedBy === undefined).length;
    shielded += occs.filter((o) => o.shieldedBy !== undefined).length;
    const isTitle = e.id === TITLE_SEGMENT_ID;
    items.push(
      ...textItems(
        e.id,
        isTitle ? "タイトル" : labels.get(e.id) ?? "",
        e.value.ja,
        r,
        macros,
        sourceSentences(e.source.latex, src, macros),
      ),
    );
    e.value.warnIssues.forEach((w, i) =>
      contextItems.push(...textItems(e.id, `評価の訳注 ${String(i + 1)}`, w.message, r, macros)),
    );
    const value = SectionLoopCache.parse({
      ...e.value,
      ja: rewriteText(e.value.ja, r),
      ...(e.value.marked === undefined ? {} : { marked: rewriteText(e.value.marked, r) }),
      warnIssues: rewriteStrings(e.value.warnIssues, r),
    });
    const invalidation = isTitle
      ? titleInvalidation(e.source, titleSlice(e.source, ctx.resolved), ctx)
      : segmentInvalidation(e.source, segmentSlice(e.source, ctx.resolved, firstOcc), ctx);
    steps.push({ id: e.id, value, invalidation });
  }

  for (const old of state.ctx.resolved) {
    if (old.note !== undefined) contextItems.push(...textItems("glossary.md", `${old.src} の訳注`, old.note, r, macros));
  }
  contextItems.push(...textItems("brief.md", "文書ブリーフ", state.md.brief, r, macros));
  contextItems.push(...textItems("style.md", "文体契約", state.md.style, r, macros));

  const g = state.glossaryStep.value;
  const glossaryValue = GlossaryBuilderOut.parse({
    resolved: g.resolved.map((x) =>
      x.src === src
        ? { ...x, form: next.form, ...(x.note === undefined ? {} : { note: rewriteText(x.note, r) }) }
        : x.note === undefined
          ? x
          : { ...x, note: rewriteText(x.note, r) },
    ),
    brief: rewriteStrings(g.brief, r),
    style: rewriteStrings(g.style, r),
  });
  steps.push({ id: "glossary", value: glossaryValue, invalidation: state.glossaryStep.stored.invalidation });

  return {
    paperId: state.paperId,
    src,
    rendering: row.rendering,
    oldForm: row.form,
    newForm: next.form,
    oldJa,
    newJa: next.ja,
    shields: r.shields,
    sameJa: sameJaTerms(state.ctx.resolved, src, oldJa),
    replaced,
    shielded,
    items,
    contextItems,
    migrated: state.migrated,
    writes: { md, steps },
  };
}

// ── バックアップ（1 世代）──────────────────────────────

const MANAGED_FILES = ["glossary.md", "brief.md", "style.md", "notes.json", ".paper-id"];
const MANAGED_DIRS = [".run/steps", "translation/chapters", "translation/build", "translation/bilingual"];

export interface BackupInfo {
  paperId: string;
  src: string;
  oldForm: string;
  newForm: string;
  registerGlobal: boolean;
  createdAt: string;
}

interface Manifest extends BackupInfo {
  version: 1;
  entries: string[];
  // 適用が終わった直後の状態の指紋。元に戻す前に今の状態と比べる（その後の CLI 実行や手での編集を捨てない）。
  after?: string;
}

function editDir(outDir: string): string {
  return path.join(outDir, ".run", "glossary-edit");
}

function backupDir(outDir: string): string {
  return path.join(editDir(outDir), "backup");
}

function managedPaths(outDir: string): string[] {
  return [...MANAGED_FILES, ...MANAGED_DIRS, ...listDeliverables(outDir)].filter((rel) =>
    existsSync(path.join(outDir, rel)),
  );
}

function stagedBackupDir(outDir: string): string {
  return `${backupDir(outDir)}.next`;
}

// 適用前の状態を backup.next に写す。適用が成功したときだけ commitBackup で前の世代と入れ替える。
function stageBackup(outDir: string, info: BackupInfo): void {
  const next = stagedBackupDir(outDir);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(path.join(next, "files"), { recursive: true });
  const entries = managedPaths(outDir);
  for (const rel of entries) {
    cpSync(path.join(outDir, rel), path.join(next, "files", rel), { recursive: true });
  }
  const manifest: Manifest = { version: 1, ...info, entries };
  writeFileSync(path.join(next, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function commitBackup(outDir: string): void {
  const next = stagedBackupDir(outDir);
  const m = JSON.parse(readFileSync(path.join(next, "manifest.json"), "utf8")) as Manifest;
  writeFileSync(path.join(next, "manifest.json"), JSON.stringify({ ...m, after: stateFingerprint(outDir) }, null, 2));
  rmSync(backupDir(outDir), { recursive: true, force: true });
  renameSync(next, backupDir(outDir));
}

// md・notes と訳文の中身、checkpoint のファイル名（名前に無効化キーが入る）から作る指紋。PDF は組版のたびに変わるので含めない。
function stateFingerprint(outDir: string): string {
  const h = createHash("sha256");
  for (const rel of MANAGED_FILES) {
    const f = path.join(outDir, rel);
    h.update(`${rel}\0${existsSync(f) ? readFileSync(f) : ""}\0`);
  }
  const steps = path.join(outDir, ".run", "steps");
  for (const name of existsSync(steps) ? readdirSync(steps).sort() : []) h.update(`step\0${name}\0`);
  const chapters = path.join(outDir, "translation", "chapters");
  for (const name of existsSync(chapters) ? readdirSync(chapters).sort() : []) {
    h.update(`chapter\0${name}\0`);
    h.update(readFileSync(path.join(chapters, name)));
  }
  return h.digest("hex");
}

function readManifest(outDir: string): Manifest | undefined {
  try {
    const m = JSON.parse(readFileSync(path.join(backupDir(outDir), "manifest.json"), "utf8")) as Manifest;
    if (m.version !== 1 || !Array.isArray(m.entries)) return undefined;
    return m;
  } catch {
    return undefined;
  }
}

export function readBackupInfo(outDir: string): BackupInfo | undefined {
  const m = readManifest(outDir);
  if (m === undefined) return undefined;
  const { paperId, src, oldForm, newForm, registerGlobal, createdAt } = m;
  return { paperId, src, oldForm, newForm, registerGlobal, createdAt };
}

function restoreFrom(outDir: string, dir: string): void {
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const files = path.join(dir, "files");
  for (const rel of managedPaths(outDir)) rmSync(path.join(outDir, rel), { recursive: true, force: true });
  for (const rel of m.entries) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
    mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    cpSync(path.join(files, rel), path.join(outDir, rel), { recursive: true });
  }
}

// 失敗した適用を、その適用の前（backup.next）へ戻す。前の世代のバックアップは残す。
function rollbackStaged(outDir: string): void {
  restoreFrom(outDir, stagedBackupDir(outDir));
  rmSync(stagedBackupDir(outDir), { recursive: true, force: true });
}

function restoreBackup(outDir: string): Manifest {
  const m = readManifest(outDir);
  if (m === undefined) throw inputError("元に戻せる適用がありません");
  if (m.after !== undefined && m.after !== stateFingerprint(outDir)) {
    throw new JpaperError(
      2,
      "conflict",
      "適用のあとに CLI での再実行や手での編集があったため元に戻せません（戻すとその結果が失われます）",
    );
  }
  restoreFrom(outDir, backupDir(outDir));
  rmSync(backupDir(outDir), { recursive: true, force: true });
  return m;
}

// ── 適用・元に戻す ───────────────────────────────────

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function writePlan(state: PaperState, plan: EditPlan): void {
  writeAtomic(path.join(state.outDir, "glossary.md"), plan.writes.md.glossary);
  writeAtomic(path.join(state.outDir, "brief.md"), plan.writes.md.brief);
  writeAtomic(path.join(state.outDir, "style.md"), plan.writes.md.style);
  for (const s of plan.writes.steps) {
    writeStep(state.runDir, s.id, s.value, { invalidation: s.invalidation, key: state.key });
  }
}

export interface RetypesetOutcome {
  result: Result;
  // 呼ばれた LLM（呼ばれてはならない）。
  llmCalls: string[];
  notices: string[];
}

// 契約付録 §9。呼ばれたら失敗するクライアントで translatePaper を回し、checkpoint から組版だけを行う。
export async function retypesetWithoutLlm(state: PaperState, deps: EditDeps = {}): Promise<RetypesetOutcome> {
  const llmCalls: string[] = [];
  const notices: string[] = [];
  const client: LlmClient = {
    complete: (req) => {
      llmCalls.push(req.meta?.segmentId ?? req.meta?.role ?? "unknown");
      return Promise.reject(new JpaperError(1, "internal", "用語集の反映では LLM を呼びません"));
    },
  };
  const result = await translatePaper(
    state.input,
    {
      provider: "openrouter",
      openrouter: { ...DEFAULT_OPENROUTER, contextWindow: state.contextWindow },
      outDir: state.outDir,
      bilingual: true,
      signal: deps.signal,
    },
    {
      client,
      cacheKey: state.key,
      ...(deps.db === undefined ? { dbPath: deps.dbPath ?? defaultDbPath() } : { db: deps.db }),
      trace: () => undefined,
      latexRunner: deps.latexRunner,
      // 全体 DB への登録は registerGlobal を選んだときだけ（registerTerm）。組み直しでは書き戻さない。
      writeBackGlossary: false,
      onError: (m) => {
        if (!m.startsWith(SHARED_DEFAULT_NOTICE)) notices.push(m);
      },
    },
  );
  return { result, llmCalls, notices };
}

export interface ApplyOptions {
  registerGlobal?: boolean;
}

export interface ApplyOutcome {
  plan: Omit<EditPlan, "writes" | "items" | "contextItems">;
  pdf?: string;
  bilingualPdf?: string;
  bilingualStatus: string;
  registered: boolean;
  notices: string[];
}

function withRunLock<T>(runDir: string, fn: () => T): T {
  const lock = acquireRunLock(runDir);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function registerTerm(row: ResolvedRow, form: string, paperId: string, deps: EditDeps): boolean {
  if (!isAcceptableTerm(row.src)) return false;
  const db = deps.db ?? new GlossaryDb(deps.dbPath ?? defaultDbPath());
  try {
    db.writeBackProposed([{ src: row.src, ja: form, class: row.class, rendering: row.rendering, source: paperId }]);
    db.promote(row.src, form, null);
    return db.confirmedFor(row.src).some((e) => e.ja === form);
  } finally {
    if (deps.db === undefined) db.close();
  }
}

// 契約付録 §9。訳語を直し、訳文・checkpoint・md を書き換えて和訳 PDF と対訳 PDF を組み直す。
export async function applyTermEdit(
  outDir: string,
  src: string,
  input: string,
  opts: ApplyOptions = {},
  deps: EditDeps = {},
): Promise<ApplyOutcome> {
  const runDir = path.join(outDir, ".run");
  const key = deps.cacheKey ?? loadCacheKey();
  const editLock = acquireRunLock(editDir(outDir));
  try {
    const hadBilingual = listDeliverables(outDir).some((f) => f.endsWith("-bilingual.pdf"));
    const { state, plan } = withRunLock(runDir, () => {
      const state = loadPaperState(outDir, key);
      const plan = planTermEdit(state, src, input);
      stageBackup(outDir, {
        paperId: state.paperId,
        src,
        oldForm: plan.oldForm,
        newForm: plan.newForm,
        registerGlobal: opts.registerGlobal === true,
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
      });
      try {
        writePlan(state, plan);
      } catch (e) {
        rollbackStaged(outDir);
        throw e;
      }
      return { state, plan };
    });

    const out = await retypesetWithoutLlm(state, deps);
    const failure =
      out.llmCalls.length > 0
        ? new JpaperError(
            1,
            "internal",
            `組み直しで LLM が呼ばれました（${out.llmCalls.slice(0, 5).join(", ")}）。変更を元に戻しました`,
          )
        : out.result.status !== "ok"
          ? new JpaperError(
              out.result.exitCode === 2 ? 2 : 5,
              out.result.error?.kind ?? "typeset",
              `組み直しに失敗したため変更を元に戻しました: ${out.result.error?.message ?? "不明な失敗"}`,
            )
          : hadBilingual && out.result.summary.bilingual.status !== "ok"
            ? new JpaperError(
                5,
                "typeset",
                `対訳 PDF が組めなくなったため変更を元に戻しました: ${out.result.summary.bilingual.message ?? "不明な失敗"}`,
              )
            : undefined;
    if (failure !== undefined) {
      withRunLock(runDir, () => rollbackStaged(outDir));
      throw failure;
    }
    withRunLock(runDir, () => commitBackup(outDir));

    const row = findRow(state.ctx.resolved, src);
    const registered = opts.registerGlobal === true ? registerTerm(row, plan.newForm, state.paperId, deps) : false;
    const notices = [...out.notices];
    if (opts.registerGlobal === true && !registered) notices.push(`${src} は全体の用語 DB に登録できない語です`);
    const { writes: _w, items: _i, contextItems: _c, ...summary } = plan;
    return {
      plan: summary,
      pdf: out.result.pdfPath,
      bilingualPdf: out.result.summary.bilingual.pdfPath,
      bilingualStatus: out.result.summary.bilingual.status,
      registered,
      notices,
    };
  } finally {
    editLock.release();
  }
}

// 契約付録 §9。直前の適用の前の状態へ戻す（1 世代）。全体の用語 DB への登録は戻さない。
export function undoTermEdit(outDir: string): BackupInfo {
  const runDir = path.join(outDir, ".run");
  const editLock = acquireRunLock(editDir(outDir));
  try {
    const m = withRunLock(runDir, () => restoreBackup(outDir));
    const { paperId, src, oldForm, newForm, registerGlobal, createdAt } = m;
    return { paperId, src, oldForm, newForm, registerGlobal, createdAt };
  } finally {
    editLock.release();
  }
}
