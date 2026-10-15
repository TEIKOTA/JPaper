// 契約付録 §8（PDF 入力）・PDF 入力 ADR(20261015) 決定 1・6。テキスト層の前処理。
import { JpaperError } from "../../types/errors.js";

// これより非空白の文字が少ないページはテキスト層が無いとみなす。
export const MIN_TEXT_CHARS = 20;
// 繰り返す行の判定に要るページ数と、行を見る上端・下端の行数。
export const MIN_PAGES_FOR_REPEAT = 3;
const EDGE_LINES = 3;
// 同じ位置に同じ行が現れるページの割合がこれ以上なら、柱・ノンブル・購入者表示として落とす。
const REPEAT_RATIO = 0.5;

// テキスト層から落とす制御文字（タブ・改行は残す）。
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// pdftotext の出力を整える（改ページ文字・制御文字を落とし、行末の空白を詰める）。
export function normalizePageText(raw: string): string {
  return raw
    .replace(/\f/g, "\n")
    .replace(CONTROL, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

export function hasTextLayer(text: string): boolean {
  return text.replace(/\s/gu, "").length >= MIN_TEXT_CHARS;
}

// 行の比較キー。ノンブルや版ごとに変わる数字を同一視する。
function lineKey(line: string): string {
  return line.trim().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

function edgeIndexes(lines: string[]): { top: number[]; bottom: number[] } {
  const nonEmpty = lines.map((l, i) => (l.trim() === "" ? -1 : i)).filter((i) => i >= 0);
  return { top: nonEmpty.slice(0, EDGE_LINES), bottom: nonEmpty.slice(-EDGE_LINES).reverse() };
}

// 毎ページ同じ位置（上端・下端から数えて何行目か）に繰り返す行を落とす。
// 読むページが MIN_PAGES_FOR_REPEAT 枚未満なら判定しない。
export function stripRepeatedLines(pages: readonly string[]): string[] {
  const split = pages.map((p) => p.split("\n"));
  if (pages.filter(hasTextLayer).length < MIN_PAGES_FOR_REPEAT) return [...pages];
  const counts = new Map<string, number>();
  const keysOf = (lines: string[]): string[] => {
    const { top, bottom } = edgeIndexes(lines);
    return [
      ...top.map((i, k) => `t${String(k)}:${lineKey(lines[i]!)}`),
      ...bottom.map((i, k) => `b${String(k)}:${lineKey(lines[i]!)}`),
    ];
  };
  for (const lines of split) {
    for (const key of new Set(keysOf(lines))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const textPages = pages.filter(hasTextLayer).length;
  const repeated = (key: string): boolean => (counts.get(key) ?? 0) >= Math.max(2, textPages * REPEAT_RATIO);
  return split.map((lines) => {
    const { top, bottom } = edgeIndexes(lines);
    const drop = new Set<number>();
    top.forEach((i, k) => {
      if (repeated(`t${String(k)}:${lineKey(lines[i]!)}`)) drop.add(i);
    });
    bottom.forEach((i, k) => {
      if (repeated(`b${String(k)}:${lineKey(lines[i]!)}`)) drop.add(i);
    });
    // 繰り返しを落とした後の最初・最後の行が数字だけなら、ノンブルとして落とす。
    const rest = lines.map((l, i) => (drop.has(i) || l.trim() === "" ? -1 : i)).filter((i) => i >= 0);
    for (const i of [rest[0], rest[rest.length - 1]]) {
      if (i !== undefined && /^\d+$/.test(lines[i]!.trim())) drop.add(i);
    }
    return lines.filter((_, i) => !drop.has(i)).join("\n").replace(/^\n+|\n+$/g, "");
  });
}

// "1-72" / "3" / "1-3,7,10-12" を 1 始まりの昇順のページ番号へ。PDF の何枚目かで数える。
export function parsePageRange(spec: string, pageCount: number): number[] {
  const pages = new Set<number>();
  const bad = (why: string): JpaperError => new JpaperError(2, "input", `--pages の指定が不正です（${why}）: ${spec}`);
  if (spec.trim() === "") throw bad("空");
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (m === null) throw bad(`「${part}」は N か N-M で書く`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw bad(`「${part}」の範囲が逆か 0`);
    }
    if (to > pageCount) throw bad(`この PDF は ${String(pageCount)} ページ`);
    for (let p = from; p <= to; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}
