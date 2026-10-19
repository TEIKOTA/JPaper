// 契約付録 §7.5・§8。core API（取り込み→用語バリア→並列翻訳→訳注→出力→RunSummary）。
import { checkRedactTerms, makeRedactor, matches, type Redactor } from "../ingest/redact.js";
import { loadCacheKey } from "../durable/cache-key.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, type Hash } from "node:crypto";
import path from "node:path";
import type {
  JpaperInput,
  LlmClient,
  ResolvedTerm,
  DocumentBrief,
  StyleContract,
} from "../types/contract.js";
import {
  GlossaryBuilderOut,
  TermCheck,
  VerifiedGlossary,
  RunSummary,
  JpaperInput as JpaperInputSchema,
  type BilingualSummary,
  Provider as ProviderSchema,
  type Result,
  type TraceSink,
  type Provider,
  type TranslatorNote,
} from "../types/contract.js";
import {
  JpaperError,
  resolveExitCode,
  toRunError,
  outwardMessage,
  type RunError,
} from "../types/errors.js";
import {
  paperOutDir,
  dbPath,
  contextWindowFor,
  defaultConcurrencyFor,
  requestTimeoutMsFor,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  CLAUDE_EFFORT_PATTERN,
  isClaudeModelId,
  type ClaudeConfig,
  type CodexConfig,
  type OllamaConfig,
  type OpenRouterConfig,
} from "../config.js";
import { IMAGE_PROVIDERS, makeLlmClient } from "../providers/index.js";
import { extractPdf, type PdfExtracted } from "../ingest/pdf/index.js";
import { isPdfFile, type PdfTools } from "../ingest/pdf/poppler.js";
import { z } from "zod";
import { paperExcerpt } from "../terminology/paper-excerpt.js";
import { applyVerification, carriedUnverified, isTargetCheck, verifyTargets } from "../terminology/verify.js";
import { verifyTerms } from "../agents/term-verifier.js";
import { withCliDefaults } from "../providers/defaults.js";
import { makeJsonlTrace, withTrace } from "../runtime/trace.js";
import { ingest, derivePaperId, type IngestDeps } from "../ingest/index.js";
import type { IngestLimits } from "../ingest/limits.js";
import { GlossaryDb } from "../terminology/db.js";
import { buildPaperGlossary, writeBackResolved } from "../terminology/glossary.js";
import {
  renderGlossaryMd,
  parseGlossaryMd,
  renderBriefMd,
  briefFromMd,
  styleFromMd,
  renderStyleMd,
  parseStyleMd,
  type ResolvedRow,
} from "../terminology/glossary-io.js";
import { isMacroDefinitionsOnly } from "../segment/macro-only.js";
import { findKatakanaDrift, describeDrift } from "../terminology/consistency.js";
import { segmentBudgetFor, type Segment } from "../segment/segmenter.js";
import { recheckFormal, runSectionLoop } from "./section-loop.js";
import {
  IngestCache,
  rebaseIngest,
  SectionLoopCache,
  planSegments,
  foundTitle,
  segmentSlice,
  segmentInvalidation,
  segmentFirstOccurrence,
  titleSlice,
  titleInvalidation,
} from "./step-keys.js";
import { buildNotes } from "./notes.js";
import { FORMAL_GATE, untranslatedHeadings } from "./quality-gate.js";
import { checkpoint, hashContext, pruneSteps, readStep, writeStep } from "../durable/checkpoint.js";
import { acquireRunLock, type RunLock } from "../durable/run-lock.js";
import {
  throwIfAborted,
  withSignal,
  withCallTimeout,
  withProviderErrors,
  withDeadline,
  type Deadline,
} from "../runtime/cancellation.js";
import { llmGate, withGate, type Gate } from "../runtime/concurrency.js";
import {
  resolveWorkLimits,
  createCallBudget,
  type WorkLimits,
} from "../runtime/work-budget.js";
import { assembleWithMap, type Layout } from "../tools/assemble-latex.js";
import {
  locateBodyTitle,
  placeBodyTitle,
  hasProse,
  titleSegment,
  translatedTitle,
  composeTitle,
  TITLE_SEGMENT_ID,
  type PaperTitle,
} from "../tools/paper-title.js";
import {
  defaultRunner,
  runBuildGate,
  unsafeSupportFiles,
  type LatexRunner,
  type BuildGateResult,
} from "../tools/build-gate.js";
import { injectFootnotes, renderBackmatter } from "../tools/render-notes.js";
import { findUnsafeTexCommands } from "../tools/tex-safety.js";
import { assembleBilingual } from "../tools/bilingual-latex.js";
import { deliverableName, dropDeliverables, publishDeliverable } from "../tools/pdf-name.js";

type TitleStatus = NonNullable<RunSummary["title"]>;

export interface TranslateOptions {
  provider: Provider;
  outDir?: string;
  ollama?: OllamaConfig;
  openrouter?: OpenRouterConfig;
  claude?: ClaudeConfig;
  codex?: CodexConfig;
  concurrency?: number;
  // 呼び出し側の中断。LLM 呼び出し・組版・arXiv 取得へ伝播し、exitCode 6 で返る。
  signal?: AbortSignal;
  // run 全体の期限（ms）。超過すると中断と同じ経路で exitCode 6 で返る。
  timeoutMs?: number;
  // 対訳 PDF（左=原文／右=和訳）を組むか。既定 true。契約付録 §8。
  bilingual?: boolean;
  // 用語集の訳を Web 検索の用例で確かめるか（claude・codex だけ）。既定 true。契約付録 §4
  verifyTerms?: boolean;
  // 訳注を PDF の初出の脚注（pageNotes。既定 false）・巻末の訳注一覧（endNotes。既定 true）に載せるか。notes.json は変えない。契約付録 §8
  pageNotes?: boolean;
  endNotes?: boolean;
  // PDF 入力で読むページ（"1-72" など。PDF の何枚目か）。契約付録 §8（PDF 入力）
  pages?: string;
  // PDF 入力で LARGE_PDF_PAGES を超えるページを読むことに同意済みか。
  allowLargePdf?: boolean;
  // 伏せ字にする語（CLI は --redact-file から読む）。取り込みの段で *** に置き換え、どの LLM 呼び出しにも渡さない。契約付録 §8（伏せ字）
  redact?: readonly string[];
}

// subprocess プロバイダは無制限並列に耐えないため翻訳の同時実行数を制限する。
// 契約付録 §8。1 本の失敗で即座に投げず、**全 worker の決着を待ってから**投げる。
// Promise.all のまま投げると translatePaper が返り、finally が run lock を解放した後も
// 残りの worker が checkpoint を書き続ける（亡霊）。⚠ landmines.md
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { err: unknown } | undefined;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      // 失敗後・中断後は新しいセグメントを取りに行かない（進行中の 1 本は provider 側で落ちる）。
      if (failure !== undefined) return;
      try {
        throwIfAborted(signal, "セグメント翻訳");
        results[i] = await fn(items[i]!);
      } catch (err) {
        failure ??= { err };
        return;
      }
    }
  }
  await Promise.all(
    // limit が壊れていても 1 本は回す（0 本だと結果配列が穴だらけのまま返る）。
    Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, worker),
  );
  if (failure !== undefined) throw failure.err;
  return results;
}

export interface TranslateDeps {
  client?: LlmClient;
  // checkpoint 署名鍵。web ハンドラのように 1 プロセスで複数テナントを捌く場合、
  // env 経由（JPAPER_HOME）は await を跨いで混ざるため呼び出し側から渡す。
  cacheKey?: Buffer;
  db?: GlossaryDb;
  dbPath?: string;
  ingest?: IngestDeps;
  // 取り込みのサイズ上限。web ではプラン別に締めたいので注入可能にする。
  limits?: IngestLimits;
  // 1 run が費やせる仕事量の上限（セグメント数・LLM 呼び出し回数）。プラン別に締められる。
  work?: Partial<WorkLimits>;
  // LLM 同時実行ゲート。既定はプロセス共有（リクエストをまたいで効く）。
  gate?: Gate;
  // LLM トレースの宛先。既定は <outDir>/.run/llm-trace.jsonl。注入クライアントにも掛かる。
  trace?: TraceSink;
  onError?: (message: string) => void;
  // 進捗。web の UI が「12/35 節完了」を出せるようにする副作用チャネル。
  onProgress?: (e: RunProgress) => void;
  latexRunner?: LatexRunner;
  // false なら用語集の結果を全体 DB へ書き戻さない（用語集の編集の組み直し。契約付録 §9）。既定 true。
  writeBackGlossary?: boolean;
  // 注入した client が LlmRequest.webSearch を扱えるか。既定 false（内部で作る claude・codex の client は扱える）。契約付録 §4
  webSearch?: boolean;
  // 注入した client が LlmRequest.images を扱えるか。既定 false。契約付録 §8（PDF 入力）
  images?: boolean;
  // PDF の読み取りに使う poppler の呼び出し（テスト用）。
  pdfTools?: PdfTools;
}

export interface RunProgress {
  phase: "read" | "ingest" | "context" | "translate" | "typeset";
  segmentId?: string;
  done: number;
  total: number;
  // 契約付録 §5
  passed?: boolean;
  failedKinds?: string[];
  usedRevisions?: number;
  maxRevisions?: number;
}

