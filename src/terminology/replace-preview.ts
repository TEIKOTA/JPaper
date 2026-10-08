// 契約付録 §9。置換の確認画面に出す断片（訳文の文・原文の文）を作る。表示専用で、置換そのものには使わない。
import type { Occurrence } from "./replace.js";

export type PieceMark = "old" | "new" | "shield" | "src";

export interface Piece {
  text: string;
  mark?: PieceMark;
}

export interface SentencePreview {
  // 訳文の文（置換前・置換後）と前後の文。
  before: Piece[];
  after: Piece[];
  prev?: string;
  next?: string;
  replaced: number;
  shieldedBy: string[];
}

// 一文として切り出す長さの上限（片側）。
const MAX_SIDE_CHARS = 160;

const JA_END = /[。．！？]/;

function isParagraphBreak(text: string, i: number): boolean {
  return text[i] === "\n" && /^\n[ \t]*\n/.test(text.slice(i, i + 64));
}

// i を含む文の範囲 [start, end)。上限で切った側は cut が立つ。
function jaSentenceAt(text: string, i: number): { start: number; end: number; cutStart: boolean; cutEnd: boolean } {
  let start = i;
  while (start > 0 && i - start < MAX_SIDE_CHARS) {
    const c = text[start - 1]!;
    if (JA_END.test(c) || isParagraphBreak(text, start - 1) || (c === "\n" && text[start - 2] === "\n")) break;
    start--;
  }
  let end = i;
  while (end < text.length && end - i < MAX_SIDE_CHARS) {
    const c = text[end]!;
    if (JA_END.test(c)) {
      end++;
      break;
    }
    if (isParagraphBreak(text, end)) break;
    end++;
  }
  return { start, end, cutStart: start > 0 && i - start >= MAX_SIDE_CHARS, cutEnd: end < text.length && end - i >= MAX_SIDE_CHARS };
}

const DISPLAY_MATH =
  /\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g;
const INLINE_MATH = /\$[^$]*\$|\\\([\s\S]*?\\\)/g;

function plainProse(tex: string): string {
  return tex
    .replace(/\\(?:label|index)\{[^{}]*\}/g, "")
    .replace(/\\(?:[vh]space|[hv]?phantom|thanks|footnote|rule)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, "")
    .replace(/\\(?:cite[a-zA-Z]*)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, "[引用]")
    .replace(/\\(?:eqref|ref|autoref|cref|Cref)\{[^{}]*\}/g, "[参照]")
    .replace(/\\(?:begin|end)\{[^{}]*\}/g, " ")
    .replace(/\\(?:textbf|textit|emph|textsc|texttt|textrm|textsf|underline|mbox|text)\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:sub)*section\*?\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ");
}

export type Macros = ReadonlyMap<string, string>;

// 引数を取らない \newcommand の名前→中身（\newcommand{\diverse}{\textsc{DIVERSE}}）。表示専用。
export function simpleMacros(latex: string): Macros {
  const defs = new Map<string, string>();
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
  for (const m of latex.matchAll(re)) defs.set(m[1]!, m[2]!);
  return defs;
}

export function expandMacros(tex: string, macros: Macros | undefined): string {
  if (macros === undefined || macros.size === 0) return tex;
  let out = tex;
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\\([A-Za-z@]+)(?![A-Za-z@])/g, (all, name: string) => macros.get(name) ?? all);
  }
  return out;
}

// TeX を読める程度に整える（表示専用）。行内の数式は原文のまま、別行立ての数式は［数式］にする。
export function plainText(tex: string, trim = true, macros?: Macros): string {
  const t = expandMacros(tex, macros).replace(/(^|[^\\])%[^\n]*/g, "$1").replace(DISPLAY_MATH, " ［数式］ ");
  let out = "";
  let at = 0;
  for (const m of t.matchAll(INLINE_MATH)) {
    out += plainProse(t.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  const s = (out + plainProse(t.slice(at))).replace(/\s+/g, " ");
  return trim ? s.trim() : s;
}

function pieces(
  text: string,
  cuts: { start: number; end: number; mark: PieceMark; replacement?: string }[],
  macros?: Macros,
): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const c of cuts) {
    out.push({ text: plainText(text.slice(at, c.start), false, macros) });
    out.push({ text: c.replacement ?? text.slice(c.start, c.end), mark: c.mark });
    at = c.end;
  }
  out.push({ text: plainText(text.slice(at), false, macros) });
  const first = out[0]!;
  const last = out[out.length - 1]!;
  if (first.mark === undefined) first.text = first.text.trimStart();
  if (last.mark === undefined) last.text = last.text.trimEnd();
  return out.filter((p) => p.text !== "");
}

