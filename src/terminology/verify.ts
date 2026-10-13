// 契約付録 §4（用語の検証）。issue #309。対象語の選び方と、検索結果の採否（決定的）。
import { MAX_TERM_CHARS } from "../runtime/untrusted.js";
import { MAX_VERIFY_TERMS, type TermCheck, type TermVerifyOut } from "../types/contract.js";
import type { ResolvedRow } from "./glossary-io.js";
import { canonicalBilingualForm } from "./bilingual-form.js";
import { isAcceptableTerm } from "./glossary.js";
import { rewriteStrings, sameJaTerms, shieldsFor, termJa, type TermRewrite } from "./replace.js";

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
  // 差し替えた訳を含む・同じ訳を持つほかの語（書き換えずに元の訳のまま残る）。
  kept: { src: string; form: string; original: string }[];
}

// 検索結果を用語集へ当てる。異なるサイトの数が最も多い表記を採り、最多が並べば未確認（conflicting）。
// 採った表記が用語集の訳（併記形は日本語部分）と同じなら confirmed。違えば MIN_REPLACE_SITES 以上の
// サイトにあるときだけ差し替えて replaced（足りなければ few-sites）。差し替えた訳は、ほかの語の訳に
// 含まれる箇所を除いて、brief・style・各語の訳注でも書き換える。
export function applyVerification<T extends ResolvedRow, B, S>(
  ctx: { resolved: readonly T[]; brief: B; style: S },
  targets: readonly VerifyTarget[],
  out: TermVerifyOut,
): Verified<T, B, S> {
  const key = (src: string): string => src.trim().toLowerCase();
  const bySrc = new Map<string, TermVerifyOut["terms"][number]>();
  for (const t of out.terms) if (!bySrc.has(key(t.src))) bySrc.set(key(t.src), t);
  const checks: TermCheck[] = [];
  const next = new Map<string, string>();
  const rewrites: TermRewrite[] = [];
  const kept: Verified<T, B, S>["kept"] = [];
  for (const target of targets) {
    const row = ctx.resolved.find((r) => r.src === target.src);
    if (row === undefined) continue;
    const current = termJa(row) ?? row.form;
    const unverified = (reason: TermCheck["reason"]): void => {
      checks.push({ src: row.src, status: "unverified", form: row.form, reason, sources: [] });
    };
    const [best, second] = usagesOf(bySrc.get(key(target.src))?.candidates ?? []);
    if (best === undefined) {
      unverified("not-found");
      continue;
    }
    if (second !== undefined && second.sites.size === best.sites.size) {
      unverified("conflicting");
      continue;
    }
    const sources = [...best.sites.values()];
    if (best.form === current) {
      checks.push({ src: row.src, status: "confirmed", form: row.form, sources });
      continue;
    }
    const replaced =
      row.rendering === "bilingual" ? canonicalBilingualForm(`${best.form}(${row.src})`, row.src) : best.form;
    if (best.sites.size < MIN_REPLACE_SITES || replaced.length > MAX_TERM_CHARS) {
      unverified("few-sites");
      continue;
    }
    next.set(row.src, replaced);
    checks.push({ src: row.src, status: "replaced", form: replaced, original: row.form, sources });
    const shields = shieldsFor(ctx.resolved, row.src, current);
    rewrites.push({ oldJa: current, newJa: best.form, shields });
    for (const s of shields) kept.push({ src: s.src, form: s.ja, original: current });
    for (const src of sameJaTerms(ctx.resolved, row.src, current)) kept.push({ src, form: current, original: current });
  }
  let brief = ctx.brief;
  let style = ctx.style;
  let resolved = ctx.resolved.map((r) => {
    const form = next.get(r.src);
    return form === undefined ? { ...r } : { ...r, form };
  });
  for (const r of rewrites) {
    brief = rewriteStrings(brief, r);
    style = rewriteStrings(style, r);
    resolved = resolved.map((row) => (row.note === undefined ? row : { ...row, note: rewriteStrings(row.note, r) }));
  }
  return { resolved, brief, style, checks, kept };
}

// 前の run の検証の結果のうち、今の用語集の行と訳が同じままの未確認の語（人が直した語は除く）。
export function carriedUnverified(rows: readonly ResolvedRow[], checks: readonly TermCheck[]): TermCheck[] {
  const formOf = new Map(rows.map((r) => [r.src, r.form]));
  return checks.filter((c) => c.status === "unverified" && formOf.get(c.src) === c.form);
}
