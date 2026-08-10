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
  JpaperInput as JpaperInputSchema,
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
import { paperOutDir, dbPath, contextWindowFor, type OllamaConfig } from "../config.js";
import { makeLlmClient } from "../providers/index.js";
import { makeJsonlTrace, withTrace } from "../runtime/trace.js";
import { ingest, derivePaperId, type IngestDeps } from "../ingest/index.js";
import type { IngestLimits } from "../ingest/limits.js";
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
import { untranslatedHeadings } from "./quality-gate.js";
import { checkpoint, hashContext } from "../durable/checkpoint.js";
import { acquireRunLock, type RunLock } from "../durable/run-lock.js";
import {
  throwIfAborted,
  withSignal,
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
  runBuildGate,
  unsafeSupportFiles,
  type LatexRunner,
  type BuildGateResult,
} from "../tools/build-gate.js";
import { injectFootnotes, renderBackmatter } from "../tools/render-notes.js";
import { findUnsafeTexCommands } from "../tools/tex-safety.js";

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
  // 呼び出し側の中断。LLM 呼び出し・組版・arXiv 取得へ伝播し、exitCode 6 で返る。
  signal?: AbortSignal;
  // run 全体の期限（ms）。超過すると中断と同じ経路で exitCode 6 で返る。
  timeoutMs?: number;
}

// subprocess プロバイダは無制限並列に耐えないため翻訳の同時実行数を制限する。
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      // 中断後は新しいセグメントを取りに行かない（進行中の 1 本は provider 側で落ちる）。
      throwIfAborted(signal, "セグメント翻訳");
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    // limit が壊れていても 1 本は回す（0 本だと結果配列が穴だらけのまま返る）。
    Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, worker),
  );
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
}

export interface RunProgress {
  phase: "ingest" | "context" | "translate" | "typeset";
  segmentId?: string;
  done: number;
  total: number;
}

interface PaperContext {
  resolved: ResolvedRow[];
  brief: DocumentBrief;
  style: StyleContract;
  proposedAdded: number;
  // 正常完了時に outDir へ書き出す md（パス→中身）。中断時は書かれない。
  pending: Record<string, string>;
}

// 出力先がどの論文のものかを示す印。同じ outDir に別の論文が来たら既存 md を採用しない。
const PAPER_STAMP = ".paper-id";

function stampedPaperId(outDir: string): string | undefined {
  try {
    return readFileSync(path.join(outDir, PAPER_STAMP), "utf8").trim();
  } catch {
    return undefined;
  }
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
): Promise<PaperContext> {
  const built = await checkpoint(
    runDir,
    "glossary",
    GlossaryBuilderOut,
    () => buildPaperGlossary(client, db, paperId, cleanLatex),
    { invalidation: hashContext(cleanLatex), key: cacheKey },
  );
  const proposedAdded = writeBackResolved(db, built, paperId);
  const glossaryMd = path.join(outDir, "glossary.md");
  const briefMd = path.join(outDir, "brief.md");
  const styleMd = path.join(outDir, "style.md");

  // 印が無い出力先は旧版が作ったもの＝これまでどおり採用する（人間の編集を捨てない）。
  const stamped = stampedPaperId(outDir);
  const foreign = stamped !== undefined && stamped !== paperId;
  if (foreign) {
    warn?.(
      `出力先は別の論文（${stamped}）のものなので既存の glossary.md / brief.md / style.md は使いません`,
    );
  }
  const adopt = (file: string): boolean => !foreign && existsSync(file);

  const pending: PaperContext["pending"] = {};
  let resolved: ResolvedRow[] = built.resolved;
  if (adopt(glossaryMd)) {
    // 既存 md が正本（空にする編集も尊重する）。
    resolved = parseGlossaryMd(readFileSync(glossaryMd, "utf8"));
  } else {
    pending[glossaryMd] = renderGlossaryMd(built.resolved);
  }

  let brief = built.brief;
  if (adopt(briefMd)) brief = parseBriefMd(readFileSync(briefMd, "utf8"));
  else pending[briefMd] = renderBriefMd(built.brief);

  let style = built.style;
  if (adopt(styleMd)) style = parseStyleMd(readFileSync(styleMd, "utf8"));
  else pending[styleMd] = renderStyleMd(built.style);

  return { resolved, brief, style, proposedAdded, pending };
}

