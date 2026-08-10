// 設計メモ §3。main.tex 検出（ヒューリスティック）＋ \input/\include 展開。
import { readdirSync, readFileSync, existsSync } from "node:fs";
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

export function detectMainTex(dir: string): string {
  const texs = listTexFiles(dir).filter((f) =>
    isInsideDirReal(dir, path.join(dir, f)),
  );
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const withDoc = texs.filter(
    (f) => /\\documentclass/.test(read(f)) && /\\begin\{document\}/.test(read(f)),
  );
  const pool =
    withDoc.length > 0 ? withDoc : texs.filter((f) => /\\documentclass/.test(read(f)));
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
