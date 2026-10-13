// 契約付録 §4（用語の検証）。issue #309。対象語の選び方と、検索結果の採否（決定的）。
import { MAX_TERM_CHARS } from "../runtime/untrusted.js";
import { MAX_VERIFY_TERMS, type TermCheck, type TermVerifyOut } from "../types/contract.js";
import type { ResolvedRow } from "./glossary-io.js";
import { canonicalBilingualForm } from "./bilingual-form.js";
import { isAcceptableTerm } from "./glossary.js";
import { rewriteStrings, termJa, type TermRewrite } from "./replace.js";

// 用例の表記として受け付ける長さと文字（かな・漢字・々・長音・中黒・英数字・空白・ハイフン）。
export const MAX_USAGE_FORM_CHARS = 40;
const USAGE_FORM = /^[぀-ヿ㐀-鿿々ー・A-Za-z0-9 \-]+$/;
const JAPANESE = /[぀-ヿ㐀-鿿々]/;
const LATIN_THEN_CJK = /([A-Za-z0-9])\s+(?=[぀-ヿ㐀-鿿々])/g;
const CJK_THEN_LATIN = /([぀-ヿ㐀-鿿々])\s+(?=[A-Za-z0-9])/g;

// 空白をまとめ、英数字と日本語の間の空白を除く（「Rashomon 集合」と「Rashomon集合」を同じ表記にする）。
export function normalizeUsage(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(LATIN_THEN_CJK, "$1").replace(CJK_THEN_LATIN, "$1");
}
// 訳を差し替えるのに要る、同じ表記を載せた異なるサイトの数。
export const MIN_REPLACE_SITES = 2;

export interface VerifyTarget {
  src: string;
  form: string;
}

const WORD = /[a-z0-9]/;

// needle の出現数。前後が英数字に続く出現（別の語の一部）は数えない。
function countIn(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : hay[at - 1]!;
    const after = hay[at + needle.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) n++;
  }
  return n;
}

// 検証する語。全体の用語 DB に承認済みの訳が無く、訳す（translate・bilingual）established・paper-defined の語。
// 本文の抜粋（abstract・見出し・各節の冒頭）に多く出る語から、同数なら paper-defined、用語集の順で MAX_VERIFY_TERMS 語。
export function verifyTargets(
  resolved: readonly ResolvedRow[],
  excerpt: string,
  hasConfirmed: (src: string) => boolean,
): VerifyTarget[] {
  const lower = excerpt.toLowerCase();
  return resolved
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        (r.class === "established" || r.class === "paper-defined") &&
        (r.rendering === "translate" || r.rendering === "bilingual") &&
        isAcceptableTerm(r.src) &&
        !hasConfirmed(r.src),
    )
    .map(({ r, i }) => ({ r, i, hits: countIn(lower, r.src.toLowerCase()) }))
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        Number(b.r.class === "paper-defined") - Number(a.r.class === "paper-defined") ||
        a.i - b.i,
    )
    .slice(0, MAX_VERIFY_TERMS)
    .map(({ r }) => ({ src: r.src, form: r.form }));
}

// 用例の表記として使えるか（長さ・使える文字・日本語を含む）。空白は normalizeUsage でまとめる。
export function usableForm(form: string | undefined): string | undefined {
  if (form === undefined) return undefined;
  const s = normalizeUsage(form);
  if (s === "" || s.length > MAX_USAGE_FORM_CHARS) return undefined;
  if (!USAGE_FORM.test(s) || !JAPANESE.test(s)) return undefined;
  return s;
}

// https の URL と、そのホスト名（先頭の www. を除く）。
function siteOf(url: string): { url: string; site: string } | undefined {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" || u.hostname === "") return undefined;
    return { url: u.toString(), site: u.hostname.toLowerCase().replace(/^www\./, "") };
  } catch {
    return undefined;
  }
}

interface Usage {
  form: string;
  sites: Map<string, string>;
}