// run が最後まで到達したときだけ md を確定する。
function promoteContext(outDir: string, paperId: string, pending: PaperContext["pending"]): void {
  mkdirSync(outDir, { recursive: true });
  for (const [file, body] of Object.entries(pending)) writeFileSync(file, body);
  writeFileSync(path.join(outDir, PAPER_STAMP), paperId);
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

// 単一ユーザ既定にフォールバックした資源を数える。マルチテナントで気づかず共有したまま
// 本番に出るのを防ぐため、observable にして警告も出す（契約付録 §8）。
type SharedDefault = "db" | "cacheKey" | "outDir";
function sharedDefaultsOf(opts: TranslateOptions, deps: TranslateDeps): SharedDefault[] {
  const shared: SharedDefault[] = [];
  if (deps.db === undefined && (deps.dbPath === undefined || deps.dbPath.trim() === "")) {
    shared.push("db");
  }
  if (deps.cacheKey === undefined) shared.push("cacheKey");
  if (opts.outDir === undefined || opts.outDir.trim() === "") shared.push("outDir");
  return shared;
}

function failResult(
  paperId: string,
  outDir: string,
  error: RunError,
  sharedDefaults: SharedDefault[] = [],
  llmCalls = 0,
): Result {
  const exitCode = error.code;
  return {
    status: "failed",
    exitCode,
    error,
    summary: RunSummary.parse({
      paperId,
      outDir,
      segments: { total: 0, passed: 0, failed: 0 },
      revisions: { max: 0, used: 0 },
      glossary: { proposedAdded: 0 },
      notes: { total: 0, byTrigger: {} },
      layout: null,
      buildOk: null,
      sharedDefaults,
      llmCalls,
      exitCode,
    }),
  };
}

interface TypesetOutcome {
  layout: Layout | null;
  buildOk: boolean | null;
  pdfPath?: string;
  exitCode: number;
  message?: string;
}

// 節ループ・組版ゲートの失敗は例外ではなく戻り値で来るので、ここで構造化エラーに写す。
function gateError(
  exitCode: number,
  results: readonly { segmentId: string; passed: boolean; failCode?: number }[],
  typesetMessage?: string,
): RunError {
  const bad = results.filter((r) => !r.passed);
  const ids = bad.map((r) => r.segmentId).slice(0, 10).join(", ");
  if (exitCode === 3) {
    return { kind: "formal", code: 3, message: `形式検査を通過しないセグメントがあります: ${ids}` };
  }
  if (exitCode === 4) {
    return { kind: "quality", code: 4, message: `品質基準に達しないセグメントがあります: ${ids}` };
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

// ログ由来の断片は長さを切る（1 行 4000 文字のログで message が上限を無視して膨らむ）。
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function summarizeGateFailure(g: BuildGateResult): string {
  const parts: string[] = [];
  if (g.failedSegments.length)
    parts.push(`翻訳起因: ${g.failedSegments.map((f) => `${f.id}(${f.line})`).join(", ")}`);
  if (g.structuralErrors.length) parts.push(`構造: ${g.structuralErrors.slice(0, 3).map((e) => clip(e)).join(" / ")}`);
  if (g.missingFigures.length) parts.push(`欠図: ${g.missingFigures.map((f) => clip(f, 60)).join(", ")}`);
  if (g.droppedFigures.length) parts.push(`図欠落: ${g.droppedFigures.map((f) => clip(f, 60)).join(", ")}`);
  if (g.unresolvedRefs.length) parts.push(`未解決参照: ${g.unresolvedRefs.slice(0, 5).map((r) => clip(r, 60)).join(", ")}`);
  if (g.shadowedPackages.length)
    parts.push(`同梱パッケージを無効化: ${g.shadowedPackages.join(", ")}`);
  return parts.join(" | ") || "不明なビルド失敗";
}

// 全文組版ゲート: 原プリアンブル温存を試し、構造起因失敗のみ共通テンプレへ明示的にフォールバック（surface）。
async function typeset(
  cleanLatex: string,
  segments: { id: string; tex: string }[],
  opts: { outDir: string; sourceDir: string; mainDir: string; figures: string[] },
  runner: LatexRunner | undefined,
  surface: (m: string) => void,
  signal?: AbortSignal,
): Promise<TypesetOutcome> {
  const buildDir = path.join(opts.outDir, "translation", "build");
  const run = (mode: Layout): Promise<BuildGateResult> => {
    const { mainTex, sourceMap } = assembleWithMap({ cleanLatex, segments, mode });
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
  // 成否に関わらず、無効化した同梱パッケージは体裁差の原因になるので surface する。
  const noteShadowed = (g: BuildGateResult): void => {
    if (g.shadowedPackages.length)
      surface(`配布版を優先し同梱パッケージを無効化: ${g.shadowedPackages.join(", ")}`);
  };
  // pdfPath は buildOk のときだけ返す（ゲート棄却済みの成果物を成功として渡さない）。
  const orig = await run("original");
  noteShadowed(orig);
  if (orig.buildOk) return { layout: "original", buildOk: true, pdfPath: orig.pdfPath, exitCode: 0 };
  if (orig.failedSegments.length > 0) {
    // 翻訳起因のビルド失敗。再訳ループ(WP10)未実装のため明示的失敗として surface する。
    const m = `組版失敗(翻訳起因・要再訳): ${summarizeGateFailure(orig)}`;
    surface(m);
    return { layout: "original", buildOk: false, exitCode: 5, message: m };
  }
  surface(`原プリアンブルで組めず共通テンプレへフォールバック: ${summarizeGateFailure(orig)}`);
  const tmpl = await run("template");
  if (tmpl.buildOk) return { layout: "template", buildOk: true, pdfPath: tmpl.pdfPath, exitCode: 0 };
  const m = `組版失敗(テンプレでも不可): ${summarizeGateFailure(tmpl)}`;
  surface(m);
  return { layout: "template", buildOk: false, exitCode: 5, message: m };
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
  const c = opts.concurrency;
  if (c !== undefined && (typeof c !== "number" || !Number.isFinite(c) || c < 1)) {
    return `concurrency が不正です: ${outwardMessage(String(c))}`;
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
    return failResult("unknown", opts.outDir ?? "", { kind: "input", code: 2, message: badInput });
  }
  let paperId: string;
  let outDir: string;
  let runDir: string;
  let sharedDefaults: SharedDefault[];
  try {
    paperId = derivePaperId(input);
    outDir = paperOutDir(paperId, opts.outDir);
    runDir = path.join(outDir, ".run");
    sharedDefaults = sharedDefaultsOf(opts, deps);
  } catch (e) {
    return failResult("unknown", opts.outDir ?? "", toRunError(e));
  }
  if (sharedDefaults.length > 0) {
    deps.onError?.(
      `単一ユーザ既定を使用: ${sharedDefaults.join(", ")}（マルチテナントでは dbPath / cacheKey / outDir を明示的に渡すこと）`,
    );
  }
  // 注入 client（テスト）はそのまま尊重し、内部生成時のみトレースを配線する。LLM トレース ADR。
  const runId = `${paperId}-${Date.now()}`;
  const trace = deps.trace ?? makeJsonlTrace(path.join(runDir, "llm-trace.jsonl"), runId);
  // 注入クライアントにもトレースを掛ける。web はテナント別資格情報のために必ず注入するので、
  // プロバイダ生成側にだけ配線すると課金の記録が構造的に消える。
  const client0 =
    deps.client === undefined
      ? makeLlmClient(opts.provider, { ollama: opts.ollama, trace })
      : withTrace(deps.client, trace, opts.provider);
  // 中断は境界 1 箇所（client ラッパ）で効かせる。各エージェントの引数は増やさない。
  // ゲートを外側に置くのは、枠を取ってから中断を見るため（待ち行列に中断済みが居座らない）。
  // 注入クライアントにも掛ける（web が自前クライアントを渡すとプロセス上限が消えていた）。
  const work = resolveWorkLimits(deps.work);
  let db: GlossaryDb | undefined;
  let lock: RunLock | undefined;
  let deadline: Deadline = { signal: opts.signal, dispose: () => undefined };
  let llmCalls: () => number = () => 0;

  try {
    // 期限は呼び出し側の signal と合流させる。以降は signal（合流後）だけを見る。
    // 不正な timeoutMs はここで input エラーになるので、try の内側で組み立てる。
    deadline = withDeadline(opts.signal, opts.timeoutMs);
    const signal = deadline.signal;
    // 注入ゲートはプロセス上限を置き換えず、内側の第 2 段として重ねる。
    // 置き換えにすると、web がリクエスト単位でゲートを作った瞬間にプロセス上限が消える。
    const callBudget = createCallBudget(
      withProviderErrors(withSignal(client0, signal)),
      work.maxLlmCalls,
    );
    llmCalls = callBudget.used;
    // プロセスゲートを内側に置く。外側で先に取ると、内側で待つ間もプロセス枠を占有して
    // 無関係なテナントを待たせる（実測: 実行中 1 本でプロセス枠を 2 消費）。
    const gated = withGate(callBudget.client, llmGate(), signal);
    const client = deps.gate === undefined ? gated : withGate(gated, deps.gate, signal);
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

    const ingested = await checkpoint(
      runDir,
      "ingest",
      IngestCache,
      () =>
        ingest(input, path.join(runDir, "source"), {
          ...deps.ingest,
          limits: deps.limits ?? deps.ingest?.limits,
          arxiv: { ...deps.ingest?.arxiv, signal },
        }),
      { invalidation: inputSignature(input), key: deps.cacheKey },
    );

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

    // 用語バリア: 並列翻訳の前に resolved/brief/style を確定する。
    deps.onProgress?.({ phase: "context", done: 0, total: 1 });
    const ctx = await loadOrBuildContext(
      runDir,
      outDir,
      client,
      db,
      ingested.paperId,
      ingested.cleanLatex,
      deps.cacheKey,
      (m) => deps.onError?.(m),
    );
    const budget = segmentBudgetFor(contextWindowFor(opts.provider, opts.ollama));
    const segments = segment(ingested.cleanLatex, budget);
    // 節ループを 1 本も回す前に判定する（超過が確定した入力にコストを払わない）。
    if (segments.length > work.maxSegments) {
      throw new JpaperError(
        2,
        "too-large",
        `翻訳対象セグメント数 ${segments.length} が上限 ${work.maxSegments} を超えています`,
      );
    }
    const firstOcc = buildFirstOccurrenceIndex(
      segments,
      ctx.resolved.map((r) => r.src),
    );

    let doneSegments = 0;
    deps.onProgress?.({ phase: "translate", done: 0, total: segments.length });
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
        { invalidation, cacheable: (r) => r.passed, key: deps.cacheKey },
      ).then((r) => {
        doneSegments++;
        deps.onProgress?.({
          phase: "translate",
          segmentId: seg.id,
          done: doneSegments,
          total: segments.length,
        });
        return r;
      });
    }, signal);

    // 見出し未訳の非ブロッキング lint。keep-original 確定語は除外して訳注へ流す（ビルドは壊さない）。
    const keepOriginal = ctx.resolved
      .filter((t) => t.rendering === "keep-original")
      .map((t) => t.src);
    const notes = buildNotes({
      resolved: ctx.resolved.map((r) => ({ ...r, firstOccurrence: false })) as ResolvedTerm[],
      firstOccurrenceBySrc: firstOcc,
      hasConfirmed: (src) => db!.confirmedFor(src).length > 0,
      segmentWarns: results.map((r) => ({
        segmentId: r.segmentId,
        warnIssues: r.warnIssues,
      })),
      segmentLints: results.map((r) => ({
        segmentId: r.segmentId,
        untranslatedHeadings: untranslatedHeadings(r.ja, keepOriginal),
      })),
    });

    // ここまで来た run だけが outDir の正本を更新する。
    promoteContext(outDir, ingested.paperId, ctx.pending);

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
    let typesetMessage: string | undefined;
    let exitCode = resolveExitCode(results.filter((r) => !r.passed).map((r) => r.failCode ?? 4));
    if (failed === 0) {
      // 訳注を本文へ反映（初出脚注＋巻末一覧）してから組版する。
      const formBySrc = new Map(ctx.resolved.map((r) => [r.src, r.form]));
      const rendered = results.map((r) => ({
        id: r.segmentId,
        tex: injectFootnotes(r.ja, r.segmentId, notes, formBySrc),
      }));
      const backmatter = renderBackmatter(notes, formBySrc);
      if (backmatter) rendered.push({ id: "backmatter", tex: backmatter });
      const outcome = await typeset(
        ingested.cleanLatex,
        rendered,
        {
          outDir,
          sourceDir: ingested.sourceDir,
          mainDir: ingested.mainDir ?? ingested.sourceDir,
          figures: ingested.figures,
        },
        deps.latexRunner,
        (m) => deps.onError?.(m),
        signal,
      );
      ({ layout, buildOk, pdfPath, exitCode } = outcome);
      typesetMessage = outcome.message;
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
      sharedDefaults,
      llmCalls: llmCalls(),
      exitCode,
    });
    if (exitCode === 0) return { status: "ok", exitCode, pdfPath, summary };
    return { status: "failed", exitCode, pdfPath, error: gateError(exitCode, results, typesetMessage), summary };
  } catch (e) {
    const error = toRunError(e);
    deps.onError?.(error.message);
    return failResult(paperId, outDir, error, sharedDefaults, llmCalls());
  } finally {
    deadline.dispose();
    if (!deps.db) db?.close();
    lock?.release();
  }
}
