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

export function classifyLog(log: string, sourceMap: SourceSpan[]): Classification {
  const failedSegments: FailedSegment[] = [];
  const structuralErrors: string[] = [];
  const missingFigures = new Set<string>();
  const unresolvedRefs = new Set<string>();

  for (let m = ERROR_LINE.exec(log); m; m = ERROR_LINE.exec(log)) {
    const file = m[1]!;
    const line = Number(m[2]);
    const message = m[3]!.trim();
    const id = path.basename(file) === "main.tex" ? segmentAtLine(sourceMap, line) : undefined;
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
  },
  runner: LatexRunner = defaultRunner,
): BuildGateResult {
  stageBuild(input.buildDir, input.mainTex, {
    sourceDir: input.sourceDir,
    mainDir: input.mainDir,
    figures: input.figures,
  });
  const { code, log } = runner(input.buildDir);
  const cls = classifyLog(log, input.sourceMap);
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
