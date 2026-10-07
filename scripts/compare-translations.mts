#!/usr/bin/env tsx
// 2 つの翻訳成果物（translation/chapters/*.tex）を構造の観点で突き合わせる。
// 使い方: pnpm exec tsx scripts/compare-translations.mts <A の outDir> <B の outDir>
// 判定は決定的な指標だけ（LLM を使わない）。意味の良し悪しは人が見る。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [aDir, bDir] = process.argv.slice(2);
if (!aDir || !bDir) {
  console.error("usage: tsx scripts/compare-translations.mts <outDirA> <outDirB>");
  process.exit(2);
}

function chapters(outDir: string): Map<string, string> {
  const dir = path.join(outDir, "translation", "chapters");
  const m = new Map<string, string>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tex")).sort()) {
    m.set(f, readFileSync(path.join(dir, f), "utf8"));
  }
  return m;
}

const cmdCounts = (tex: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const [, name] of tex.matchAll(/\\([a-zA-Z]+)/g)) {
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return m;
};

// 訳し残しの目安: LaTeX コマンドとその引数を除いた地の文に残る英単語。
const proseEnglish = (tex: string): number => {
  const stripped = tex
    .replace(/\\[a-zA-Z]+\s*(\[[^\]]*\])?(\{[^{}]*\})?/g, " ")
    .replace(/\$[^$]*\$/g, " ");
  return (stripped.match(/[A-Za-z]{4,}/g) ?? []).length;
};

const jaChars = (tex: string): number =>
  (tex.match(/[぀-ヿ一-鿿]/g) ?? []).length;

const A = chapters(aDir);
const B = chapters(bDir);
const keys = [...new Set([...A.keys(), ...B.keys()])].sort();

console.log(`A = ${aDir}  (${String(A.size)} 章)`);
console.log(`B = ${bDir}  (${String(B.size)} 章)`);
console.log("");
console.log("seg           A:日本語 B:日本語   A:英語残 B:英語残   コマンド差");

let cmdDiffTotal = 0;
for (const k of keys) {
  const a = A.get(k);
  const b = B.get(k);
  if (a === undefined || b === undefined) {
    console.log(`${k.padEnd(14)} ${a === undefined ? "(A に無し)" : "(B に無し)"}`);
    continue;
  }
  const ca = cmdCounts(a);
  const cb = cmdCounts(b);
  let diff = 0;
  for (const name of new Set([...ca.keys(), ...cb.keys()])) {
    diff += Math.abs((ca.get(name) ?? 0) - (cb.get(name) ?? 0));
  }
  cmdDiffTotal += diff;
  console.log(
    `${k.padEnd(14)} ${String(jaChars(a)).padStart(7)} ${String(jaChars(b)).padStart(8)}   ` +
      `${String(proseEnglish(a)).padStart(7)} ${String(proseEnglish(b)).padStart(8)}   ` +
      `${diff === 0 ? "-" : String(diff)}`,
  );
}

const sum = (m: Map<string, string>, f: (s: string) => number) =>
  [...m.values()].reduce((n, v) => n + f(v), 0);

console.log("");
console.log(`日本語文字数  A=${String(sum(A, jaChars))}  B=${String(sum(B, jaChars))}`);
console.log(`地の文の英単語 A=${String(sum(A, proseEnglish))}  B=${String(sum(B, proseEnglish))}`);
console.log(`コマンド出現数の総差分 = ${String(cmdDiffTotal)}`);
