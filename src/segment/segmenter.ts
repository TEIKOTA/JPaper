// 契約付録 §3・§4。\section 境界＋0.30×CW 予算での決定的セグメント分割。
import { estimateTokens } from "./token-estimator.js";

export type SizeClass = "small" | "medium" | "large";

export interface Segment {
  id: string;
  latex: string;
  tokens: number;
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

export function segmentBudgetFor(contextWindow: number): number {
  return Math.floor(0.3 * contextWindow);
}

export function extractDocumentBody(latex: string): string {
  const begin = latex.indexOf("\\begin{document}");
  if (begin === -1) return latex;
  const from = begin + "\\begin{document}".length;
  const end = latex.indexOf("\\end{document}", from);
  return latex.slice(from, end === -1 ? latex.length : end);
}

function splitBySections(latex: string): string[] {
  const re = /\\(?:sub)*section\*?\s*\{/g;
  const idx: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(latex)) !== null) idx.push(m.index);
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
  for (const p of paras) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (buf !== "" && estimateTokens(candidate) > budget) {
      out.push(buf);
      buf = p;
    } else {
      buf = candidate;
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
