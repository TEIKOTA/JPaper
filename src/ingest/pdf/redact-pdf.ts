// 契約付録 §8（伏せ字）。PDF のページで、指定した語の位置（pt）を pdftotext -bbox-layout の語の矩形から求める。
import type { Box } from "./figures.js";
import type { Redactor } from "../redact.js";

interface Word extends Box {
  text: string;
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
  return [...xhtml.matchAll(/<word ([^>]*)>([\s\S]*?)<\/word>/g)].map((m) => ({
    x0: attr(m[1]!, "xMin"),
    y0: attr(m[1]!, "yMin"),
    x1: attr(m[1]!, "xMax"),
    y1: attr(m[1]!, "yMax"),
    text: decode(m[2]!),
  }));
}

// 語を空白 1 つでつないだ文字列で当て、当たった範囲に重なる語の矩形（少し広げる）と当たった数を返す。
export function redactionBoxes(words: readonly Word[], r: Redactor, pad = 1): { boxes: Box[]; hits: number } {
  let joined = "";
  const starts: number[] = [];
  for (const w of words) {
    if (joined !== "") joined += " ";
    starts.push(joined.length);
    joined += w.text;
  }
  const boxes: Box[] = [];
  let hits = 0;
  r.pattern.lastIndex = 0;
  for (const m of joined.matchAll(r.pattern)) {
    hits++;
    const a = m.index;
    const b = a + m[0].length;
    for (const [i, w] of words.entries()) {
      const s = starts[i]!;
      if (s < b && s + w.text.length > a) boxes.push({ x0: w.x0 - pad, y0: w.y0 - pad, x1: w.x1 + pad, y1: w.y1 + pad });
    }
  }
  return { boxes, hits };
}
