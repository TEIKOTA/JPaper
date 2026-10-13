// 契約付録 §4（glossary-builder に渡す本文の抜粋）。issue #258。
import { extractDocumentBody } from "../segment/segmenter.js";
import { stripTexComments } from "../tools/paper-title.js";
import { commandSpans, envSpans, removeSpans, verbatimSpans, type Span } from "../tools/tex-spans.js";
import { oneLine } from "../runtime/untrusted.js";

export const MAX_EXCERPT_CHARS = 12_000;
export const MAX_ABSTRACT_CHARS = 3_000;
export const MAX_HEADING_CHARS = 200;
export const MAX_LEAD_CHARS = 400;
const LEAD_SENTENCES = 2;
const HEADINGS = ["section", "subsection", "subsubsection"] as const;
// 冒頭文から外す環境。
const SKIPPED_ENVS = ["figure", "table", "wrapfigure", "algorithm", "comment", "lstlisting", "minted"];
// 直後の終止符で文を切らない略語（小文字で比べる）。
const ABBREVIATIONS = new Set(["e.g", "i.e", "al", "fig", "figs", "sec", "secs", "eq", "eqs", "tab", "cf", "vs", "resp", "approx"]);
const FULL_WIDTH_ENDS = new Set(["。", "．", "！", "？"]);

function abbreviationBefore(text: string, dot: number): boolean {
  let i = dot;
  while (i > 0 && /[A-Za-z.]/.test(text[i - 1]!)) i--;
  return ABBREVIATIONS.has(text.slice(i, dot).toLowerCase());
}

// 先頭から n 文（. ! ? の後に空白か末尾で直前が略語でないもの、または全角の終止符）。見つからなければ max 字まで。
export function leadSentences(text: string, n = LEAD_SENTENCES, max = MAX_LEAD_CHARS): string {
  const head = text.slice(0, max);
  let found = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    const ascii =
      (c === "." || c === "!" || c === "?") &&
      (i + 1 === head.length || /\s/.test(head[i + 1]!)) &&
      !(c === "." && abbreviationBefore(head, i));
    if ((ascii || FULL_WIDTH_ENDS.has(c)) && ++found === n) return head.slice(0, i + 1);
  }
  return head.length < text.length ? `${head.slice(0, max - 1)}…` : head;
}

interface Heading {
  level: number;
  span: Span;
  title: string;
}

function escaped(tex: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && tex[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

// 位置が行コメントの中か（同じ行の手前にエスケープされていない % がある）を返す関数。走査は 1 回。
function commentTest(tex: string): (at: number) => boolean {
  const starts: number[] = [0];
  const pct: number[] = [-1];
  let run = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\n") {
      starts.push(i + 1);
      pct.push(-1);
    } else if (c === "%" && run % 2 === 0 && pct[pct.length - 1] === -1) {
      pct[pct.length - 1] = i;
    }
    run = c === "\\" ? run + 1 : 0;
  }
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return pct[lo]! !== -1 && pct[lo]! < at;
  };
}

// 命令の区間の最後の } に対応する {（必須引数の開始）。
function mandatoryOpen(tex: string, span: Span): number {
  let depth = 0;
  for (let i = span[1] - 1; i >= span[0]; i--) {
    const c = tex[i];
    if (escaped(tex, i)) continue;
    if (c === "}") depth++;
    else if (c === "{" && --depth === 0) return i;
  }
  return span[0];
}

function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  HEADINGS.forEach((name, level) => {
    for (const span of commandSpans(body, name)) {
      const open = mandatoryOpen(body, span);
      out.push({ level, span, title: oneLine(body.slice(open + 1, span[1] - 1), MAX_HEADING_CHARS) });
    }
  });
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

function abstractOf(tex: string): string | undefined {
  const env = envSpans(tex, "abstract").sort((a, b) => a[0] - b[0])[0];
  if (env !== undefined) {
    const inner = tex.slice(tex.indexOf("}", env[0]) + 1, tex.lastIndexOf("\\end", env[1] - 1));
    const text = oneLine(inner, MAX_ABSTRACT_CHARS);
    if (text !== "") return text;
  }
  const cmd = commandSpans(tex, "abstract")[0];
  if (cmd === undefined) return undefined;
  return oneLine(tex.slice(mandatoryOpen(tex, cmd) + 1, cmd[1] - 1), MAX_ABSTRACT_CHARS) || undefined;
}

// verbatim を外してから行コメントを落とし、図表・コードの環境と \label を外した本文。⚠ landmines.md
function proseOnly(body: string): string {
  const inComment = commentTest(body);
  const verbatim = verbatimSpans(body).filter(([s]) => !inComment(s));
  const plain = stripTexComments(removeSpans(body, verbatim, " "));
  const spans: Span[] = [...SKIPPED_ENVS.flatMap((e) => envSpans(plain, e)), ...commandSpans(plain, "label")];
  return removeSpans(plain, spans, " ");
}

// abstract・見出しの一覧・各見出しの直後の 1〜2 文。全体で MAX_EXCERPT_CHARS 字まで。
// 見出しは全部入れ、冒頭文は残りの字数に浅い見出しから順に入れる。
export function paperExcerpt(cleanLatex: string): string {
  const body = proseOnly(extractDocumentBody(cleanLatex));
  const abstract = abstractOf(body) ?? abstractOf(stripTexComments(cleanLatex));
  const hs = headingsOf(body);
  const lines = hs.map((h) => `${"§".repeat(h.level + 1)} ${h.title}`);
  const head = abstract === undefined ? [] : [`[abstract] ${abstract}`];
  let used = [...head, ...lines].reduce((n, l) => n + l.length + 1, 0);
  if (used > MAX_EXCERPT_CHARS) {
    const fit: string[] = [...head];
    let n = head.reduce((k, l) => k + l.length + 1, 0);
    for (const l of lines) {
      if (n + l.length + 1 > MAX_EXCERPT_CHARS) break;
      fit.push(l);
      n += l.length + 1;
    }
    return fit.join("\n");
  }
  const byDepth = hs.map((h, i) => ({ h, i })).sort((a, b) => a.h.level - b.h.level || a.i - b.i);
  for (const { h, i } of byDepth) {
    const to = i + 1 < hs.length ? hs[i + 1]!.span[0] : body.length;
    const raw = body.slice(h.span[1], Math.min(to, h.span[1] + MAX_LEAD_CHARS * 4));
    const lead = leadSentences(oneLine(raw, MAX_LEAD_CHARS * 4));
    if (lead === "" || used + lead.length + 2 > MAX_EXCERPT_CHARS) continue;
    lines[i] = `${lines[i]!}: ${lead}`;
    used += lead.length + 2;
  }
  return [...head, ...lines].join("\n");
}
