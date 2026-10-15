// 契約付録 §8（伏せ字）。PDF のページで、指定した語の位置（pt）を pdftotext -bbox-layout の語の矩形から求める。
import type { Box } from "./figures.js";
import type { Redactor } from "../redact.js";
import { CONTROL } from "./text-layer.js";

interface Word extends Box {
  text: string;
  // 行の最後の語か（段の最後の行は除く。pdftotext はそこで分綴を外さない）。
  eol?: boolean;
}

const attr = (tag: string, name: string): number => Number(new RegExp(`${name}="([-0-9.]+)"`).exec(tag)?.[1] ?? NaN);

// 語の文字を、テキスト層（normalizePageText）と同じ文字にする（実体参照を戻し、制御文字を落とす）。
function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(CONTROL, "");
}

export function pageWords(xhtml: string): Word[] {
  const words: Word[] = [];
  for (const m of xhtml.matchAll(/<word ([^>]*)>([\s\S]*?)<\/word>|<\/line>|<\/flow>/g)) {
    if (m[1] === undefined) {
      const last = words[words.length - 1];
      if (last !== undefined) last.eol = m[0] === "</line>" ? true : undefined;
      continue;
    }
    words.push({ x0: attr(m[1], "xMin"), y0: attr(m[1], "yMin"), x1: attr(m[1], "xMax"), y1: attr(m[1], "yMax"), text: decode(m[2]!) });
  }
  return words;
}

// この幅（pt）未満の隙間で縦に重なる隣の語（上付きの番号など）は、テキスト層では空白なしでつながる。
export const JOIN_GAP = 0.25;

// 語の間に空白を入れるか（pdftotext のテキスト層と同じつなぎ方）。画面の語の選択（apps/web の RedactPanel）も同じ規則を使う。
export function spaceBetween(a: Box, b: Box): boolean {
  return !(b.x0 - a.x1 < JOIN_GAP && b.x0 >= a.x0 && b.y1 > a.y0 && b.y0 < a.y1);
}

// 行末が - の語は、テキスト層では - を落として次の行の語に空白なしでつながる（分綴）。
export function hyphenated(w: { text: string; eol?: boolean }): boolean {
  return w.eol === true && w.text.endsWith("-");
}

// 語をテキスト層と同じようにつないだ文字列と、各語の開始・終了の位置。
export function joinWords(words: readonly Word[]): { joined: string; starts: number[]; ends: number[] } {
  let joined = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    if (prev !== undefined && !hyphenated(prev) && spaceBetween(prev, w)) joined += " ";
    starts.push(joined.length);
    joined += hyphenated(w) && i < words.length - 1 ? w.text.slice(0, -1) : w.text;
    ends.push(joined.length);
  }
  return { joined, starts, ends };
}

// 語の文字の間に入りうる空白・書字方向の制御文字・- （テキスト層と語の矩形で入り方が違いうるもの）。
const LOOSE_GAP = "[\\s\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069-]*";
const looseCache = new WeakMap<Redactor, RegExp>();

// 語の文字の間に空白などが入っても当てる正規表現（長い語から）。
function loosePattern(r: Redactor): RegExp {
  let p = looseCache.get(r);
  if (p === undefined) {
    const chars = (t: string): string[] => [...t.replace(/[\s-]/g, "")];
    const terms = [...r.terms].sort((a, b) => chars(b).length - chars(a).length);
    p = new RegExp(terms.map((t) => chars(t).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(LOOSE_GAP)).join("|"), "gu");
    looseCache.set(r, p);
  }
  return p;
}

const squeeze = (t: string): string => t.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069-]/g, "");

// 緩い当たりを文書の順に並べ、それぞれ当たった文字列（空白などを除く）と、伏せ字の当たり（同じ範囲）かどうかの印にする。
function matchSequence(s: string, r: Redactor): string[] {
  const strict = new Set([...s.matchAll(r.pattern)].map((m) => `${String(m.index)}:${String(m.index + m[0].length)}`));
  return [...s.matchAll(loosePattern(r))].map((m) => `${strict.has(`${String(m.index)}:${String(m.index + m[0].length)}`) ? "+" : "-"}${squeeze(m[0])}`);
}

// テキスト層とつないだ語の文字列で、伏せ字の当たりが食い違っていないか（どちらかに語が残らないか）。
// 空白などの入り方だけが違う同じ語（緩い当たり）を文書の順に並べ、どれが伏せ字の当たりかまで両方で同じなら食い違いなし。
// ⚠ landmines.md
export function sameMatches(text: string, joined: string, r: Redactor): boolean {
  const a = matchSequence(text, r);
  const b = matchSequence(joined, r);
  return a.length === b.length && a.every((v, k) => v === b[k]);
}

// 語をテキスト層と同じようにつないだ文字列で当て、当たった範囲に重なる語の矩形（少し広げる）・当たった数・つないだ文字列を返す。
export function redactionBoxes(words: readonly Word[], r: Redactor, pad = 1): { boxes: Box[]; hits: number; joined: string } {
  const { joined, starts, ends } = joinWords(words);
  const boxes: Box[] = [];
  let hits = 0;
  r.pattern.lastIndex = 0;
  for (const m of joined.matchAll(r.pattern)) {
    hits++;
    const a = m.index;
    const b = a + m[0].length;
    for (const [i, w] of words.entries()) {
      if (starts[i]! < b && ends[i]! > a) boxes.push({ x0: w.x0 - pad, y0: w.y0 - pad, x1: w.x1 + pad, y1: w.y1 + pad });
    }
  }
  return { boxes, hits, joined };
}
