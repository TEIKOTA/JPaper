// 契約付録 §9。用語集の訳語の編集をコードの置換で本文へ反映する（LLM を使わない）。
import { MAX_TERM_CHARS } from "../runtime/untrusted.js";
import { canonicalBilingualForm, jaPartOf } from "./bilingual-form.js";
import type { ResolvedRow } from "./glossary-io.js";

// 訳文に現れる訳語。bilingual は併記形の日本語部分、translate は form、keep-original は訳語を持たない。
export function termJa(row: Pick<ResolvedRow, "form" | "rendering">): string | undefined {
  if (row.rendering === "bilingual") return jaPartOf(row.form);
  if (row.rendering === "translate") return row.form;
  return undefined;
}

export function isEditable(row: Pick<ResolvedRow, "form" | "rendering">): boolean {
  const ja = termJa(row);
  return ja !== undefined && ja !== "";
}

// 訳語に使えない文字。表の区切り・改行と、組版で意味を持つ文字。
const FORBIDDEN = /[|\r\n\\{}$%&#^_~]/;

// 新しい訳語の入力を検査する。問題が無ければ undefined。
export function validateTermJa(ja: string): string | undefined {
  if (ja.trim() === "") return "訳語が空です";
  if (ja.length > MAX_TERM_CHARS) return `訳語は ${String(MAX_TERM_CHARS)} 文字以内にしてください`;
  if (FORBIDDEN.test(ja)) return "訳語に使えない文字（| 改行 \\ { } $ % & # ^ _ ~）が含まれています";
  return undefined;
}

export interface EditedForm {
  form: string;
  ja: string;
}

// 入力された訳語から新しい form を作る。bilingual は「訳(原語)」で原語は src の綴り、translate は訳だけ。
export function editedForm(row: Pick<ResolvedRow, "src" | "rendering">, input: string): EditedForm {
  const ja = jaPartOf(input.trim()) || input.trim();
  if (row.rendering === "bilingual") return { form: canonicalBilingualForm(ja, row.src), ja };
  return { form: ja, ja };
}

export interface Shield {
  src: string;
  ja: string;
}

// 直す訳語を含む、ほかの語の訳語（例: 「ラショモン集合」に対する「経験的ラショモン集合」）。
export function shieldsFor(rows: readonly ResolvedRow[], src: string, oldJa: string): Shield[] {
  const out: Shield[] = [];
  for (const r of rows) {
    if (r.src === src) continue;
    const ja = termJa(r) ?? r.form;
    if (ja !== oldJa && ja.includes(oldJa)) out.push({ src: r.src, ja });
  }
  return out;
}

// 直す訳語と同じ訳語を持つ、ほかの語。
export function sameJaTerms(rows: readonly ResolvedRow[], src: string, oldJa: string): string[] {
  return rows.filter((r) => r.src !== src && termJa(r) === oldJa).map((r) => r.src);
}

export interface Occurrence {
  start: number;
  end: number;
  // ほかの語の訳語の一部なら、その語の src。置換しない。
  shieldedBy?: string;
}

function indicesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

export function findOccurrences(text: string, oldJa: string, shields: readonly Shield[]): Occurrence[] {
  const covered: { start: number; end: number; src: string }[] = [];
  for (const s of shields) {
    for (const i of indicesOf(text, s.ja)) covered.push({ start: i, end: i + s.ja.length, src: s.src });
  }
  return indicesOf(text, oldJa).map((start) => {
    const end = start + oldJa.length;
    const by = covered.find((c) => c.start <= start && end <= c.end);
    return by === undefined ? { start, end } : { start, end, shieldedBy: by.src };
  });
}

export function replaceOccurrences(text: string, occs: readonly Occurrence[], newJa: string): string {
  let out = "";
  let at = 0;
  for (const o of occs) {
    if (o.shieldedBy !== undefined) continue;
    out += text.slice(at, o.start) + newJa;
    at = o.end;
  }
  return out + text.slice(at);
}

export interface TermRewrite {
  oldJa: string;
  newJa: string;
  shields: Shield[];
}

export function rewriteText(text: string, r: TermRewrite): string {
  return replaceOccurrences(text, findOccurrences(text, r.oldJa, r.shields), r.newJa);
}

// brief.md・style.md の本文だけを書き換える。見出し行と「- キー:」のキーは parseBriefMd / parseStyleMd が
// 節や項目を探す目印なので書き換えない（書き換えると主張の核や数字・単位の規約が読めなくなる）。
export function rewriteMdBody(md: string, r: TermRewrite, keyed: boolean): string {
  return md
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("#")) return line;
      const m = keyed ? /^(\s*-\s+[^:]+:\s?)(.*)$/.exec(line) : null;
      return m === null ? rewriteText(line, r) : m[1]! + rewriteText(m[2]!, r);
    })
    .join("\n");
}

// 値の中の文字列をすべて書き換える（キーは書き換えない）。
export function rewriteStrings<T>(value: T, r: TermRewrite): T {
  if (typeof value === "string") return rewriteText(value, r) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteStrings(v, r)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, r)]),
    ) as T;
  }
  return value;
}

function cell(s: string): string {
  return s.replace(/[|\r\n]/g, " ").trim();
}

function renderRow(cells: string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

// glossary.md の src の行の form を差し替え、全行の訳注の訳語を書き換える。表の外と他の列は触らない。
export function rewriteGlossaryMd(md: string, src: string, form: string, r: TermRewrite): string {
  let edited = 0;
  const lines = md.split("\n").map((line) => {
    const m = /^\|(.+)\|$/.exec(line.trim());
    if (!m) return line;
    const cells = m[1]!.split("|").map((c) => c.trim());
    const head = cells[0];
    if (cells.length < 4 || !head || head === "原語" || /^-+$/.test(head)) return line;
    const next = [...cells];
    if (head === src) {
      next[1] = form;
      edited++;
    }
    if (next[4] !== undefined) next[4] = rewriteText(next[4], r);
    return next.every((c, i) => c === cells[i]) ? line : renderRow(next);
  });
  if (edited !== 1) throw new Error(`glossary.md に ${src} の行が ${String(edited)} 行あります`);
  return lines.join("\n");
}
