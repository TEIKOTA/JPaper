// 契約付録 §8（PDF 入力・図）・PDF 入力 ADR(20261015) 決定 8。キャプションの上の空白を図として切り出す範囲。

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextBlock extends Box {
  text: string;
  lines: Box[];
}

export interface PageLayout {
  width: number;
  height: number;
  blocks: TextBlock[];
}

export interface FigureRegion extends Box {
  // キャプションの先頭（"Figure 1.1." など）。
  label: string;
}

// 上端・下端の帯（柱・ノンブル・購入者表示）。ページの高さに対する割合。
const HEAD_BAND = 0.1;
const FOOT_BAND = 0.08;
// 本文の行とみなす最小の幅（pt）。
const MIN_BODY_LINE = 150;
// 本文ブロックとみなす幅（範囲の幅に対する割合）。
const BODY_RATIO = 0.5;
// 図とみなす最小の高さ（pt）。
const MIN_FIGURE_HEIGHT = 20;
// 範囲の余白（pt）。柱の下の罫線を避けるため、柱の下は広めに取る。
const GAP = 2;
const HEAD_GAP = 8;
// キャプションの幅が本文の幅のこれ未満なら、片方の段の図とみなす。
const COLUMN_RATIO = 0.55;

// 番号の直後に . か : が付くか、次が | のもの（本文の「Figure 1.1 shows」は除く）。
const CAPTION = /^(?:Figure|Fig\.)\s+[A-Z]?\d+(?:\.\d+)*(?:[.:](?=\s|$)|\s+\|)/;
const TABLE_CAPTION = /^Table\s+[A-Z]?\d+(?:\.\d+)*(?:[.:](?=\s|$)|\s+\|)/;

// 図の番号（"Figure 1.1." → "1.1"）。文字列の中で最初に現れるもの。
const FIGURE_NUMBER = /\b(?:Figure|Fig\.)\s*~?([A-Z]?\d+(?:\.\d+)*)/i;
export const figureKey = (text: string): string | undefined => FIGURE_NUMBER.exec(text)?.[1]?.toUpperCase();

const attr = (tag: string, name: string): number => Number(new RegExp(`${name}="([-0-9.]+)"`).exec(tag)?.[1] ?? NaN);
const boxOf = (tag: string): Box => ({ x0: attr(tag, "xMin"), y0: attr(tag, "yMin"), x1: attr(tag, "xMax"), y1: attr(tag, "yMax") });

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// pdftotext -bbox-layout の出力（1 ページ分）を読む。XML として壊れた文字があっても読めるよう正規表現で拾う。
export function parseBboxLayout(xhtml: string): PageLayout | undefined {
  const page = /<page ([^>]*)>([\s\S]*?)<\/page>/.exec(xhtml);
  if (page === null) return undefined;
  const blocks: TextBlock[] = [];
  for (const b of page[2]!.matchAll(/<block ([^>]*)>([\s\S]*?)<\/block>/g)) {
    const words = [...b[2]!.matchAll(/<word [^>]*>([\s\S]*?)<\/word>/g)].map((w) => decode(w[1]!));
    const lines = [...b[2]!.matchAll(/<line ([^>]*)>/g)].map((l) => boxOf(l[1]!));
    blocks.push({ ...boxOf(b[1]!), text: words.join(" "), lines });
  }
  return { width: attr(page[1]!, "width"), height: attr(page[1]!, "height"), blocks };
}

const head2 = (b: TextBlock): string => b.text.split(/\s+/).slice(0, 2).join(" ");
const head3 = (b: TextBlock): string => b.text.split(/\s+/).slice(0, 3).join(" ");
export const isFigureCaption = (b: TextBlock): boolean => CAPTION.test(head3(b));
const isTableCaption = (b: TextBlock): boolean => TABLE_CAPTION.test(head3(b));

// 本文の左右の端（上端・下端の帯を除いた、幅のある行の端の 10% 点と 90% 点）。
export function textBox(layout: PageLayout): { x0: number; x1: number } | undefined {
  const top = layout.height * HEAD_BAND;
  const bottom = layout.height * (1 - FOOT_BAND);
  const lines = layout.blocks
    .flatMap((b) => b.lines)
    .filter((l) => l.x1 - l.x0 > MIN_BODY_LINE && l.y0 > top && l.y1 < bottom);
  if (lines.length === 0) return undefined;
  const xs0 = lines.map((l) => l.x0).sort((a, b) => a - b);
  const xs1 = lines.map((l) => l.x1).sort((a, b) => a - b);
  return { x0: xs0[Math.floor(xs0.length / 10)]!, x1: xs1[Math.ceil((xs1.length * 9) / 10) - 1]! };
}

// キャプションごとの図の範囲（上から順）。ページの本文の幅が分からないか、文書全体（docBox）の 7 割に満たなければ docBox を使う。
export function figureRegions(layout: PageLayout, docBox?: { x0: number; x1: number }): FigureRegion[] {
  const own = textBox(layout);
  const box =
    own !== undefined && (docBox === undefined || own.x1 - own.x0 >= (docBox.x1 - docBox.x0) * 0.7) ? own : docBox;
  if (box === undefined) return [];
  const headY = layout.height * HEAD_BAND;
  const width = box.x1 - box.x0;
  const captions = layout.blocks.filter(isFigureCaption);
  const out: (FigureRegion & { order: number })[] = [];
  for (const c of captions) {
    // 片方の段の図なら、その段の範囲で考える。
    const mid = (box.x0 + box.x1) / 2;
    // 段の中央をまたがない幅の狭いキャプションだけを、片方の段の図とみなす。
    const narrow = c.x1 - c.x0 < width * COLUMN_RATIO && (c.x1 <= mid + GAP || c.x0 >= mid - GAP);
    const range = !narrow ? box : (c.x0 + c.x1) / 2 < mid ? { x0: box.x0, x1: mid } : { x0: mid, x1: box.x1 };
    const rw = range.x1 - range.x0;
    const overlaps = (b: Box): boolean => b.x1 > range.x0 && b.x0 < range.x1;
    const bounds = layout.blocks.filter(
      (b) =>
        b !== c &&
        b.y1 <= c.y0 + 0.5 &&
        overlaps(b) &&
        (b.x1 - b.x0 >= rw * BODY_RATIO || isFigureCaption(b) || isTableCaption(b) || b.y1 < headY),
    );
    const above = bounds.reduce<TextBlock | undefined>((m, b) => (m === undefined || b.y1 > m.y1 ? b : m), undefined);
    const top = above === undefined ? headY : above.y1 + (above.y1 < headY ? HEAD_GAP : GAP);
    const bottom = c.y0 - GAP;
    if (bottom - top < MIN_FIGURE_HEIGHT) continue;
    // 読む順: 全幅の図と左の段の図は上から、右の段の図はその後。
    const order = narrow && range.x0 >= mid ? layout.height + bottom : bottom;
    out.push({
      x0: Math.max(0, range.x0 - GAP),
      y0: top,
      x1: Math.min(layout.width, range.x1 + GAP),
      y1: bottom,
      label: head2(c),
      order,
    });
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...r }) => r);
}

// 文書全体の本文の左右の端（ページごとの値の中央値）。
export function documentTextBox(layouts: readonly PageLayout[]): { x0: number; x1: number } | undefined {
  const boxes = layouts.map(textBox).filter((b): b is { x0: number; x1: number } => b !== undefined);
  if (boxes.length === 0) return undefined;
  const med = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { x0: med(boxes.map((b) => b.x0)), x1: med(boxes.map((b) => b.x1)) };
}