interface PaperContext {
  resolved: ResolvedRow[];
  brief: DocumentBrief;
  style: StyleContract;
  proposedAdded: number;
  // 正常完了時に outDir へ書き出す md（パス→中身）。中断時は書かれない。
  pending: Record<string, string>;
  // 用語の検証の結果。検証しなかったら undefined。契約付録 §4
  checks?: TermCheck[];
  // 未確認の訳注を付ける語（この run の検証の結果か、glossary.md を使う run なら前の run の結果）。
  unverified: string[];
}

// 出力先がどの論文のものかを示す印。同じ outDir に別の論文が来たら既存 md を採用しない。
// 1 行目が paperId、2 行目が本文のダイジェスト（旧版の印は 1 行だけ）。
const PAPER_STAMP = ".paper-id";

interface PaperStamp {
  paperId: string;
  // 旧版の印には無い。undefined のときは paperId だけで判定する（既存の出力先を壊さない）。
  sourceDigest?: string;
}

function readStamp(outDir: string): PaperStamp | undefined {
  try {
    const [id, digest] = readFileSync(path.join(outDir, PAPER_STAMP), "utf8").split("\n");
    if (id === undefined || id.trim() === "") return undefined;
    const d = digest?.trim();
    return { paperId: id.trim(), sourceDigest: d === "" ? undefined : d };
  } catch {
    return undefined;
  }
}

function stampedPaperId(outDir: string): string | undefined {
  return readStamp(outDir)?.paperId;
}

// paperId はファイル名の stem から作るので、別内容の 2 論文がどちらも main.tex
// （arXiv ソースで最も普通の名前）だと一致する。paperId だけを印にすると
// 「別論文なら既存 md を採用しない」ガードが発動せず、A の brief が B の全
// セグメントのプロンプトに載ったまま両方 exit 0 で返る（実測）。本文の
// ダイジェストを併せて印にする。⚠ landmines.md
function sourceDigestOf(cleanLatex: string): string {
  return createHash("sha256").update(cleanLatex).digest("hex").slice(0, 16);
}

// glossary.md が有れば編集を正本として読み戻す（無ければ builder 実行）。既存 md は上書きしない。
// 機械出力の md は run が正常に完了したときだけ outDir へ確定する（promote）。中断・例外で
// 抜けた run の中間物が次の run の正本になると、別論文の文脈まで上書きされる。
async function loadOrBuildContext(
  runDir: string,
  outDir: string,
  client: LlmClient,
  db: GlossaryDb,
  paperId: string,
  cleanLatex: string,
  cacheKey?: Buffer,
  warn?: (m: string) => void,
  writeBack = true,
  verify = false,
  localInput = false,
  redact?: Redactor,
): Promise<PaperContext> {
  const built = await checkpoint(
    runDir,
    "glossary",
    GlossaryBuilderOut,
    () => buildPaperGlossary(client, db, paperId, cleanLatex),
    { invalidation: hashContext(cleanLatex), key: cacheKey },
  );
  const glossaryMd = path.join(outDir, "glossary.md");
  const briefMd = path.join(outDir, "brief.md");
  const styleMd = path.join(outDir, "style.md");

  // 印が無い出力先は旧版が作ったもの＝これまでどおり採用する（人間の編集を捨てない）。
  const stamp = readStamp(outDir);
  const digest = sourceDigestOf(cleanLatex);
  const otherPaper = stamp !== undefined && stamp.paperId !== paperId;
  // paperId が同じでも本文が違えば別論文（同名ファイルの衝突）。ダイジェストを持たない
  // 旧版の印では判定できないので、その場合は従来どおり paperId だけで見る。
  const otherSource =
    stamp?.sourceDigest !== undefined && stamp.sourceDigest !== digest;
  const foreign = otherPaper || otherSource;
  if (otherPaper) {
    warn?.(
      `出力先は別の論文（${stamp?.paperId ?? "不明"}）のものなので既存の glossary.md / brief.md / style.md は使いません`,
    );
  } else if (otherSource) {
    warn?.(
      `出力先には同じ名前（${paperId}）で内容の違う論文があるので既存の glossary.md / brief.md / style.md は使いません`,
    );
  }
  // 伏せ字の run は、本文のダイジェストが一致する出力先の md だけを、語を含まないときに採用する。契約付録 §8（伏せ字）
  const adopt = (file: string): boolean =>
    !foreign &&
    existsSync(file) &&
    (redact === undefined || adoptRedacted(file));
  const adoptRedacted = (file: string): boolean => {
    const ok = stamp?.sourceDigest === digest && !matches(readFileSync(file, "utf8"), redact!);
    if (!ok) warn?.(`伏せ字の run なので、本文が同じと確かめられないか語を含む ${path.basename(file)} は使いません`);
    return ok;
  };

  const pending: PaperContext["pending"] = {};
  let resolved: ResolvedRow[] = built.resolved;
  let checks: TermCheck[] | undefined;
  let unverified: string[] = [];
  let proposedAdded = 0;
  let context: GlossaryBuilderOut = built;
  if (adopt(glossaryMd)) {
    // 既存 md が正本（空にする編集も尊重する）。検証もしない。契約付録 §4
    resolved = parseGlossaryMd(readFileSync(glossaryMd, "utf8"));
    unverified = carriedUnverified(resolved, previousChecks(runDir, cacheKey)).map((c) => c.src);
    if (writeBack) proposedAdded = writeBackResolved(db, built, paperId);
  } else {
    if (verify) {
      const verified = await verifyGlossary(runDir, client, db, paperId, cleanLatex, built, cacheKey, warn, localInput);
      context = { resolved: verified.resolved, brief: verified.brief, style: verified.style };
      checks = verified.checks;
      unverified = checks.filter((c) => c.status === "unverified").map((c) => c.src);
      writeStep(runDir, VERIFY_RESULT_STEP, { checks }, { key: cacheKey });
    } else {
      writeStep(runDir, VERIFY_RESULT_STEP, { checks: [] }, { key: cacheKey });
    }
    resolved = context.resolved;
    if (writeBack) proposedAdded = writeBackResolved(db, context, paperId);
    pending[glossaryMd] = renderGlossaryMd(resolved, checks);
  }

  // 出力先の md が checkpoint の値を書き出したものと同じ（未編集）なら、読み戻さずにその値を使う。契約付録 §4
  const stored = readStep(runDir, VERIFY_STEP, cacheKey);
  const verified = stored === undefined ? undefined : VerifiedGlossary.safeParse(stored.value);
  const saved = [...(verified?.success === true ? [verified.data] : []), context, built];

  let brief = context.brief;
  if (adopt(briefMd)) brief = briefFromMd(readFileSync(briefMd, "utf8"), saved.map((c) => c.brief));
  else pending[briefMd] = renderBriefMd(context.brief);

  let style = context.style;
  if (adopt(styleMd)) style = styleFromMd(readFileSync(styleMd, "utf8"), saved.map((c) => c.style));
  else pending[styleMd] = renderStyleMd(context.style);

  // 用語集は全セグメントのプロンプトへ載るので、内部矛盾はそのまま訳文全体へ伝播する。
  // 落とさず警告に留める（語形の違いも揺れではあるが、断定はしない）。契約付録 §3。
  for (const d of findKatakanaDrift(resolved)) warn?.(describeDrift(d));

  return { resolved, brief, style, proposedAdded, pending, unverified, ...(checks === undefined ? {} : { checks }) };
}

// 検証の版。採否の規則・対象語の選び方・指示を変えたら上げる（checkpoint の無効化キーに入る）。
const VERIFY_VERSION = 5;
export const VERIFY_STEP = "term-verify";
// 直近の検証の結果（失敗した run を含む）。キャッシュには使わない。
export const VERIFY_RESULT_STEP = "term-checks";
const TermChecks = z.object({ checks: z.array(TermCheck) });

// 差し替えで brief・style・訳注が上限を超えたら、差し替えずに未確認（few-sites）として返す。契約付録 §4
function withinLimits<V extends { resolved: GlossaryBuilderOut["resolved"]; brief: unknown; style: unknown; checks: TermCheck[] }>(
  built: GlossaryBuilderOut,
  v: V,
): V {
  if (VerifiedGlossary.safeParse(v).success) return v;
  const originalOf = new Map(built.resolved.map((r) => [r.src, r.form]));
  return {
    ...v,
    ...built,
    checks: v.checks
      .filter(isTargetCheck)
      .map((c) =>
        c.status === "confirmed"
          ? c
          : {
              src: c.src,
              status: "unverified" as const,
              form: originalOf.get(c.src) ?? c.form,
              reason: c.status === "replaced" ? ("few-sites" as const) : c.reason,
              sources: [],
            },
      ),
  };
}

