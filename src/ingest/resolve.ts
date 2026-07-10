// 設計メモ §3・§6。\includegraphics から図パスを回収（実在するもののみ・決定的ソート）。
import { existsSync } from "node:fs";
import path from "node:path";
import { isInsideDir } from "./paths.js";

const FIG_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".gif", ".svg"];

function extractGraphicsPath(latex: string): string[] {
  const m = /\\graphicspath\{((?:\{[^}]*\})+)\}/.exec(latex);
  if (!m) return [];
  return [...(m[1] ?? "").matchAll(/\{([^}]*)\}/g)].map((g) => g[1] ?? "");
}

function resolveFigure(
  baseDir: string,
  rootDir: string,
  bases: string[],
  ref: string,
): string | null {
  const cands = path.extname(ref) ? [ref] : [ref, ...FIG_EXTS.map((e) => ref + e)];
  for (const base of bases) {
    for (const cand of cands) {
      const abs = path.resolve(baseDir, base, cand);
      if (existsSync(abs) && isInsideDir(rootDir, abs)) return abs;
    }
  }
  return null;
}

export function collectFigures(
  latex: string,
  baseDir: string,
  rootDir: string = baseDir,
): string[] {
  const bases = ["", ...extractGraphicsPath(latex)];
  const found = new Set<string>();
  const re = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latex)) !== null) {
    const resolved = resolveFigure(baseDir, rootDir, bases, (m[1] ?? "").trim());
    if (resolved) found.add(resolved);
  }
  return [...found].sort();
}
