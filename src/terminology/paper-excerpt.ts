// 契約付録 §4（glossary-builder に渡す本文の抜粋）。issue #258。
import { extractDocumentBody } from "../segment/segmenter.js";
import { stripTexComments } from "../tools/paper-title.js";
import { commandSpans, envSpans, type Span } from "../tools/tex-spans.js";

export const MAX_EXCERPT_CHARS = 12_000;
export const MAX_ABSTRACT_CHARS = 3_000;
export const MAX_LEAD_CHARS = 400;
const LEAD_SENTENCES = 2;
const HEADINGS = ["section", "subsection", "subsubsection"] as const;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// 先頭から n 文（. ! ? の後に空白か末尾、または 。）。見つからなければ max 字まで。
export function leadSentences(text: string, n = LEAD_SENTENCES, max = MAX_LEAD_CHARS): string {
  const head = text.slice(0, max);
  let found = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    const end = c === "。" || ((c === "." || c === "!" || c === "?") && (i + 1 === head.length || /\s/.test(head[i + 1]!)));
    if (end && ++found === n) return head.slice(0, i + 1);
  }
  return clip(head, max - 1);
}

interface Heading {
  level: number;
  span: Span;
  title: string;
}

function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  HEADINGS.forEach((name, level) => {
    for (const span of commandSpans(body, name)) {
      const open = body.indexOf("{", span[0]);
      out.push({ level, span, title: squash(body.slice(open + 1, span[1] - 1)) });
    }
  });
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

function abstractOf(body: string): string | undefined {
  const env = envSpans(body, "abstract").sort((a, b) => a[0] - b[0])[0];
  if (env !== undefined) {
    const inner = body.slice(body.indexOf("}", env[0]) + 1, body.lastIndexOf("\\end", env[1]));
    return squash(inner);
  }
  const cmd = commandSpans(body, "abstract")[0];
  if (cmd === undefined) return undefined;
  return squash(body.slice(body.indexOf("{", cmd[0]) + 1, cmd[1] - 1));
}

// abstract・見出しの一覧・各見出しの直後の 1〜2 文を決定的に取り出す。全体で MAX_EXCERPT_CHARS 字まで。
export function paperExcerpt(cleanLatex: string): string {
  const body = stripTexComments(extractDocumentBody(cleanLatex));
  const parts: string[] = [];
  const abstract = abstractOf(body) ?? abstractOf(stripTexComments(cleanLatex));
  if (abstract !== undefined && abstract !== "") parts.push(`[abstract] ${clip(abstract, MAX_ABSTRACT_CHARS)}`);
  const hs = headingsOf(body);
  hs.forEach((h, i) => {
    const to = i + 1 < hs.length ? hs[i + 1]!.span[0] : body.length;
    const lead = leadSentences(squash(body.slice(h.span[1], Math.min(to, h.span[1] + MAX_LEAD_CHARS * 4))));
    const mark = "§".repeat(h.level + 1);
    parts.push(lead === "" ? `${mark} ${h.title}` : `${mark} ${h.title}: ${lead}`);
  });
  let out = "";
  for (const p of parts) {
    const next = out === "" ? p : `${out}\n${p}`;
    if (next.length > MAX_EXCERPT_CHARS) break;
    out = next;
  }
  return out;
}
