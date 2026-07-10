// 設計メモ §3・§6。\includegraphics から図パスを回収（実在するもののみ・決定的ソート）。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isInsideDir } from "./paths.js";

const FIG_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".gif", ".svg"];

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(abs);
    }
  }
  walk(root);
  return out.sort();
}

// 標準解決（main dir＋graphicspath）で見つからない参照を、source ルート内の basename 一致で回収。
function findByBasename(rootDir: string, ref: string): string | null {
  const wanted = path.basename(ref);
  const names = path.extname(wanted) ? [wanted] : FIG_EXTS.map((e) => wanted + e);
  const all = listAllFiles(rootDir);
  for (const name of names) {
    const hit = all.find((f) => path.basename(f) === name);
    if (hit) return hit;
  }
  return null;
}

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
    const ref = (m[1] ?? "").trim();
    const resolved =
      resolveFigure(baseDir, rootDir, bases, ref) ?? findByBasename(rootDir, ref);
    if (resolved) found.add(resolved);
  }
  return [...found].sort();
}