// 用語集のうち対象語を Web 検索の用例で確かめ、採れた用例の表記へ差し替える（brief・style・訳注も）。契約付録 §4
// 検証の呼び出しが失敗したら、対象語を全て未確認として進める（失敗は checkpoint に残さない）。
async function verifyGlossary(
  runDir: string,
  client: LlmClient,
  db: GlossaryDb,
  paperId: string,
  cleanLatex: string,
  built: GlossaryBuilderOut,
  cacheKey: Buffer | undefined,
  warn: ((m: string) => void) | undefined,
  localInput: boolean,
): Promise<VerifiedGlossary> {
  const excerpt = paperExcerpt(cleanLatex);
  const targets = verifyTargets(built.resolved, excerpt, (src) => db.confirmedFor(src).length > 0);
  if (targets.length === 0) return { ...built, checks: [] };
  let result: VerifiedGlossary;
  try {
    result = await checkpoint(
      runDir,
      VERIFY_STEP,
      VerifiedGlossary,
      async () => {
        if (localInput) {
          warn?.("arXiv 以外の入力の論文の用語と abstract の冒頭を Web 検索に出して用語を確かめます（止めるには --no-verify-terms）");
        }
        const v = withinLimits(built, applyVerification(built, targets, await verifyTerms(client, { paperId, context: excerpt, targets })));
        return { resolved: v.resolved, brief: v.brief, style: v.style, checks: v.checks };
      },
      {
        invalidation: hashContext(String(VERIFY_VERSION), JSON.stringify(built), JSON.stringify(targets)),
        key: cacheKey,
      },
    );
  } catch (e) {
    if (e instanceof JpaperError && (e.kind === "canceled" || e.kind === "timeout")) throw e;
    warn?.(`用語の検証に失敗したため、対象の ${String(targets.length)} 語を未確認として進めます: ${String((e as Error)?.message ?? e)}`);
    return {
      ...built,
      checks: targets.map((t) => ({ src: t.src, status: "unverified" as const, form: t.form, reason: "failed" as const, sources: [] })),
    };
  }
  for (const c of result.checks) {
    if (c.status === "replaced" && c.via !== undefined) {
      warn?.(`用語の訳を ${c.via} の差し替えに揃えました: ${c.src}「${c.original ?? ""}」→「${c.form}」`);
    } else if (c.status === "replaced") {
      warn?.(`用語の訳を用例に合わせました: ${c.src}「${c.original ?? ""}」→「${c.form}」（出典 ${c.sources.join(" ")}）`);
    } else if (c.status === "unverified") {
      const via = c.via === undefined ? "" : `（${c.via} の差し替えに揃えた。元の訳「${c.original ?? ""}」）`;
      warn?.(`用語の訳を Web 検索の用例で確かめられませんでした（未確認）: ${c.src}「${c.form}」${via}`);
    }
  }
  return result;
}

// 前の run の検証の結果（出力先の glossary.md を使う run で、未確認の訳注を引き継ぐ）。契約付録 §4
function previousChecks(runDir: string, cacheKey: Buffer | undefined): TermCheck[] {
  const stored = readStep(runDir, VERIFY_RESULT_STEP, cacheKey);
  const parsed = stored === undefined ? undefined : TermChecks.safeParse(stored.value);
  return parsed?.success === true ? parsed.data.checks : [];
}

// 出力先が別の論文のものだったら、この run の成果物を書く前に前の論文の正本を落とす。
// 落とさないと、組版で失敗した run が「.paper-id と glossary.md は論文 A・chapters は
// 論文 B」という世代混在のディレクトリを残す（実測）。手で latexmk すれば A の
// プリアンブル系 md と B の本文が混ざる。出力先は 1 つの論文のものと決める。
function clearForeignContext(outDir: string, paperId: string): void {
  const stamped = stampedPaperId(outDir);
  if (stamped === undefined || stamped === paperId) return;
  for (const f of ["glossary.md", "brief.md", "style.md", PAPER_STAMP]) {
    rmSync(path.join(outDir, f), { force: true });
  }
  rmSync(path.join(outDir, "translation", "build"), { recursive: true, force: true });
  rmSync(path.join(outDir, "translation", "bilingual"), { recursive: true, force: true });
  dropDeliverables(outDir);
}

// run が最後まで到達したときだけ md を確定する。
function promoteContext(
  outDir: string,
  paperId: string,
  sourceDigest: string,
  pending: PaperContext["pending"],
): void {
  mkdirSync(outDir, { recursive: true });
  for (const [file, body] of Object.entries(pending)) writeFileSync(file, body);
  writeFileSync(path.join(outDir, PAPER_STAMP), `${paperId}\n${sourceDigest}\n`);
}

// ingest キャッシュの無効化キー: 入力が変わったら再取り込み（path 上書き・arXiv v1/v2 は paperId 共有）。
// 内容ダイジェストの走査上限。超える入力は取り込み側が too-large で落とすので、
// 部分ハッシュのまま先へ進めてよい（成功する run では必ず全体を覆う）。
const MAX_SIGNATURE_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_ENTRIES = 10_000;

function digestFile(h: Hash, file: string, budget: { bytes: number }): void {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, budget.bytes), null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      budget.bytes -= n;
      if (budget.bytes <= 0) break;
    }
  } finally {
    closeSync(fd);
  }
}

function digestTree(h: Hash, dir: string, rel: string, budget: { bytes: number; entries: number }): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (--budget.entries <= 0 || budget.bytes <= 0) return;
    const abs = path.join(dir, e.name);
    const key = rel === "" ? e.name : `${rel}/${e.name}`;
    h.update(`\u0000${key}\u0000`);
    if (e.isDirectory()) digestTree(h, abs, key, budget);
    else if (e.isFile()) digestFile(h, abs, budget);
  }
}

// checkpoint の無効化キーは入力の**内容**を代表しなければならない。(path, mtime, size) で
// 代表させていた頃は、同一パス・同一サイズ・秒単位で同じ mtime（tar/cp -p が復元する形）の
// 別論文が同じ入力とみなされ、論文 B を投げた利用者に論文 A の訳文が exit 0 で返った
// （LLM 呼び出し 0 回）。署名の破綻ではなく、署名対象が内容を代表していない設計の穴。
// 論文 ID の元になる名前（arXiv ID かパス）。
// 契約付録 §8（取り込みの checkpoint のパス）
function ingestsIntoRunDir(input: JpaperInput, redacted: boolean): boolean {
  if (input.kind !== "path" || redacted) return true;
  try {
    if (statSync(input.path).isDirectory()) return false;
  } catch {
    return false;
  }
  return !/\.tex$/i.test(input.path);
}

function ingestPaperIdSource(input: JpaperInput): string {
  return input.kind === "arxiv" ? input.id : input.path.replace(/[/\\]+$/, "");
}

export function inputSignature(input: JpaperInput): string {
  if (input.kind === "arxiv") return hashContext("arxiv", input.id);
  const abs = path.resolve(input.path);
  try {
    const h = createHash("sha256");
    const st = statSync(abs);
    if (st.isDirectory()) {
      digestTree(h, abs, "", { bytes: MAX_SIGNATURE_BYTES, entries: MAX_SIGNATURE_ENTRIES });
    } else {
      digestFile(h, abs, { bytes: MAX_SIGNATURE_BYTES });
    }
    return hashContext("path", abs, h.digest("hex"));
  } catch {
    return hashContext("path", abs);
  }
}

function countByTrigger(notes: TranslatorNote[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const n of notes) acc[n.trigger] = (acc[n.trigger] ?? 0) + 1;
  return acc;
}

// 単一ユーザ既定にフォールバックした資源を数える。マルチテナントで気づかず共有したまま
// 本番に出るのを防ぐため、observable にして警告も出す（契約付録 §8）。
type SharedDefault = "db" | "cacheKey" | "outDir" | "limits" | "work";
export const SHARED_DEFAULT_NOTICE = "単一ユーザ既定を使用";
function sharedDefaultsOf(opts: TranslateOptions, deps: TranslateDeps): SharedDefault[] {
  const shared: SharedDefault[] = [];
  if (deps.db === undefined && (deps.dbPath === undefined || deps.dbPath.trim() === "")) {
    shared.push("db");
  }
  if (deps.cacheKey === undefined) shared.push("cacheKey");
  if (opts.outDir === undefined || opts.outDir.trim() === "") shared.push("outDir");
  // 既定の取り込み上限・仕事量上限は CLI 単体利用向けに緩い。実測では資源の分離より
  // こちらのほうがプロセスの生死を左右する（既定のまま 506KiB の .tar.gz が 508MiB に
  // 展開されて成功し、4 本併走で正常リクエストの p50 が 79ms→1,789ms になった）。
  if (deps.limits === undefined) shared.push("limits");
  if (deps.work === undefined) shared.push("work");
  return shared;
}

function idleBilingual(opts: TranslateOptions): BilingualSummary {
  return { status: opts.bilingual === false ? "disabled" : "skipped", pairs: 0, fallbackSegments: 0 };
}

function failResult(
  paperId: string,
  outDir: string,
  error: RunError,
  bilingual: BilingualSummary,
  sharedDefaults: SharedDefault[] = [],
  llmCalls = 0,
  segments = { total: 0, passed: 0, failed: 0 },
): Result {
  const exitCode = error.code;
  return {
    status: "failed",
    exitCode,
    error,
    summary: RunSummary.parse({
      paperId,
      outDir,
      segments,
      revisions: { max: 0, used: 0 },
      glossary: { proposedAdded: 0 },
      notes: { total: 0, byTrigger: {} },
      layout: null,
      buildOk: null,
      bilingual,
      sharedDefaults,
      llmCalls,
      exitCode,
    }),
  };
}

// 訳したタイトルを入れた組版入力。前文の \title なら title、本文の \title なら差し替え済みの segments。契約付録 §8
interface Titled {
  segments: { id: string; tex: string }[];
  title?: string;
}

interface TypesetOutcome {
  layout: Layout | null;
  buildOk: boolean | null;
  pdfPath?: string;
  exitCode: number;
  message?: string;
  // 訳したタイトルを入れたまま組めたか（原題で組み直した・タイトルを渡していないなら false）。
  titleApplied: boolean;
}

// 節ループ・組版ゲートの失敗は例外ではなく戻り値で来るので、ここで構造化エラーに写す。
// 汚染の兆候として即失敗させる形式エラー。品質の失敗と同じ見た目で返すと、
// 運用者はプロンプトインジェクション／モデル汚染が起きたことに気づけない。
const CONTAMINATION_KINDS = new Set(["unsafe-command", "structure"]);

