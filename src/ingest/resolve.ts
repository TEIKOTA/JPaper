// 設計メモ §3・§6。\includegraphics から図パスを回収（実在するもののみ・決定的ソート）。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";
import { isInsideDirReal } from "./paths.js";

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

// basename → 実パス。参照ごとにツリーを再走査すると O(参照数 × ファイル数) になり、
// 100KB の入力で 3 秒イベントループが止まる（ingest には await が無いので期限も中断も効かない）。
function buildNameIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const abs of listAllFiles(root)) {
    const name = path.basename(abs);
    const hits = index.get(name);
    if (hits) hits.push(abs);
    else index.set(name, [abs]);
  }
  return index;
}

// 標準解決（main dir＋graphicspath）で見つからない参照を、source ルート内の basename 一致で回収。
function findByBasename(rootDir: string, ref: string, index: Map<string, string[]>): string | null {
  const wanted = path.basename(ref);
  const names = path.extname(wanted) ? [wanted] : FIG_EXTS.map((e) => wanted + e);
  for (const name of names) {
    const hits = index.get(name) ?? [];
    if (hits.length === 1) return isInsideDirReal(rootDir, hits[0]!) ? hits[0]! : null;
    if (hits.length > 1) return null; // 曖昧: 誤選択を避けて取りこぼす
  }
  return null;
}

// \graphicspath のディレクトリ数の上限。実在の論文は数個。
const MAX_GRAPHICS_PATHS = 64;
// 図の解決で叩く existsSync の総回数。参照件数だけを縛っても、1 参照あたりのコストが
// bases に比例するので抑えられない（実測: 4,000 dirs × 1,000 refs の 39KiB で 36,769ms、
// 10ms タイマーの発火は 0）。
const MAX_FIGURE_LOOKUPS = 200_000;

// 重複を落とし、実在するディレクトリだけに絞る。同じ綴りを並べるだけの入力を畳み、
// 存在しないディレクトリへの探索（1 参照あたり拡張子ぶん）を最初に消す。
function usableBases(
  baseDir: string,
  bases: string[],
  budget: { lookups: number },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    if (base === "") {
      out.push("");
      continue;
    }
    // ここも予算に計上する。ディレクトリ数は 64 で抑えたが、宣言そのものは
    // maxLatexBytes まで並べられるので、計上しないと 8MiB の入力で existsSync が
    // 92 万回走る（実測 1,081ms、10ms タイマーの発火 0）。
    if (--budget.lookups < 0) {
      throw new JpaperError(
        2,
        "too-large",
        `図の解決が上限 ${MAX_FIGURE_LOOKUPS} 回を超えています`,
      );
    }
    if (existsSync(path.resolve(baseDir, base))) out.push(base);
  }
  if (out.length > MAX_GRAPHICS_PATHS) {
    throw new JpaperError(
      2,
      "too-large",
      `\\graphicspath のディレクトリが上限 ${MAX_GRAPHICS_PATHS} 件を超えています`,
    );
  }
  return out;
}

function resolveFigure(
  baseDir: string,
  rootDir: string,
  bases: string[],
  ref: string,
  budget: { lookups: number },
): string | null {
  const cands = path.extname(ref) ? [ref] : [ref, ...FIG_EXTS.map((e) => ref + e)];
  for (const base of bases) {
    for (const cand of cands) {
      if (--budget.lookups < 0) {
        throw new JpaperError(
          2,
          "too-large",
          `図の解決が上限 ${MAX_FIGURE_LOOKUPS} 回を超えています`,
        );
      }
      const abs = path.resolve(baseDir, base, cand);
      if (existsSync(abs) && isInsideDirReal(rootDir, abs)) return abs;
    }
  }
  return null;
}

// 図参照の件数上限。索引化しても 1 参照あたり existsSync が拡張子ぶん（9 回）走るので、
// 参照数そのものを縛らないと上限いっぱいの入力で数秒イベントループが止まる。実在の論文の
// 図は多くても数百件。
export function collectFigures(
  latex: string,
  baseDir: string,
  rootDir: string = baseDir,
  maxRefs = 5_000,
): string[] {
  let bases = [""]; // \graphicspath 宣言を参照順に追う（後宣言で置換）
  // bases が変わるのは \graphicspath に当たったときだけ。世代番号で表せば memo キーは
  // O(1) で作れる。参照ごとに bases 全体を直列化していた頃は、base 1 本の長さに上限が
  // 無いため二次になった（実測 8MiB で 94,071ms、中断もタイマーも配送されない）。
  let basesGen = 0;
  const budget = { lookups: MAX_FIGURE_LOOKUPS };
  const found = new Set<string>();
  const re =
    /\\graphicspath\s*\{((?:\{[^}]*\})+)\}|\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  // 索引は最初に basename 回収へ落ちたときだけ作る（図が全て素直に解決する論文では作らない）。
  let index: Map<string, string[]> | null = null;
  // 同じ (base 列, 参照) の解決結果を使い回す。同一参照を並べるだけで existsSync が
  // 参照数ぶん走るのを止める。base 列は世代番号で代表する。
  const memo = new Map<string, string | null>();
  while ((m = re.exec(latex)) !== null) {
    if (m[1] !== undefined) {
      bases = usableBases(
        baseDir,
        ["", ...[...m[1].matchAll(/\{([^}]*)\}/g)].map((g) => g[1] ?? "")],
        budget,
      );
      basesGen++;
      continue;
    }
    const ref = (m[2] ?? "").trim();
    const key = `${String(basesGen)}\u0000${ref}`;
    let resolved = memo.get(key);
    if (resolved === undefined) {
      if (memo.size >= maxRefs) {
        throw new JpaperError(2, "too-large", `図の参照が上限 ${maxRefs} 件を超えています`);
      }
      resolved = resolveFigure(baseDir, rootDir, bases, ref, budget);
      if (resolved === null) {
        index ??= buildNameIndex(rootDir);
        resolved = findByBasename(rootDir, ref, index);
      }
      memo.set(key, resolved);
    }
    if (resolved) found.add(resolved);
  }
  return [...found].sort();
}
