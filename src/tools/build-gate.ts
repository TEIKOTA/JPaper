// 契約付録 §6(exit5)・§7／2層化 ADR(20260709) 決定1・4。全文組版ゲート（ビルド＋エラー分類＋逆引き）。
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { segmentAtLine, type SourceSpan } from "./assemble-latex.js";

export interface FailedSegment {
  id: string;
  line: number;
  message: string;
}
export interface Classification {
  failedSegments: FailedSegment[];
  structuralErrors: string[];
  unresolvedRefs: string[];
  missingFigures: string[];
}
export interface BuildGateResult extends Classification {
  buildOk: boolean;
  pdfPath?: string;
  droppedFigures: string[];
}

export interface RunResult {
  code: number;
  log: string;
}
export type LatexRunner = (buildDir: string) => RunResult;

export interface StageInput {
  sourceDir: string;
  mainDir: string;
  figures: string[];
}

const ERROR_LINE = /(?:^|\s)(?:\.\/)?([A-Za-z0-9._/-]+\.(?:tex|cls|sty|bst|bib|def|ltx)):(\d+):\s*(.+)$/gm;
const MISSING_FIG = /(?:File `([^']+)' not found|Unable to load picture or PDF file `([^']+)')/g;
const UNRESOLVED = /(?:Reference|Citation) `([^']+)' (?:on page \d+ )?undefined/g;
const SUPPORT_EXT = /\.(sty|cls|bst|bib|bbl)$/i;

const FATAL_TRAILER = /^==> Fatal error occurred/;
const UNDEFINED_ENV = /LaTeX Error: Environment ([A-Za-z@*]+) undefined/;
const UNDEFINED_CS = /^Undefined control sequence/;
// エラー直後の `l.<行> <文脈>` 行の末尾に、未定義だった制御綴りが出る。
const CONTEXT_LINE = /^l\.\d+ .*?\\([a-zA-Z@]+)\s*$/m;

// 未定義エラーの原因となった名前（環境名・制御綴り）。取れなければ undefined。
function offendingName(message: string, rest: string): string | undefined {
  const env = UNDEFINED_ENV.exec(message);
  if (env) return env[1];
  if (!UNDEFINED_CS.test(message)) return undefined;
  return CONTEXT_LINE.exec(rest.slice(0, 400))?.[1];
}

// 原文にも同名があるなら translator は関与していない＝構造・テンプレ起因（2層化 ADR 決定4）。
function comesFromSource(name: string, originalTex: string): boolean {
  return (
    originalTex.includes(`\\begin{${name}}`) ||
    new RegExp(`\\\\${name}(?![a-zA-Z])`).test(originalTex)
  );
}

export function classifyLog(
  log: string,
  sourceMap: SourceSpan[],
  originalTex = "",
): Classification {
  const failedSegments: FailedSegment[] = [];
  const structuralErrors: string[] = [];
  const missingFigures = new Set<string>();
  const unresolvedRefs = new Set<string>();
  let lastWasStructural = false;

  for (let m = ERROR_LINE.exec(log); m; m = ERROR_LINE.exec(log)) {
    const file = m[1]!;
    const line = Number(m[2]);
    const message = m[3]!.trim();
    const inSegment = path.basename(file) === "main.tex" ? segmentAtLine(sourceMap, line) : undefined;
    const name = offendingName(message, log.slice(m.index + m[0].length));
    // 直前の診断の追随行。独立したエラーではないので分類を引き継ぐ。
    const structural: boolean = FATAL_TRAILER.test(message)
      ? lastWasStructural
      : name !== undefined && comesFromSource(name, originalTex);
    lastWasStructural = structural || inSegment === undefined;
    const id = structural ? undefined : inSegment;
    if (id) failedSegments.push({ id, line, message });
    else structuralErrors.push(`${file}:${line}: ${message}`);
  }
  for (let m = MISSING_FIG.exec(log); m; m = MISSING_FIG.exec(log)) {
    missingFigures.add((m[1] ?? m[2])!);
  }
  for (let m = UNRESOLVED.exec(log); m; m = UNRESOLVED.exec(log)) {
    unresolvedRefs.add(m[1]!);
  }
  return {
    failedSegments,
    structuralErrors,
    unresolvedRefs: [...unresolvedRefs],
    missingFigures: [...missingFigures],
  };
}

// manifest の各図が assemble 済み本文に \includegraphics として残っているか検証（訳が図を落とすと警告は出ない）。
export function checkFigures(mainTex: string, mainDir: string, figures: string[]): string[] {
  const dropped: string[] = [];
  for (const fig of figures) {
    const abs = path.isAbsolute(fig) ? fig : path.join(mainDir, fig);
    const rel = path.relative(mainDir, abs);
    const stem = rel.replace(/\.[^./]+$/, "");
    if (!mainTex.includes(stem) && !mainTex.includes(path.basename(stem))) dropped.push(rel);
  }
  return dropped;
}

function collectSupportFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collectSupportFiles(p, acc);
    else if (SUPPORT_EXT.test(name)) acc.push(p);
  }
  return acc;
}

// build dir に main.tex＋支援ファイル(.sty/.cls/.bst/.bib/.bbl は基底名でフラット)＋図(main 相対で配置)を置く。
export function stageBuild(buildDir: string, mainTex: string, opts: StageInput): void {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "main.tex"), mainTex);
  for (const sty of collectSupportFiles(opts.sourceDir)) {
    cpSync(sty, path.join(buildDir, path.basename(sty)));
  }
  for (const fig of opts.figures) {
    const abs = path.isAbsolute(fig) ? fig : path.join(opts.mainDir, fig);
    if (!existsSync(abs)) continue;
    const rel = path.relative(opts.mainDir, abs);
    if (rel.startsWith("..")) continue;
    const dest = path.join(buildDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(abs, dest);
  }
}

function readLog(buildDir: string): string {
  for (const p of [path.join(buildDir, "main.log"), path.join(buildDir, "out", "main.log")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

const defaultRunner: LatexRunner = (buildDir) => {
  try {
    execFileSync(
      "latexmk",
      ["-lualatex", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"],
      { cwd: buildDir, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, log: readLog(buildDir) };
  } catch (e) {
    return { code: (e as { status?: number }).status ?? 1, log: readLog(buildDir) };
  }
};

export function runBuildGate(
  input: {
    buildDir: string;
    mainTex: string;
    sourceDir: string;
    mainDir: string;
    figures: string[];
    sourceMap: SourceSpan[];
    originalTex?: string;
  },
  runner: LatexRunner = defaultRunner,
): BuildGateResult {
  stageBuild(input.buildDir, input.mainTex, {
    sourceDir: input.sourceDir,
    mainDir: input.mainDir,
    figures: input.figures,
  });
  const { code, log } = runner(input.buildDir);
  const cls = classifyLog(log, input.sourceMap, input.originalTex);
  const droppedFigures = checkFigures(input.mainTex, input.mainDir, input.figures);
  const pdf = path.join(input.buildDir, "main.pdf");
  const pdfPath = existsSync(pdf) ? pdf : undefined;
  const buildOk =
    code === 0 &&
    cls.failedSegments.length === 0 &&
    cls.structuralErrors.length === 0 &&
    cls.unresolvedRefs.length === 0 &&
    cls.missingFigures.length === 0 &&
    droppedFigures.length === 0;
  return { buildOk, pdfPath, droppedFigures, ...cls };
}
