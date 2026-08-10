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
  // 同じファイルを 2 回読まない（判定は 2 条件あるが読み込みは 1 回で足りる）。
  const heads = new Map(texs.map((f) => [f, readHead(path.join(dir, f), DETECT_HEAD_BYTES)]));
  const head = (f: string): string => heads.get(f) ?? "";
  const withDoc = texs.filter(
    (f) => /\\documentclass/.test(head(f)) && /\\begin\{document\}/.test(head(f)),
  );
  const pool =
    withDoc.length > 0 ? withDoc : texs.filter((f) => /\\documentclass/.test(head(f)));
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

function stripComments(s: string): string {
  return s.replace(/((?:^|[^\\])(?:\\\\)*)%.*$/gm, "$1");
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

export function expandInputs(dir: string, mainRel: string): string {
  const stack: string[] = [];
  function load(rel: string): string {
    if (stack.includes(rel)) return "";
    if (!isInsideDirReal(dir, path.join(dir, rel))) return "";
    stack.push(rel);
    const raw = stripComments(readFileSync(path.join(dir, rel), "utf8"));
    const out = raw.replace(
      /\\(?:input|include|@@input)\s*\{([^}]+)\}|\\(?:input|@@input)\s+([^\s{}\\%]+)/g,
      (_m, braced: string | undefined, unbraced: string | undefined) => {
        const child = resolveTexPath(dir, rel, (braced ?? unbraced ?? "").trim());
        return child ? load(child) : "";
      },
    );
    stack.pop();
    return out;
  }
  return load(mainRel);
}