export function contaminatedSegments(
  results: readonly { segmentId: string; passed: boolean; failedKinds?: readonly string[] }[],
): string[] {
  return results
    .filter((r) => !r.passed && (r.failedKinds ?? []).some((k) => CONTAMINATION_KINDS.has(k)))
    .map((r) => r.segmentId);
}

// 落ちた節の最後の指摘の置き場（.run の中）。契約付録 §8（落ちた節の指摘）
export const FAILED_SEGMENTS_FILE = "failed-segments.json";
const WHERE_ISSUES = `。最後の指摘は .run/${FAILED_SEGMENTS_FILE}`;

function gateError(
  exitCode: number,
  results: readonly {
    segmentId: string;
    passed: boolean;
    failCode?: number;
    failedKinds?: readonly string[];
  }[],
  typesetMessage?: string,
): RunError {
  const bad = results.filter((r) => !r.passed);
  // 終了コードは優先順位で 1 つに決まる（3 > 4）が、報告からもう一方を消してはいけない。
  // failCode を見ずに全失敗を並べると、品質で落ちた節が「形式検査を通過しない」の一覧に
  // 混ざり、運用者は存在しない形式的欠陥を探すことになる（実測: seg-0019）。
  // 古い checkpoint 由来で failCode を持たない結果は形式側に倒す（見え方を変えない）。
  const of = (code: 3 | 4) => bad.filter((r) => (r.failCode ?? 3) === code);
  const ids = of(4).map((r) => r.segmentId).slice(0, 10).join(", ");
  // 落ちた検査の種別は固定語彙なので外向きに出せる（論文由来の文字列は混ざらない）。
  // ID だけだと、失敗した訳文が書き出されない設計と相まって手掛かりが 1 つも残らない。
  const withKinds = of(3)
    .slice(0, 10)
    .map((r) => {
      const kinds = [...new Set(r.failedKinds ?? [])].sort();
      return kinds.length === 0 ? r.segmentId : `${r.segmentId}(${kinds.join(", ")})`;
    })
    .join(", ");
  // 同時に起きた他方の失敗も添える（優先順位で選ぶことと、報告から消すことは別）。
  const alsoQuality = of(4).length === 0 ? "" : `。品質基準に達しないセグメント: ${of(4).map((r) => r.segmentId).slice(0, 10).join(", ")}`;
  const alsoFormal = of(3).length === 0 ? "" : `。形式検査を通過しないセグメント: ${of(3).map((r) => r.segmentId).slice(0, 10).join(", ")}`;
  if (exitCode === 3) {
    const tainted = contaminatedSegments(results);
    if (tainted.length > 0) {
      return {
        kind: "formal",
        code: 3,
        message: `訳文が危険コマンド・文書構造の破壊を持ち込みました（汚染の疑い）: ${tainted.slice(0, 10).join(", ")}${WHERE_ISSUES}`,
      };
    }
    return {
      kind: "formal",
      code: 3,
      message: `形式検査を通過しないセグメントがあります: ${withKinds}${alsoQuality}${WHERE_ISSUES}`,
    };
  }
  if (exitCode === 4) {
    return {
      kind: "quality",
      code: 4,
      message: `品質基準に達しないセグメントがあります: ${ids}${alsoFormal}${WHERE_ISSUES}`,
    };
  }
  if (exitCode === 5) {
    // 中身は latexmk ログの切り出し＝論文が内容を操作できる。外向きの出口で必ず検疫する。
    return {
      kind: "typeset",
      code: 5,
      message: outwardMessage(typesetMessage ?? "全文組版ゲートに失敗しました"),
      detail: typesetMessage,
    };
  }
  return { kind: "internal", code: exitCode, message: `未分類の失敗です（exitCode ${exitCode}）` };
}

// 通った節の checkpoint が別の版の形式検査で通ったものなら、印のままの訳文を今の検査にかけ直す。
// 通れば版を書き換えて使い、落ちれば訳し直す。印のままの訳文を持たない・訳文と対応しない checkpoint はそのまま使う。契約付録 §8（形式検査の版）
async function recheckCached(
  r: SectionLoopCache,
  seg: Segment,
  slice: ResolvedTerm[],
  retranslate: () => Promise<SectionLoopCache>,
  save: (v: SectionLoopCache) => void,
  onRetranslate: () => void,
): Promise<SectionLoopCache> {
  if (!r.passed || r.marked === undefined || r.gate === FORMAL_GATE) return r;
  const issues = recheckFormal(seg, slice, r.marked, r.ja);
  if (issues === undefined) return r;
  if (issues.length === 0) {
    const v = { ...r, gate: FORMAL_GATE };
    save(v);
    return v;
  }
  onRetranslate();
  return retranslate();
}

