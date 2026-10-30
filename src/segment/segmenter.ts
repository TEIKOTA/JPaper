// 契約付録 §3・§4。\section 境界＋min(0.30×CW, 8000) 予算での決定的セグメント分割。
import { countChars, estimateTokens, tokensOf, type CharCounts } from "./token-estimator.js";

export type SizeClass = "small" | "medium" | "large";

export interface Segment {
  id: string;
  latex: string;
  tokens: number;
  // 翻訳へ送らず原文のまま残す区間（本文中の \title 命令）。契約付録 §8
  keep?: { start: number; end: number };
  // keep と同じく丸ごと原文のまま残す区間（著者・所属・注記。keep の外・開始位置の順）。契約付録 §3
  frozen?: [number, number][];
  // translator に成果物 PDF の短い英語名も出させる（title 節）。契約付録 §8
  askPdfName?: boolean;
}

export function sizeClassFor(tokens: number): SizeClass {
  if (tokens < 1500) return "small";
  if (tokens < 3500) return "medium";
  return "large";
}

const MAX_REVISIONS: Record<SizeClass, number> = { small: 3, medium: 4, large: 5 };

export function maxRevisionsFor(tokens: number): number {
  return MAX_REVISIONS[sizeClassFor(tokens)];
}

// 1 節の訳出が呼び出し期限内に収まる上限（契約付録 §4）。⚠ landmines.md
const MAX_SEGMENT_TOKENS = 8000;

export function segmentBudgetFor(contextWindow: number): number {
  return Math.min(Math.floor(0.3 * contextWindow), MAX_SEGMENT_TOKENS);
}

export function extractDocumentBody(latex: string): string {
  const begin = latex.indexOf("\\begin{document}");
  if (begin === -1) return latex;
  const from = begin + "\\begin{document}".length;
  const end = latex.indexOf("\\end{document}", from);
  return latex.slice(from, end === -1 ? latex.length : end);
}

// 見出しを包む波括弧のグループの中では割らない。閉じる位置までがこの文字数を超えるグループは数えない。契約付録 §4
const MAX_GROUP_CHARS = 2000;
const HEADING_RE = /\\(?:sub)*section\*?\s*\{/g;

// 上限内で閉じる波括弧のグループの内側にある見出しの添字を 1 回の走査で返す。⚠ landmines.md
function headingsInsideGroups(latex: string, idx: number[]): Set<number> {
  const diff = new Int32Array(idx.length + 1);
  const lowerBound = (pos: number): number => {
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const open: number[] = [];
  for (let i = 0; i < latex.length; i++) {
    const c = latex.charCodeAt(i);
    if (c === 0x5c) i++; // バックスラッシュと次の 1 文字
    else if (c === 0x25) {
      const nl = latex.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
    } else if (c === 0x7b) open.push(i);
    else if (c === 0x7d) {
      const from = open.pop();
      if (from === undefined || i - from > MAX_GROUP_CHARS) continue;
      const lo = lowerBound(from + 1);
      const hi = lowerBound(i);
      if (lo < hi) {
        diff[lo]!++;
        diff[hi]!--;
      }
    }
  }
  const inside = new Set<number>();
  let cover = 0;
  for (let k = 0; k < idx.length; k++) {
    cover += diff[k]!;
    if (cover > 0) inside.add(idx[k]!);
  }
  return inside;
}

function splitBySections(latex: string): string[] {
  const re = new RegExp(HEADING_RE.source, "g");
  const all: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(latex)) !== null) all.push(m.index);
  if (all.length === 0) return [latex];
  const inside = headingsInsideGroups(latex, all);
  const idx = all.filter((i) => !inside.has(i));
  if (idx.length === 0) return [latex];
  const chunks: string[] = [];
  const pre = latex.slice(0, idx[0]!);
  if (pre.trim() !== "") chunks.push(pre);
  for (let i = 0; i < idx.length; i++) {
    const to = i + 1 < idx.length ? idx[i + 1]! : latex.length;
    chunks.push(latex.slice(idx[i]!, to));
  }
  return chunks;
}

function splitByParagraphs(chunk: string, budget: number): string[] {
  const paras = chunk.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = "";
  // バッファの文字数は足し込みで持つ。連結後の文字列を数え直すと O(バッファ長) が
  // 段落ごとに掛かり、実測 400KiB の入力が 120 秒同期でイベントループを止めた。
  let bufCounts: CharCounts = { cjk: 0, other: 0 };
  const sep = countChars("\n\n");
  for (const p of paras) {
    const pc = countChars(p);
    const candidate = buf ? `${buf}\n\n${p}` : p;
    const candCounts: CharCounts = buf
      ? { cjk: bufCounts.cjk + sep.cjk + pc.cjk, other: bufCounts.other + sep.other + pc.other }
      : pc;
    if (buf !== "" && tokensOf(candCounts) > budget) {
      out.push(buf);
      buf = p;
      bufCounts = pc;
    } else {
      buf = candidate;
      bufCounts = candCounts;
    }
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

export function segment(latex: string, budget: number): Segment[] {
  const chunks = splitBySections(extractDocumentBody(latex));
  const pieces: string[] = [];
  for (const c of chunks) {
    if (estimateTokens(c) > budget) pieces.push(...splitByParagraphs(c, budget));
    else pieces.push(c);
  }
  return pieces
    .filter((p) => p.trim() !== "")
    .map((latex, i) => ({
      id: `seg-${String(i).padStart(4, "0")}`,
      latex,
      tokens: estimateTokens(latex),
    }));
}