// 1 語の候補を、表記ごとに「引用にその表記がそのまま含まれる https の出典」のサイトへまとめる。サイトの多い順。
function usagesOf(candidates: TermVerifyOut["terms"][number]["candidates"]): Usage[] {
  const byForm = new Map<string, Usage>();
  for (const c of candidates) {
    const form = usableForm(c.form);
    if (form === undefined) continue;
    const usage = byForm.get(form) ?? { form, sites: new Map<string, string>() };
    for (const s of c.sources) {
      const at = siteOf(s.url);
      if (at !== undefined && normalizeUsage(s.quote).includes(form) && !usage.sites.has(at.site)) usage.sites.set(at.site, at.url);
    }
    if (usage.sites.size > 0) byForm.set(form, usage);
  }
  return [...byForm.values()].sort((a, b) => b.sites.size - a.sites.size);
}

export interface Verified<T, B, S> {
  resolved: T[];
  brief: B;
  style: S;
  checks: TermCheck[];
}

// 検索結果を用語集へ当てる。異なるサイトの数が最も多い表記を採り、最多が並べば未確認（conflicting）。
// 採った表記が用語集の訳（併記形は日本語部分）と同じなら confirmed。違えば MIN_REPLACE_SITES 以上の
// サイトにあるときだけ差し替えて replaced（足りなければ few-sites）。同じ元の訳の語どうしで採った表記が
// 違えば、サイトの最も多い表記の語を採り、ほかは conflicting（最多が並べば全て conflicting）。
// 差し替えた元の訳は、ほかの語の訳（それを含む語・同じ訳の語。keep-original と confirmed の語は除く）・
// brief・style・各語の訳注でも書き換え、書き換えた語の check に via と元の訳を付ける。
export function applyVerification<T extends ResolvedRow, B, S>(
  ctx: { resolved: readonly T[]; brief: B; style: S },
  targets: readonly VerifyTarget[],
  out: TermVerifyOut,
): Verified<T, B, S> {
  const key = (src: string): string => src.trim().toLowerCase();
  const bySrc = new Map<string, TermVerifyOut["terms"][number]>();
  for (const t of out.terms) if (!bySrc.has(key(t.src))) bySrc.set(key(t.src), t);
  type Found = { row: T; current: string; newJa: string; form: string; sites: number; sources: string[] };
  const decided: ({ row: T; reason: TermCheck["reason"] } | Found)[] = [];
  for (const target of targets) {
    const row = ctx.resolved.find((r) => r.src === target.src);
    if (row === undefined) continue;
    const current = termJa(row) ?? row.form;
    const [best, second] = usagesOf(bySrc.get(key(target.src))?.candidates ?? []);
    if (best === undefined) {
      decided.push({ row, reason: "not-found" });
      continue;
    }
    if (second !== undefined && second.sites.size === best.sites.size) {
      decided.push({ row, reason: "conflicting" });
      continue;
    }
    const sources = [...best.sites.values()];
    if (best.form === current) {
      decided.push({ row, current, newJa: current, form: row.form, sites: best.sites.size, sources });
      continue;
    }
    const replaced =
      row.rendering === "bilingual" ? canonicalBilingualForm(`${best.form}(${row.src})`, row.src) : best.form;
    if (best.sites.size < MIN_REPLACE_SITES || replaced.length > MAX_TERM_CHARS) {
      decided.push({ row, reason: "few-sites" });
      continue;
    }
    decided.push({ row, current, newJa: best.form, form: replaced, sites: best.sites.size, sources });
  }
  // 元の訳ごとに採る表記（サイトの最も多い表記。並べば無し）。
  const winner = new Map<string, string | undefined>();
  const most = new Map<string, number>();
  for (const d of decided) {
    if (!("newJa" in d)) continue;
    const top = most.get(d.current) ?? 0;
    if (d.sites > top) {
      most.set(d.current, d.sites);
      winner.set(d.current, d.newJa);
    } else if (d.sites === top && winner.get(d.current) !== d.newJa) {
      winner.set(d.current, undefined);
    }
  }
  const checks: TermCheck[] = [];
  const next = new Map<string, string>();
  // 元の訳 → 新しい訳と、差し替えを決めた語。
  const rewrites = new Map<string, { newJa: string; src: string }>();
  const confirmedJa: { src: string; ja: string }[] = [];
  for (const d of decided) {
    if (!("newJa" in d)) {
      checks.push({ src: d.row.src, status: "unverified", form: d.row.form, reason: d.reason, sources: [] });
    } else if (winner.get(d.current) !== d.newJa) {
      checks.push({ src: d.row.src, status: "unverified", form: d.row.form, reason: "conflicting", sources: [] });
    } else if (d.newJa === d.current) {
      checks.push({ src: d.row.src, status: "confirmed", form: d.row.form, sources: d.sources });
      confirmedJa.push({ src: d.row.src, ja: d.current });
    } else {
      next.set(d.row.src, d.form);
      checks.push({ src: d.row.src, status: "replaced", form: d.form, original: d.row.form, sources: d.sources });
      if (!rewrites.has(d.current)) rewrites.set(d.current, { newJa: d.newJa, src: d.row.src });
    }
  }
  // 長い元の訳から当てる（短い訳が長い訳の一部を先に書き換えないように）。先に当てた新しい訳は、後の書き換えから守る。
  const order: { rule: TermRewrite; src: string }[] = [];
  for (const [oldJa, r] of [...rewrites.entries()].sort((a, b) => b[0].length - a[0].length)) {
    const shields = [...order.map((o) => ({ src: o.src, ja: o.rule.newJa })), ...confirmedJa].filter(
      (sh) => sh.ja !== oldJa && sh.ja.includes(oldJa),
    );
    order.push({ rule: { oldJa, newJa: r.newJa, shields }, src: r.src });
  }
  let brief = ctx.brief;
  let style = ctx.style;
  const resolved = ctx.resolved.map((r) => {
    const own = next.get(r.src);
    if (own !== undefined) return { ...r, form: own };
    const ja = termJa(r);
    if (ja === undefined || ja === "") return { ...r };
    let changed = ja;
    let via: string | undefined;
    for (const { rule, src } of order) {
      const after = rewriteStrings(changed, rule);
      if (after !== changed) via ??= src;
      changed = after;
    }
    if (via === undefined) return { ...r };
    const form = r.rendering === "bilingual" ? canonicalBilingualForm(`${changed}(${r.src})`, r.src) : changed;
    if (form.length > MAX_TERM_CHARS) return { ...r };
    const own2 = checks.findIndex((c) => c.src === r.src);
    if (own2 !== -1) checks[own2] = { ...checks[own2]!, form, original: r.form, via };
    else checks.push({ src: r.src, status: "replaced", form, original: r.form, via, sources: [] });
    return { ...r, form };
  });
  for (const { rule } of order) {
    brief = rewriteStrings(brief, rule);
    style = rewriteStrings(style, rule);
  }
  return {
    resolved: resolved.map((row) =>
      row.note === undefined ? row : { ...row, note: order.reduce((n, { rule }) => rewriteStrings(n, rule), row.note) },
    ),
    brief,
    style,
    checks,
  };
}

// 対象語の検証の結果か（ほかの語の差し替えに揃えただけの語でないか）。
export function isTargetCheck(c: TermCheck): boolean {
  return c.status !== "replaced" || c.via === undefined;
}

// 前の run の検証の結果のうち、今の用語集の行と訳が同じままの未確認の語（人が直した語は除く）。
export function carriedUnverified(rows: readonly ResolvedRow[], checks: readonly TermCheck[]): TermCheck[] {
  const formOf = new Map(rows.map((r) => [r.src, r.form]));
  return checks.filter((c) => c.status === "unverified" && formOf.get(c.src) === c.form);
}