// 落ちた節が無い run では前の run の記録を消す。
function writeFailedSegments(runDir: string, runId: string, failed: readonly SectionLoopCache[]): void {
  const file = path.join(runDir, FAILED_SEGMENTS_FILE);
  if (failed.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const segments = failed.map((r) => ({
    segmentId: r.segmentId,
    failCode: r.failCode ?? 3,
    failedKinds: r.failedKinds,
    usedRevisions: r.usedRevisions,
    maxRevisions: r.maxRevisions,
    lastIssues: r.lastIssues ?? null,
  }));
  writeFileSync(file, `${JSON.stringify({ runId, createdAt: new Date().toISOString(), segments }, null, 2)}\n`);
}

// ログ由来の断片は長さを切る（1 行 4000 文字のログで message が上限を無視して膨らむ）。
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function summarizeGateFailure(g: BuildGateResult): string {
  const parts: string[] = [];
  if (g.failedSegments.length)
    parts.push(`翻訳起因: ${g.failedSegments.map((f) => `${f.id}(${f.line})`).join(", ")}`);
  if (g.structuralErrors.length) parts.push(`構造: ${g.structuralErrors.slice(0, 3).map((e) => clip(e)).join(" / ")}`);
  if (g.missingFigures.length) parts.push(`欠図: ${g.missingFigures.map((f) => clip(f, 60)).join(", ")}`);
  if (g.droppedFigures.length) parts.push(`図欠落: ${g.droppedFigures.map((f) => clip(f, 60)).join(", ")}`);
  // 翻訳起因・構造の誤りで組版が止まったときは未解決参照を出さない。契約付録 §6
  const halted = g.failedSegments.length > 0 || g.structuralErrors.length > 0;
  if (g.unresolvedRefs.length && !halted)
    parts.push(`未解決参照: ${g.unresolvedRefs.slice(0, 5).map((r) => clip(r, 60)).join(", ")}`);
  if (g.shadowedPackages.length)
    parts.push(`同梱パッケージを無効化: ${g.shadowedPackages.join(", ")}`);
  return parts.join(" | ") || "不明なビルド失敗";
}

// 全文組版ゲート: 原プリアンブル温存を試し、構造起因失敗のみ共通テンプレへ明示的にフォールバック（surface）。
async function typeset(
  cleanLatex: string,
  segments: { id: string; tex: string }[],
  opts: { outDir: string; sourceDir: string; mainDir: string; figures: string[]; titled?: Titled },
  runner: LatexRunner | undefined,
  surface: (m: string) => void,
  signal?: AbortSignal,
): Promise<TypesetOutcome> {
  // 組版は隣の staging へ行い、成功したときだけ正規の build を置き換える。
  // 直接 build を使うと stageBuild の rmSync が先に走り、**失敗した run が前回の
  // 成功 PDF を破壊する**（実測: 論文 A を成功させた outDir で論文 B を組版失敗
  // させると、A の build/main.pdf が消えた）。⚠ landmines.md
  const finalDir = path.join(opts.outDir, "translation", "build");
  const buildDir = `${finalDir}.next`;
  const publish = (pdfPath?: string): string | undefined => {
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(buildDir, finalDir);
    return pdfPath === undefined
      ? undefined
      : path.join(finalDir, path.relative(buildDir, pdfPath));
  };
  const discard = (): void => {
    rmSync(buildDir, { recursive: true, force: true });
  };
  let titled = opts.titled;
  const build = (mode: Layout, withTitle: Titled | undefined): Promise<BuildGateResult> => {
    const { mainTex, sourceMap } = assembleWithMap({
      cleanLatex,
      segments: withTitle?.segments ?? segments,
      mode,
      title: withTitle?.title,
    });
    return runBuildGate(
      {
        buildDir,
        mainTex,
        sourceDir: opts.sourceDir,
        mainDir: opts.mainDir,
        figures: opts.figures,
        sourceMap,
        originalTex: cleanLatex,
        signal,
      },
      runner,
    );
  };
  // 訳したタイトルで翻訳起因の失敗になったときだけ、同じレイアウトを原題で組み直す。契約付録 §8
  const run = async (mode: Layout): Promise<BuildGateResult> => {
    const g = await build(mode, titled);
    if (g.buildOk || titled === undefined || g.failedSegments.length === 0) return g;
    const plain = await build(mode, undefined);
    if (!plain.buildOk) return g;
    titled = undefined;
    surface("訳したタイトルでは組版できなかったため原題のまま組版します");
    return plain;
  };
  const titleApplied = (): boolean => titled !== undefined;
  // 成否に関わらず、無効化した同梱パッケージは体裁差の原因になるので surface する。
  const noteShadowed = (g: BuildGateResult): void => {
    if (g.shadowedPackages.length)
      surface(`配布版を優先し同梱パッケージを無効化: ${g.shadowedPackages.join(", ")}`);
  };
  // pdfPath は buildOk のときだけ返す（ゲート棄却済みの成果物を成功として渡さない）。
  const orig = await run("original");
  noteShadowed(orig);
  if (orig.buildOk) {
    return {
      layout: "original",
      buildOk: true,
      pdfPath: publish(orig.pdfPath),
      exitCode: 0,
      titleApplied: titleApplied(),
    };
  }
  if (orig.failedSegments.length > 0) {
    // 翻訳起因のビルド失敗。再訳ループ(WP10)未実装のため明示的失敗として surface する。
    const m = `組版失敗(翻訳起因・要再訳): ${summarizeGateFailure(orig)}`;
    surface(m);
    discard();
    return { layout: "original", buildOk: false, exitCode: 5, message: m, titleApplied: titleApplied() };
  }
  surface(`原プリアンブルで組めず共通テンプレへフォールバック: ${summarizeGateFailure(orig)}`);
  const tmpl = await run("template");
  if (tmpl.buildOk) {
    return {
      layout: "template",
      buildOk: true,
      pdfPath: publish(tmpl.pdfPath),
      exitCode: 0,
      titleApplied: titleApplied(),
    };
  }
  const m = `組版失敗(テンプレでも不可): ${summarizeGateFailure(tmpl)}`;
  surface(m);
  discard();
  return { layout: "template", buildOk: false, exitCode: 5, message: m, titleApplied: titleApplied() };
}

// 対訳 PDF。和訳 PDF の publish 後に別の staging で組み、結果は戻り値だけで返す（中断だけは投げる）。
// 組めなければ前回の対訳も消す。契約付録 §8・対訳 PDF ADR(20261006)。
async function typesetBilingual(
  cleanLatex: string,
  source: { id: string; tex: string }[],
  translated: { id: string; tex: string }[],
  layout: Layout,
  opts: { outDir: string; sourceDir: string; mainDir: string; figures: string[]; title?: string },
  runner: LatexRunner | undefined,
  surface: (m: string) => void,
  signal?: AbortSignal,
): Promise<BilingualSummary> {
  const finalDir = path.join(opts.outDir, "translation", "bilingual");
  const buildDir = `${finalDir}.next`;
  let pairs = 0;
  let fallbackSegments = 0;
  const drop = (): void => {
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(finalDir, { recursive: true, force: true });
  };
  const failed = (m: string): BilingualSummary => {
    drop();
    const message = `対訳 PDF の組版に失敗しました（和訳 PDF は出力済み）: ${m}`;
    surface(message);
    return { status: "failed", message: outwardMessage(message), pairs, fallbackSegments };
  };
  const assemble = (mode: Layout) =>
    assembleBilingual({
      cleanLatex,
      translatedMainTex: assembleWithMap({ cleanLatex, segments: translated, mode, title: opts.title }).mainTex,
      source,
      translated,
    });
  const gate = (mainTex: string): Promise<BuildGateResult> =>
    runBuildGate(
      {
        buildDir,
        mainTex,
        sourceDir: opts.sourceDir,
        mainDir: opts.mainDir,
        figures: opts.figures,
        sourceMap: [],
        originalTex: cleanLatex,
        signal,
      },
      runner,
    );
  try {
    const b = assemble(layout);
    pairs = b.pairs;
    fallbackSegments = b.fallbackSegments.length;
    if (fallbackSegments > 0) {
      surface(
        `対訳: 段落数が一致せずセグメント全体を 1 ペアにしました: ${b.fallbackSegments.slice(0, 10).join(", ")}`,
      );
    }
    if (b.commentMismatch.length > 0) {
      surface(
        `対訳: 訳文の comment 環境の開閉が原文と合いません。右の段の本文が comment として隠れている可能性があります（節の終わりでは原文の開閉に合わせました）: ${b.commentMismatch.slice(0, 10).join(", ")}`,
      );
    }
    if (b.titleUnplaced) {
      surface(
        "対訳: タイトルを左右のタイトルブロックに置き換えられませんでした（環境の中の \\maketitle など）。タイトル周りの体裁が崩れている可能性があります",
      );
    }
    let g = await gate(b.mainTex);
    if (!g.buildOk && layout === "original") {
      surface(`対訳: 原プリアンブルで組めず共通テンプレで組み直します: ${summarizeGateFailure(g)}`);
      g = await gate(assemble("template").mainTex);
    }
    if (!g.buildOk || g.pdfPath === undefined) return failed(summarizeGateFailure(g));
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(buildDir, finalDir);
    const pdfPath = path.join(finalDir, path.relative(buildDir, g.pdfPath));
    return { status: "ok", pdfPath, pairs, fallbackSegments };
  } catch (e) {
    if (signal?.aborted) {
      drop();
      throw e;
    }
    return failed(toRunError(e).message);
  }
}

// 入口の検証。web は文字列由来の値（Number(req.query.x)）をそのまま渡してくるので、
// 形が違うものは黙って既定へ倒さず input で拒否する（timeoutMs と同じ扱いに揃える）。
function entryError(input: JpaperInput, opts: TranslateOptions): string | undefined {
  if (!JpaperInputSchema.safeParse(input).success) {
    return "入力の指定が不正です（kind と path/id を確認してください）";
  }
  if (!ProviderSchema.safeParse(opts.provider).success) {
    return `provider が不正です: ${outwardMessage(String(opts.provider))}`;
  }
  if (opts.outDir !== undefined && (typeof opts.outDir !== "string" || opts.outDir.trim() === "")) {
    return `outDir が不正です: ${outwardMessage(String(opts.outDir))}`;
  }
  const c = opts.concurrency;
  if (c !== undefined && (typeof c !== "number" || !Number.isFinite(c) || c < 1)) {
    return `concurrency が不正です: ${outwardMessage(String(c))}`;
  }
  const o = opts.ollama;
  if (o !== undefined) {
    if (typeof o.model !== "string" || o.model.trim() === "") {
      return `ollama.model が不正です: ${outwardMessage(String(o?.model))}`;
    }
    const cw = o.contextWindow;
    if (
      typeof cw !== "number" ||
      !Number.isSafeInteger(cw) ||
      cw < MIN_CONTEXT_WINDOW ||
      cw > MAX_CONTEXT_WINDOW
    ) {
      return `ollama.contextWindow が不正です: ${outwardMessage(String(cw))}`;
    }
    const rt = o.requestTimeoutMs;
    if (rt !== undefined && (typeof rt !== "number" || !Number.isFinite(rt) || rt < 1)) {
      return `ollama.requestTimeoutMs が不正です: ${outwardMessage(String(rt))}`;
    }
  }
  if (opts.bilingual !== undefined && typeof opts.bilingual !== "boolean") {
    return `bilingual が不正です: ${outwardMessage(String(opts.bilingual))}`;
  }
  if (opts.verifyTerms !== undefined && typeof opts.verifyTerms !== "boolean") {
    return `verifyTerms が不正です: ${outwardMessage(String(opts.verifyTerms))}`;
  }
  if (opts.pageNotes !== undefined && typeof opts.pageNotes !== "boolean") {
    return `pageNotes が不正です: ${outwardMessage(String(opts.pageNotes))}`;
  }
  if (opts.endNotes !== undefined && typeof opts.endNotes !== "boolean") {
    return `endNotes が不正です: ${outwardMessage(String(opts.endNotes))}`;
  }
  if (opts.pages !== undefined && typeof opts.pages !== "string") {
    return `pages が不正です: ${outwardMessage(String(opts.pages))}`;
  }
  if (opts.allowLargePdf !== undefined && typeof opts.allowLargePdf !== "boolean") {
    return `allowLargePdf が不正です: ${outwardMessage(String(opts.allowLargePdf))}`;
  }
  // 語そのものは誤りの文に載せない。
  if (opts.redact !== undefined && (!Array.isArray(opts.redact) || opts.redact.some((t) => typeof t !== "string"))) {
    return "redact は文字列の配列で指定してください";
  }
  const r = opts.openrouter;
  if (r !== undefined) {
    if (typeof r.model !== "string" || r.model.trim() === "") {
      return `openrouter.model が不正です: ${outwardMessage(String(r?.model))}`;
    }
    const cw = r.contextWindow;
    if (
      typeof cw !== "number" ||
      !Number.isSafeInteger(cw) ||
      cw < MIN_CONTEXT_WINDOW ||
      cw > MAX_CONTEXT_WINDOW
    ) {
      return `openrouter.contextWindow が不正です: ${outwardMessage(String(cw))}`;
    }
    const rt = r.requestTimeoutMs;
    if (rt !== undefined && (typeof rt !== "number" || !Number.isFinite(rt) || rt < 1)) {
      return `openrouter.requestTimeoutMs が不正です: ${outwardMessage(String(rt))}`;
    }
  }
  for (const name of ["claude", "codex"] as const) {
    const cl = opts[name];
    if (cl === undefined) continue;
    if (typeof cl !== "object" || cl === null) {
      return `${name} が不正です: ${outwardMessage(String(cl))}`;
    }
    if (cl.model !== undefined && !isClaudeModelId(cl.model)) {
      return `${name}.model が不正です: ${outwardMessage(String(cl.model))}`;
    }
    const ef = cl.effort;
    if (ef !== undefined && (typeof ef !== "string" || !CLAUDE_EFFORT_PATTERN.test(ef))) {
      return `${name}.effort が不正です: ${outwardMessage(String(ef))}`;
    }
  }
  return undefined;
}

export async function translatePaper(
  input: JpaperInput,
  opts: TranslateOptions,
  deps: TranslateDeps = {},
): Promise<Result> {
  // 入口の検証。web ハンドラへ生の例外を漏らさない（契約付録 §8「例外は投げず戻り値で表現」）。
  const badInput = entryError(input, opts);
  if (badInput !== undefined) {
    // outDir 自体が不正な場合もあるので、サマリには文字列として安全な値だけ載せる。
    const shown = typeof opts.outDir === "string" ? opts.outDir : "";
    return failResult("unknown", shown, { kind: "input", code: 2, message: badInput }, idleBilingual(opts));
  }
  let paperId: string;
  let outDir: string;
  let runDir: string;
  let sharedDefaults: SharedDefault[];
  let redactor: Redactor | undefined;
  try {
    // 伏せ字の語の一覧の鍵付きの値を、取り込みの無効化キーに入れる（語そのものは入れない）。
    // 論文 ID（入力の名前から作る）は用語集作り・用語の検証のプロンプト・全体の用語 DB・実行の要約に載るので、
    // 語を含む名前は論文 ID を作る前に止める。契約付録 §8（伏せ字）
    redactor =
      opts.redact === undefined ? undefined : makeRedactor(checkRedactTerms(opts.redact), deps.cacheKey ?? loadCacheKey());
    if (redactor !== undefined && matches(path.basename(ingestPaperIdSource(input)), redactor)) {
      throw new JpaperError(2, "input", "入力のファイル名・ディレクトリ名に伏せ字の語が含まれます。名前を変えてから訳してください");
    }
    paperId = derivePaperId(input);
    outDir = paperOutDir(paperId, opts.outDir);
    runDir = path.join(outDir, ".run");
    sharedDefaults = sharedDefaultsOf(opts, deps);
  } catch (e) {
    return failResult(
      "unknown",
      typeof opts.outDir === "string" ? opts.outDir : "",
      toRunError(e),
      idleBilingual(opts),
    );
  }
  if (sharedDefaults.length > 0) {
    // ここはまだ notify を組み立てる前。通知の失敗で run を落とさない。
    try {
      deps.onError?.(
        `${SHARED_DEFAULT_NOTICE}: ${sharedDefaults.join(", ")}（マルチテナントでは dbPath / cacheKey / outDir / limits / work を明示的に渡すこと）`,
      );
    } catch {
      // 通知の失敗は run を壊さない。
    }
  }
  // 注入 client（テスト）はそのまま尊重し、内部生成時のみトレースを配線する。LLM トレース ADR。
  const runId = `${paperId}-${Date.now()}`;
  const trace = deps.trace ?? makeJsonlTrace(path.join(runDir, "llm-trace.jsonl"), runId);
  // 注入クライアントにもトレースを掛ける。web はテナント別資格情報のために必ず注入するので、
  // プロバイダ生成側にだけ配線すると課金の記録が構造的に消える。
  // claude・codex の未指定の model・effort は既定で埋める。契約付録 §5
  const cli = deps.client === undefined ? withCliDefaults(opts.provider, opts) : {};
  const client0 =
    deps.client === undefined
      ? makeLlmClient(opts.provider, {
          ollama: opts.ollama,
          openrouter: opts.openrouter,
          claude: cli.claude,
          codex: cli.codex,
          trace,
        })
      : withTrace(deps.client, trace, opts.provider);
  // 中断は境界 1 箇所（client ラッパ）で効かせる。各エージェントの引数は増やさない。
  // ゲートを外側に置くのは、枠を取ってから中断を見るため（待ち行列に中断済みが居座らない）。
  // 注入クライアントにも掛ける（web が自前クライアントを渡すとプロセス上限が消えていた）。
  const work = resolveWorkLimits(deps.work);
  let db: GlossaryDb | undefined;
  let lock: RunLock | undefined;
  let deadline: Deadline = { signal: opts.signal, dispose: () => undefined };
  let llmCalls: () => number = () => 0;
  // 失敗・中断でも「どこまで進んだか」を返す（0/0/0 だと課金と突き合わせられない）。
  let reached = { total: 0, passed: 0, failed: 0 };
  // 通知は副作用チャネル。web の SSE 切断などで投げても run の結果を変えない。
  // 併せて外向き検疫を通す（message だけ検疫しても onError から生の文字列が出ていた）。
  const notify = (m: string): void => {
    try {
      deps.onError?.(outwardMessage(m));
    } catch {
      // 通知の失敗は run を壊さない。
    }
  };
  if (cli.warning !== undefined) notify(cli.warning);
  const progress = (e: RunProgress): void => {
    try {
      deps.onProgress?.(e);
    } catch {
      // 同上。
    }
  };

  try {
    // 期限は呼び出し側の signal と合流させる。以降は signal（合流後）だけを見る。
    // 不正な timeoutMs はここで input エラーになるので、try の内側で組み立てる。
    deadline = withDeadline(opts.signal, opts.timeoutMs);
    const signal = deadline.signal;
    // 注入ゲートはプロセス上限を置き換えず、内側の第 2 段として重ねる。
    // 置き換えにすると、web がリクエスト単位でゲートを作った瞬間にプロセス上限が消える。
    const callBudget = createCallBudget(
      // 期限はゲートの内側（枠待ちは「モデルが返らない」ではない）。
      withProviderErrors(
        withSignal(withCallTimeout(client0, requestTimeoutMsFor(opts.provider, opts.ollama, opts.openrouter)), signal),
      ),
      work.maxLlmCalls,
    );
    llmCalls = callBudget.used;
    // プロセスゲートを内側に置く。外側で先に取ると、内側で待つ間もプロセス枠を占有して
    // 無関係なテナントを待たせる（実測: 実行中 1 本でプロセス枠を 2 消費）。
    const gated = withGate(callBudget.client, llmGate(), signal);
    // 同じゲートを二重に掛けると、外側で取った枠を内側で待って自己デッドロックする
    // （ゲートは非再入。実測: limit 1 のプロセスゲートを deps.gate に渡すと全 run が
    // 「LLM 同時実行の待機」で期限切れ。timeoutMs 未指定なら永久ハング）。⚠ landmines.md
    const client =
      deps.gate === undefined || deps.gate === llmGate()
        ? gated
        : withGate(gated, deps.gate, signal);
    // チェックポイントは runDir 単位なので、同一 outDir の並行実行は訳文を混ぜる。契約付録 §8。
    lock = acquireRunLock(runDir);
    if (deps.db) {
      db = deps.db;
    } else {
      // 空白のみの dbPath は「未指定」として扱う（sharedDefaults の判定と一致させる）。
      const given = deps.dbPath?.trim();
      const loc = given === undefined || given === "" ? dbPath() : given;
      mkdirSync(path.dirname(loc), { recursive: true });
      db = new GlossaryDb(loc);
    }

    // PDF は先にページを読んで main.tex を起こす。LLM を呼ぶ前に、画像を渡せないプロバイダを落とす。契約付録 §8（PDF 入力）
    const isPdf = input.kind === "path" && isPdfFile(input.path);
    if (!isPdf && opts.pages !== undefined) {
      throw new JpaperError(2, "input", "--pages は PDF の入力のときだけ指定できます");
    }
    let pdf: PdfExtracted | undefined;
    const signature = inputSignature(input);
    if (isPdf) {
      const canSee = deps.client === undefined ? IMAGE_PROVIDERS.includes(opts.provider) : deps.images === true;
      if (!canSee) {
        throw new JpaperError(2, "input", "PDF の読み取りは --provider claude|codex のときだけ使えます");
      }
      pdf = await extractPdf(
        input.path,
        { pages: opts.pages, allowLarge: opts.allowLargePdf },
        {
          client,
          runner: deps.latexRunner ?? defaultRunner,
          runDir,
          outDir: path.join(runDir, "pdf-source"),
          signature,
          concurrency: opts.concurrency ?? defaultConcurrencyFor(opts.provider),
          ...(redactor === undefined ? {} : { redact: redactor }),
          tools: deps.pdfTools,
          cacheKey: deps.cacheKey,
          signal,
          notify,
          onPage: (page, status, done, total) =>
            progress({ phase: "read", segmentId: `p${String(page)}`, done, total, passed: status === "ok" }),
        },
      );
    }
    const pdfMain = pdf === undefined ? "" : readFileSync(path.join(pdf.dir, "main.tex"), "utf8");
    const ingestStored = await checkpoint(
      runDir,
      "ingest",
      IngestCache,
      () =>
        ingest(input, path.join(runDir, "source"), {
          ...deps.ingest,
          limits: deps.limits ?? deps.ingest?.limits,
          arxiv: { ...deps.ingest?.arxiv, signal },
          ...(pdf === undefined ? {} : { pdfDir: pdf.dir }),
          ...(redactor === undefined ? {} : { redact: redactor }),
        }),
      {
        invalidation:
          redactor === undefined
            ? pdf === undefined
              ? signature
              : hashContext(signature, pdfMain)
            : hashContext(signature, pdfMain, "redact", redactor.fingerprint),
        key: deps.cacheKey,
      },
    );
    const ingested = ingestsIntoRunDir(input, redactor !== undefined)
      ? rebaseIngest(ingestStored, runDir)
      : ingestStored;

    // プリアンブルは翻訳対象ではなく verbatim に持ち越されるため、節ループの品質ゲートでは
    // 検査されない。LLM を呼ぶ前にここで弾く（悪意ある論文にコストを払わない）。組版安全 ADR。
    const unsafe = findUnsafeTexCommands(ingested.cleanLatex);
    // 同梱の .sty/.cls は \usepackage 経由で読み込まれ、cleanLatex には現れない。
    // 配布版に無い名前は shadow されずそのまま実行されるので、ここで別に検査する。
    const unsafeSupport = unsafeSupportFiles(ingested.sourceDir);
    if (unsafe.length > 0 || unsafeSupport.length > 0) {
      const detail = [
        ...unsafe.map((c) => `main.tex: \\${c}`),
        ...unsafeSupport.map((u) => `${u.file}: ${u.commands.map((c) => `\\${c}`).join(", ")}`),
      ];
      throw new JpaperError(
        2,
        "input",
        `論文が組版時にファイル読み書き・Lua 実行を行うコマンドを含んでいます: ${detail.join(" / ")}`,
      );
    }

    // 解決できない \input は黙って空文字列になる。本文が残っていても一部は欠けているので、
    // 成功として返す前に必ず観測可能にする（本文消失の直接の原因がこの沈黙だった）。
    if (ingested.unresolvedInputs > 0) {
      notify(
        `解決できない \\input / \\include が ${String(ingested.unresolvedInputs)} 件あります（本文の一部が欠けている可能性）`,
      );
    }

    progress({ phase: "ingest", done: 1, total: 1 });
    const budget = segmentBudgetFor(contextWindowFor(opts.provider, opts.ollama, opts.openrouter));
    const plan = planSegments(ingested.cleanLatex, budget);
    const segments: Segment[] = plan.segments;
    // LLM を 1 回も呼ぶ前に判定する（超過が確定した入力に課金しない。契約付録 §8）。
    // glossary は run 中で最大コンテキストの呼び出しなので、この順序が逆だと
    // 落ちると分かっている入力に一番高い 1 回を払うことになる。
    // 本文が 1 節も無い＝成果物が空。failed === 0 は results.length === 0 でも真なので、
    // ここで落とさないと「空の PDF が exit 0 の成功」として返り課金だけ残る（実測: 本文を
    // \input{sections/intro} だけで書いた論文の同梱漏れで segments 0 / llmCalls 1 / exit 0）。
    if (segments.length === 0) {
      throw new JpaperError(
        2,
        "input",
        ingested.unresolvedInputs > 0
          ? `翻訳対象の本文が空です（解決できない \\input / \\include が ${String(ingested.unresolvedInputs)} 件あります）`
          : "翻訳対象の本文が空です",
      );
    }
    if (segments.length > work.maxSegments) {
      throw new JpaperError(
        2,
        "too-large",
        `翻訳対象セグメント数 ${segments.length} が上限 ${work.maxSegments} を超えています`,
      );
    }
    // 用語バリア: 並列翻訳の前に resolved/brief/style を確定する。
    progress({ phase: "context", done: 0, total: 1 });
    const ctx = await loadOrBuildContext(
      runDir,
      outDir,
      client,
      db,
      ingested.paperId,
      ingested.cleanLatex,
      deps.cacheKey,
      (m) => notify(m),
      deps.writeBackGlossary !== false,
      opts.verifyTerms !== false &&
        (opts.provider === "claude" || opts.provider === "codex") &&
        (deps.client === undefined || deps.webSearch === true),
      input.kind !== "arxiv",
      redactor,
    );
    const firstOcc = segmentFirstOccurrence(segments, ctx.resolved);

    let doneSegments = 0;
    let donePassed = 0;
    let doneFailed = 0;
    progress({ phase: "context", done: 1, total: 1 });
    progress({ phase: "translate", done: 0, total: segments.length });
    const translateSegment = (seg: Segment): Promise<SectionLoopCache> => {
      // 契約付録 §1: 訳す地の文が無い節は LLM へ送らない。
      if (isMacroDefinitionsOnly(seg.latex)) {
        doneSegments++;
        donePassed++;
        reached = { total: segments.length, passed: donePassed, failed: doneFailed };
        progress({
          phase: "translate",
          segmentId: seg.id,
          done: doneSegments,
          total: segments.length,
          passed: true,
          usedRevisions: 0,
          maxRevisions: 0,
        });
        return Promise.resolve({
          segmentId: seg.id,
          ja: seg.latex,
          passed: true,
          failedKinds: [],
          usedRevisions: 0,
          maxRevisions: 0,
          warnIssues: [],
        });
      }
      const slice = segmentSlice(seg, ctx.resolved, firstOcc);
      // 失敗結果は永続しない。
      const invalidation = segmentInvalidation(seg, slice, ctx);
      const loop = (): Promise<SectionLoopCache> =>
        runSectionLoop(client, seg, slice, { brief: ctx.brief, style: ctx.style });
      const save = (v: SectionLoopCache): void => {
        if (v.passed) writeStep(runDir, seg.id, v, { invalidation, key: deps.cacheKey });
      };
      return checkpoint(runDir, seg.id, SectionLoopCache, loop, {
        invalidation,
        cacheable: (r) => r.passed,
        key: deps.cacheKey,
      })
        .then((r) =>
          recheckCached(r, seg, slice, () => loop().then((v) => (save(v), v)), save, () =>
            notify(`形式検査が変わったため、以前に通した ${seg.id} を訳し直します`),
          ),
        )
        .then((r) => {
          doneSegments++;
          if (r.passed) donePassed++;
          else doneFailed++;
          reached = { total: segments.length, passed: donePassed, failed: doneFailed };
          progress({
            phase: "translate",
            segmentId: seg.id,
            done: doneSegments,
            total: segments.length,
            passed: r.passed,
            failedKinds: r.failedKinds,
            usedRevisions: r.usedRevisions,
            maxRevisions: r.maxRevisions,
          });
          return r;
        });
    };

    // タイトルは前文（または本文で原文のまま残した \title）にあり、翻訳する節に含まれない。
    // 小さな 1 節として同じ節ループへ通し、失敗しても原題のまま組版する（run の成否・segments の
    // 集計に入れない）。本文の \title があればそちらが効くので前文は見ない。契約付録 §8
    const found = foundTitle(ingested.cleanLatex, plan);
    const title = found !== undefined && hasProse(found.text) ? found : undefined;
    if (found !== undefined && title === undefined) {
      notify(`タイトルが地の文を含まない（${found.text}）ため訳さず原題のまま組版します`);
    }
    let titleStatus: TitleStatus = title === undefined ? "absent" : "failed";
    let titleTex: string | undefined;
    // 成果物 PDF の名前に使う短い英語名（title 節の translator が訳題と一緒に出す）。契約付録 §8
    let titleSlug: string | undefined;
    // 落ちたタイトルの結果（最後の指摘の記録に足す）。
    let titleFailure: SectionLoopCache | undefined;
    const translateTitle = async (src: PaperTitle): Promise<void> => {
      const seg = titleSegment(src);
      const slice = titleSlice(seg, ctx.resolved);
      const invalidation = titleInvalidation(seg, slice, ctx);
      try {
        const r = await checkpoint(
          runDir,
          TITLE_SEGMENT_ID,
          SectionLoopCache,
          () => runSectionLoop(client, seg, slice, { brief: ctx.brief, style: ctx.style }),
          {
            invalidation,
            cacheable: (x) => x.passed && translatedTitle(x.ja) !== undefined,
            key: deps.cacheKey,
          },
        ).then((x) => {
          const save = (v: SectionLoopCache): void => {
            if (v.passed && translatedTitle(v.ja) !== undefined) {
              writeStep(runDir, TITLE_SEGMENT_ID, v, { invalidation, key: deps.cacheKey });
            }
          };
          const loop = (): Promise<SectionLoopCache> =>
            runSectionLoop(client, seg, slice, { brief: ctx.brief, style: ctx.style }).then((v) => (save(v), v));
          return recheckCached(x, seg, slice, loop, save, () =>
            notify("形式検査が変わったため、以前に通したタイトルを訳し直します"),
          );
        });
        const ja = r.passed ? translatedTitle(r.ja) : undefined;
        if (!r.passed) titleFailure = r;
        if (ja === undefined) {
          if (contaminatedSegments([r]).length > 0) {
            notify(`タイトルの訳文が危険コマンド・文書構造の破壊を持ち込みました（汚染の疑い）。原題のまま組版します${WHERE_ISSUES}`);
            return;
          }
          const why = r.passed
            ? "訳文に \\title が無い"
            : r.failCode === 4
              ? "品質基準に達しない"
              : `形式検査を通過しない: ${[...new Set(r.failedKinds)].sort().join(", ")}`;
          notify(`タイトルを訳せなかったため原題のまま組版します（${why}${WHERE_ISSUES}）`);
          return;
        }
        titleTex = composeTitle(ja, src);
        titleSlug = r.pdfName;
        titleStatus = "translated";
      } catch (e) {
        // ⚠ landmines.md
        if (signal?.aborted === true) throw e;
        notify(`タイトルの翻訳に失敗したため原題のまま組版します: ${toRunError(e).message}`);
      }
    };

    // タイトルも run 内の並列度の枠を使う（先頭に積む）。
    const results = new Array<SectionLoopCache>(segments.length);
    const jobs: (() => Promise<void>)[] = [
      ...(title === undefined ? [] : [() => translateTitle(title)]),
      ...segments.map((seg, i) => async () => {
        results[i] = await translateSegment(seg);
      }),
    ];
    await mapLimit(
      jobs,
      opts.concurrency ?? defaultConcurrencyFor(opts.provider),
      (job) => job(),
      signal,
    );

    // 見出し未訳の非ブロッキング lint。keep-original 確定語は除外して訳注へ流す（ビルドは壊さない）。
    const keepOriginal = ctx.resolved
      .filter((t) => t.rendering === "keep-original")
      .map((t) => t.src);
    const notes = buildNotes({
      resolved: ctx.resolved.map((r) => ({ ...r, firstOccurrence: false })) as ResolvedTerm[],
      firstOccurrenceBySrc: firstOcc,
      hasConfirmed: (src) => db!.confirmedFor(src).length > 0,
      unverified: new Set(ctx.unverified),
      segmentWarns: results.map((r) => ({
        segmentId: r.segmentId,
        warnIssues: r.warnIssues,
      })),
      segmentLints: results.map((r) => ({
        segmentId: r.segmentId,
        untranslatedHeadings: untranslatedHeadings(r.ja, keepOriginal),
      })),
    });

    clearForeignContext(outDir, ingested.paperId);
    const chaptersDir = path.join(outDir, "translation", "chapters");
    rmSync(chaptersDir, { recursive: true, force: true }); // 縮小時の古い chapter を残さない
    mkdirSync(chaptersDir, { recursive: true });
    // 落ちたセグメントの訳文は書き出さない。汚染で落ちた run でも成果物ディレクトリに
    // \write18{...} 入りの .tex が残り、利用者が手で組版すれば発火した。
    for (const r of results.filter((x) => x.passed)) {
      writeFileSync(path.join(chaptersDir, `${r.segmentId}.tex`), r.ja);
    }
    writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));
    try {
      writeFailedSegments(runDir, runId, [
        ...(titleFailure === undefined ? [] : [titleFailure]),
        ...results.filter((r) => !r.passed),
      ]);
    } catch (e) {
      notify(`落ちた節の指摘を書き出せませんでした: ${toRunError(e).message}`);
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    reached = { total: results.length, passed, failed };

    // 汚染は品質の失敗に埋もれさせない。exit code は他の失敗に持っていかれうるので、
    // 種別そのものを警告として必ず観測可能にする。
    const tainted = contaminatedSegments(results);
    if (tainted.length > 0) {
      notify(
        `訳文が危険コマンド・文書構造の破壊を持ち込みました（汚染の疑い）: ${tainted.slice(0, 10).join(", ")}`,
      );
    }

    // 全節通過時のみ組版する（翻訳失敗の 3/4 は組版前に確定）。
    let layout: Layout | null = null;
    let buildOk: boolean | null = null;
    let pdfPath: string | undefined;
    let typesetMessage: string | undefined;
    let bilingual: BilingualSummary = idleBilingual(opts);
    let exitCode = resolveExitCode(results.filter((r) => !r.passed).map((r) => r.failCode ?? 4));
    if (failed === 0) {
      // 訳注を本文へ反映（初出脚注は pageNotes が true のときだけ、巻末一覧は endNotes が false でなければ）してから組版する。
      const formBySrc = new Map(ctx.resolved.map((r) => [r.src, r.form]));
      const pageNotes = opts.pageNotes === true ? notes : [];
      const keptSource = segments.find((s) => s.keep !== undefined);
      const keptAt = keptSource?.keep && { latex: keptSource.latex, ...keptSource.keep };
      const rendered = results.map((r) => {
        const kept = keptAt && r.segmentId === keptSource!.id ? locateBodyTitle(r.ja, keptAt) : undefined;
        const skip: [number, number][] = kept === undefined ? [] : [[kept.start, kept.end]];
        return { id: r.segmentId, tex: injectFootnotes(r.ja, r.segmentId, pageNotes, formBySrc, skip) };
      });
      const backmatter = opts.endNotes === false ? "" : renderBackmatter(notes, formBySrc);
      if (backmatter) rendered.push({ id: "backmatter", tex: backmatter });
      // 訳したタイトルを入れた組版入力。本文の \title は原文のまま残した命令の本題を差し替える。契約付録 §8
      let titled: Titled | undefined;
      if (titleTex !== undefined && keptAt === undefined) titled = { segments: rendered, title: titleTex };
      if (titleTex !== undefined && keptAt !== undefined) {
        const i = rendered.findIndex((x) => x.id === keptSource!.id);
        const placed = i === -1 ? undefined : placeBodyTitle(rendered[i]!.tex, keptAt, titleTex);
        if (placed === undefined) {
          notify("本文の \\title を訳文の中に見つけられなかったため原題のまま組版します");
          titleStatus = "failed";
        } else {
          titled = { segments: rendered.map((x, j) => (j === i ? { ...x, tex: placed } : x)) };
        }
      }
      progress({ phase: "typeset", done: 0, total: 1 });
      const outcome = await typeset(
        ingested.cleanLatex,
        rendered,
        {
          outDir,
          sourceDir: ingested.sourceDir,
          mainDir: ingested.mainDir ?? ingested.sourceDir,
          figures: ingested.figures,
          titled,
        },
        deps.latexRunner,
        (m) => notify(m),
        signal,
      );
      ({ layout, buildOk, pdfPath, exitCode } = outcome);
      typesetMessage = outcome.message;
      if (titled !== undefined && !outcome.titleApplied && outcome.buildOk) titleStatus = "failed";
      // 成果物 PDF は出力先の直下に <ID>_<slug>-ja.pdf / -bilingual.pdf で置く。契約付録 §8（成果物 PDF の名前）
      const slug = (titleStatus as TitleStatus) === "translated" ? titleSlug : undefined;
      if (buildOk === true && pdfPath !== undefined) {
        pdfPath = publishDeliverable(outDir, pdfPath, deliverableName(ingested.paperId, slug, "ja"), "ja");
        dropDeliverables(outDir, "bilingual");
      }
      if (buildOk === true && layout !== null && opts.bilingual !== false) {
        // 和訳 PDF に訳題が入った run だけ、右側にも同じ訳題（前文の \title・本文の \title）を使う。
        const applied = outcome.titleApplied ? titled : undefined;
        bilingual = await typesetBilingual(
          ingested.cleanLatex,
          segments.map((s) => ({ id: s.id, tex: s.latex })),
          applied?.segments ?? rendered,
          layout,
          {
            outDir,
            sourceDir: ingested.sourceDir,
            mainDir: ingested.mainDir ?? ingested.sourceDir,
            figures: ingested.figures,
            title: applied?.title,
          },
          deps.latexRunner,
          (m) => notify(m),
          signal,
        );
      }
      if (bilingual.status === "ok" && bilingual.pdfPath !== undefined) {
        bilingual = {
          ...bilingual,
          pdfPath: publishDeliverable(
            outDir,
            bilingual.pdfPath,
            deliverableName(ingested.paperId, slug, "bilingual"),
            "bilingual",
          ),
        };
      }
      progress({ phase: "typeset", done: 1, total: 1 });
    }

    // 正本の確定は組版まで到達してから（契約付録 §2）。組版に失敗した run で
    // glossary.md / brief.md / style.md と .paper-id を確定すると、壊れた出力先が
    // 次の run の正本になる。LLM の成果は .run/steps の checkpoint に残るので、
    // 確定を見送っても再実行のコストは増えない。
    // 翻訳自体が失敗して組版へ進まなかった run（failed > 0）は、run としては最後まで
    // 到達しているので従来どおり確定する。
    if (buildOk !== false) {
      // 今回使わなかった step の checkpoint を掃除する（節が減った再実行の孤児が
      // 残ると、前の論文の訳文がそのまま出力先に居座る）。
      pruneSteps(
        runDir,
        new Set([
          "ingest",
          "glossary",
          VERIFY_STEP,
          VERIFY_RESULT_STEP,
          TITLE_SEGMENT_ID,
          ...segments.map((s) => s.id),
          ...(pdf?.stepIds ?? []),
        ]),
      );
      promoteContext(outDir, ingested.paperId, sourceDigestOf(ingested.cleanLatex), ctx.pending);
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
      terms:
        ctx.checks === undefined
          ? null
          : {
              checked: ctx.checks.filter(isTargetCheck).length,
              confirmed: ctx.checks.filter((c) => c.status === "confirmed").length,
              replaced: ctx.checks.filter((c) => c.status === "replaced" && isTargetCheck(c)).length,
              unverified: ctx.checks.filter((c) => c.status === "unverified").length,
            },
      notes: { total: notes.length, byTrigger: countByTrigger(notes) },
      layout,
      buildOk,
      bilingual,
      sharedDefaults,
      llmCalls: llmCalls(),
      title: titleStatus,
      pdf: pdf === undefined ? null : { pages: pdf.pages.length, fallbackPages: pdf.fallbackPages, figures: pdf.figures },
      redaction:
        redactor === undefined
          ? null
          : { terms: redactor.terms.length, replaced: ingested.redacted + (pdf?.redacted ?? 0) },
      exitCode,
    });
    if (exitCode === 0) return { status: "ok", exitCode, pdfPath, summary };
    return { status: "failed", exitCode, pdfPath, error: gateError(exitCode, results, typesetMessage), summary };
  } catch (e) {
    const error = toRunError(e);
    notify(error.message);
    return failResult(paperId, outDir, error, idleBilingual(opts), sharedDefaults, llmCalls(), reached);
  } finally {
    deadline.dispose();
    if (!deps.db) db?.close();
    lock?.release();
  }
}