// 1 つの文字列の中の出現を文ごとにまとめる。
export function sentencePreviews(
  text: string,
  occs: readonly Occurrence[],
  newJa: string,
  macros?: Macros,
): SentencePreview[] {
  const groups: { start: number; end: number; cutStart: boolean; cutEnd: boolean; occs: Occurrence[] }[] = [];
  for (const o of occs) {
    const last = groups[groups.length - 1];
    if (last !== undefined && o.start < last.end) {
      last.occs.push(o);
      last.end = Math.max(last.end, o.end);
      continue;
    }
    const s = jaSentenceAt(text, o.start);
    groups.push({ ...s, end: Math.max(s.end, o.end), occs: [o] });
  }
  return groups.map((g) => {
    const sentence = text.slice(g.start, g.end);
    const local = g.occs.map((o) => ({ ...o, start: o.start - g.start, end: o.end - g.start }));
    const before = pieces(
      sentence,
      local.map((o) => ({ ...o, mark: o.shieldedBy === undefined ? ("old" as const) : ("shield" as const) })),
      macros,
    );
    const after = pieces(
      sentence,
      local.map((o) =>
        o.shieldedBy === undefined
          ? { ...o, mark: "new" as const, replacement: newJa }
          : { ...o, mark: "shield" as const },
      ),
      macros,
    );
    const ellipsis = (ps: Piece[]): Piece[] => [
      ...(g.cutStart ? [{ text: "…" }] : []),
      ...ps,
      ...(g.cutEnd ? [{ text: "…" }] : []),
    ];
    const prevRange = g.start > 0 ? jaSentenceAt(text, Math.max(0, g.start - 2)) : undefined;
    const nextRange = g.end < text.length ? jaSentenceAt(text, Math.min(text.length - 1, g.end + 1)) : undefined;
    const prev =
      prevRange && prevRange.end <= g.start
        ? `${prevRange.cutStart ? "…" : ""}${plainText(text.slice(prevRange.start, prevRange.end), true, macros)}`
        : undefined;
    const next =
      nextRange && nextRange.start >= g.end
        ? `${plainText(text.slice(nextRange.start, nextRange.end), true, macros)}${nextRange.cutEnd ? "…" : ""}`
        : undefined;
    return {
      before: ellipsis(before),
      after: ellipsis(after),
      ...(prev ? { prev } : {}),
      ...(next ? { next } : {}),
      replaced: g.occs.filter((o) => o.shieldedBy === undefined).length,
      shieldedBy: [...new Set(g.occs.flatMap((o) => (o.shieldedBy === undefined ? [] : [o.shieldedBy])))],
    };
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 原文で src が出る文（出現順）。src は太字の印を付ける。
export function sourceSentences(latex: string, src: string, macros?: Macros): Piece[][] {
  const re = new RegExp(`(?<![A-Za-z])${escapeRegExp(src)}(?![A-Za-z])`, "gi");
  const out: Piece[][] = [];
  let lastEnd = -1;
  for (const m of latex.matchAll(re)) {
    const i = m.index;
    if (i < lastEnd) continue;
    let start = i;
    while (start > 0 && i - start < MAX_SIDE_CHARS * 2) {
      const prev = latex.slice(Math.max(0, start - 2), start);
      if (/[.!?]\s$/.test(prev) || isParagraphBreak(latex, start - 1)) break;
      start--;
    }
    let end = i + m[0].length;
    while (end < latex.length && end - i < MAX_SIDE_CHARS * 2) {
      if (/[.!?]/.test(latex[end]!) && /\s/.test(latex[end + 1] ?? " ")) {
        end++;
        break;
      }
      if (isParagraphBreak(latex, end)) break;
      end++;
    }
    lastEnd = end;
    const sentence = latex.slice(start, end);
    const cuts = [...sentence.matchAll(re)].map((x) => ({
      start: x.index,
      end: x.index + x[0].length,
      mark: "src" as const,
    }));
    out.push(pieces(sentence, cuts, macros));
  }
  return out;
}
