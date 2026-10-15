// 契約付録 §8（伏せ字）。PDF のページで、指定した語の位置（pt）を pdftotext -bbox-layout の語の矩形から求める。
import type { Box } from "./figures.js";
import type { Redactor } from "../redact.js";

interface Word extends Box {
  text: string;
  // 行の最後の語か（段の最後の行は除く。pdftotext はそこで分綴を外さない）。
  eol?: boolean;
}

const attr = (tag: string, name: string): number => Number(new RegExp(`${name}="([-0-9.]+)"`).exec(tag)?.[1] ?? NaN);

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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

// 語をテキスト層と同じようにつないだ文字列で当て、当たった範囲に重なる語の矩形（少し広げる）と当たった数を返す。
export function redactionBoxes(words: readonly Word[], r: Redactor, pad = 1): { boxes: Box[]; hits: number } {
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
  return { boxes, hits };
}
