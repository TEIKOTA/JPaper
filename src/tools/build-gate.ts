// 契約付録 §6(exit5)・§7／2層化 ADR(20260709) 決定1・4。全文組版ゲート（ビルド＋エラー分類＋逆引き）。
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readdirSync, readFileSync } from "node:fs";
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
}

export interface RunResult {
  code: number;
  log: string;
}
export type LatexRunner = (buildDir: string) => RunResult;

const ERROR_LINE = /(?:^|\s)(?:\.\/)?main\.tex:(\d+):\s*(.+)$/gm;
const MISSING_FIG = /(?:File `([^']+)' not found|Unable to load picture or PDF file `([^']+)')/g;
const UNRESOLVED = /(?:Reference|Citation) `([^']+)' (?:on page \d+ )?undefined/g;

export function classifyLog(log: string, sourceMap: SourceSpan[]): Classification {
  const failedSegments: FailedSegment[] = [];
  const structuralErrors: string[] = [];
  const missingFigures = new Set<string>();
  const unresolvedRefs = new Set<string>();

  for (let m = ERROR_LINE.exec(log); m; m = ERROR_LINE.exec(log)) {
    const line = Number(m[1]);
    const message = m[2]!.trim();
    const id = segmentAtLine(sourceMap, line);
    if (id) failedSegments.push({ id, line, message });
    else structuralErrors.push(`main.tex:${line}: ${message}`);
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

// build dir に main.tex＋支援ファイル（.sty/.cls/.bst）＋図（相対パス保持）を配置する。
export function stageBuild(
  buildDir: string,
  mainTex: string,
  sourceDir: string,
  figures: string[],
): void {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "main.tex"), mainTex);
  for (const f of readdirSync(sourceDir)) {
    if (/\.(sty|cls|bst)$/i.test(f)) cpSync(path.join(sourceDir, f), path.join(buildDir, f));
  }
  for (const fig of figures) {
    const abs = path.isAbsolute(fig) ? fig : path.join(sourceDir, fig);
    if (!existsSync(abs)) continue;
    const rel = path.relative(sourceDir, abs);
    if (rel.startsWith("..")) continue;
    const dest = path.join(buildDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(abs, dest);
  }
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

function readLog(buildDir: string): string {
  for (const p of [path.join(buildDir, "main.log"), path.join(buildDir, "out", "main.log")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

export function runBuildGate(
  input: { buildDir: string; mainTex: string; sourceDir: string; figures: string[]; sourceMap: SourceSpan[] },
  runner: LatexRunner = defaultRunner,
): BuildGateResult {
  stageBuild(input.buildDir, input.mainTex, input.sourceDir, input.figures);
  const { code, log } = runner(input.buildDir);
  const cls = classifyLog(log, input.sourceMap);
  const pdf = path.join(input.buildDir, "main.pdf");
  const pdfPath = existsSync(pdf) ? pdf : undefined;
  const buildOk =
    code === 0 &&
    cls.failedSegments.length === 0 &&
    cls.structuralErrors.length === 0 &&
    cls.unresolvedRefs.length === 0 &&
    cls.missingFigures.length === 0;
  return { buildOk, pdfPath, ...cls };
}
