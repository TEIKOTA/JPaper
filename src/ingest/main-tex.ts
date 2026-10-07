// 設計メモ §3。main.tex 検出（ヒューリスティック）＋ \input/\include 展開。
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";
import { isInsideDirReal } from "./paths.js";

const PREFERRED = ["main.tex", "ms.tex", "paper.tex", "manuscript.tex", "root.tex"];

export function listTexFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(rel: string): void {
    for (const ent of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(child);
      else if (ent.name.toLowerCase().endsWith(".tex")) out.push(child);
    }
  }
  walk("");
  return out.sort();
}

// main.tex 判定に必要なのは前文だけ。巨大な .tex を全部メモリへ載せない
// （本文から参照されないファイルは maxTotalBytes に数えられず、上限が効かない）。
const DETECT_HEAD_BYTES = 256 * 1024;

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function detectMainTex(dir: string, maxFiles = 10_000): string {
  const all = listTexFiles(dir).filter((f) => isInsideDirReal(dir, path.join(dir, f)));
  // 件数にも上限を掛ける（ディレクトリ入力は展開経路の Budget を通らない）。
  if (all.length > maxFiles) {
    throw new JpaperError(2, "too-large", `.tex の数が上限 ${maxFiles} を超えています`);
  }
  const texs = all;
  // 判定に要るのは真偽値 2 つだけ。前文を全件分ため込むと常駐量が件数 × 256KB
  // （上限件数で約 2.5GB）になり、ワーカーごと OOM で落ちる。1 パスで畳む。
  const withDoc: string[] = [];
  const withClass: string[] = [];
  for (const f of texs) {
    const head = readHead(path.join(dir, f), DETECT_HEAD_BYTES);
    if (!/\\documentclass/.test(head)) continue;
    withClass.push(f);
    if (/\\begin\{document\}/.test(head)) withDoc.push(f);
  }
  const pool = withDoc.length > 0 ? withDoc : withClass;
  if (pool.length === 0) {
    throw new JpaperError(2, "input", "main.tex が見つかりません");
  }
  if (pool.length === 1) return pool[0]!;
  for (const name of PREFERRED) {
    const hit = pool.find((f) => path.basename(f).toLowerCase() === name);
    if (hit) return hit;
  }
  throw new JpaperError(2, "input", `main.tex を一意に決定できません: ${pool.join(", ")}`);
}

// ⚠ landmines.md
function stripComments(s: string): string {
  return s
    .replace(/^[ \t]*%.*(?:\r?\n|$)/gm, "")
    .replace(/((?:^|[^\\])(?:\\\\)*)%.*$/gm, "$1");
}

function resolveTexPath(dir: string, fromRel: string, target: string): string | null {
  const bases = ["", path.posix.dirname(fromRel)];
  const cands = target.toLowerCase().endsWith(".tex") ? [target] : [`${target}.tex`, target];
  for (const base of bases) {
    for (const cand of cands) {
      const rel = path.posix.normalize(base && base !== "." ? `${base}/${cand}` : cand);
      const abs = path.join(dir, rel);
      if (existsSync(abs) && isInsideDirReal(dir, abs)) return rel;
    }
  }
  return null;
}

// 展開の深さ上限。実在の論文は数段（main→章→節）で足りる。
const MAX_INPUT_DEPTH = 32;

export interface ExpandBudget {
  // 展開後の累積バイト数。超えた時点で打ち切る（展開が終わってから測っても手遅れ）。
  maxBytes: number;
  // 展開の回数。バイト数だけでは仕事量を抑えられない（小さいファイルを指数回読む
  // 入力があり、実測で 8MB に達するまで 27 秒かかった）。
  maxExpansions?: number;
  // 解決できなかった \input / \include の件数（呼び出し側へ返す）。黙って空文字列に
  // 置換すると、本文を別ファイルに持つ論文で同梱漏れがあっても「本文が空の成功」になる。
  unresolved?: number;
}

export function expandInputs(
  dir: string,
  mainRel: string,
  budget: ExpandBudget = { maxBytes: Number.POSITIVE_INFINITY },
): string {
  const stack: string[] = [];
  const maxExpansions = budget.maxExpansions ?? 5_000;
  let produced = 0;
  let expansions = 0;
  // 解決の試行そのものを数える。不在・循環先への \input は展開もバイトも増やさないのに
  // existsSync と realpathSync を叩くため、計上しないと「上限内なのに重い」入力が素通りする。
  let lookups = 0;
  // stack.includes は直接の循環しか止めない。各ファイルが次を 2 回読むダイヤモンド型は
  // 指数的に膨らみ、実測で 508 バイトの入力がイベントループを 205 秒占有した。
  const spend = (n: number): void => {
    produced += n;
    if (produced > budget.maxBytes) {
      throw new JpaperError(
        2,
        "too-large",
        `\\input 展開後の本文が上限 ${budget.maxBytes} バイトを超えています`,
      );
    }
  };
  function load(rel: string): string {
    if (stack.includes(rel)) return "";
    if (stack.length >= MAX_INPUT_DEPTH) {
      throw new JpaperError(2, "too-large", `\\input の入れ子が上限 ${MAX_INPUT_DEPTH} 段を超えています`);
    }
    if (!isInsideDirReal(dir, path.join(dir, rel))) return "";
    expansions++;
    if (expansions > maxExpansions) {
      throw new JpaperError(
        2,
        "too-large",
        `\\input の展開回数が上限 ${maxExpansions} を超えています`,
      );
    }
    stack.push(rel);
    const raw = stripComments(readFileSync(path.join(dir, rel), "utf8"));
    spend(raw.length);
    const out = raw.replace(
      /\\(?:input|include|@@input)\s*\{([^}]+)\}|\\(?:input|@@input)\s+([^\s{}\\%]+)/g,
      (_m, braced: string | undefined, unbraced: string | undefined) => {
        lookups++;
        if (lookups > maxExpansions) {
          throw new JpaperError(
            2,
            "too-large",
            `\\input の解決回数が上限 ${maxExpansions} を超えています`,
          );
        }
        const child = resolveTexPath(dir, rel, (braced ?? unbraced ?? "").trim());
        if (child === null) {
          budget.unresolved = (budget.unresolved ?? 0) + 1;
          return "";
        }
        return load(child);
      },
    );
    stack.pop();
    return out;
  }
  return load(mainRel);
}
