// 契約付録 §4（用語の検証）。issue #309。対象語の選び方と、検索結果の採否（決定的）。
import { MAX_VERIFY_TERMS, type TermCheck, type TermVerifyOut } from "../types/contract.js";
import type { ResolvedRow } from "./glossary-io.js";
import { canonicalBilingualForm, jaPartOf } from "./bilingual-form.js";
import { isAcceptableTerm } from "./glossary.js";
import { oneLine } from "../runtime/untrusted.js";

// 用例の表記として受け付ける長さ。
export const MAX_USAGE_FORM_CHARS = 80;
const JAPANESE = /[぀-ヿ㐀-鿿]/;
// LaTeX・表の区切り・山括弧として働く文字。用例の表記には受け付けない。
const MARKUP = /[\\{}$%#&^_~|<>`]/;

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

// 用例の表記として使えるか（1 行・長さ・日本語を含む・マークアップの文字を含まない）。
export function usableForm(form: string | undefined): string | undefined {
  if (form === undefined) return undefined;
  const s = form.trim();
  if (s === "" || s !== oneLine(s, MAX_USAGE_FORM_CHARS)) return undefined;
  if (!JAPANESE.test(s) || MARKUP.test(s)) return undefined;
  return s;
}

function httpsUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname !== "" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// 検索結果を用語集へ当てる。found で、https の出典の引用にその表記がそのまま含まれるものが 1 件以上あれば採る。
// 用語集の訳（併記形は日本語部分）と同じなら confirmed、違えば用例の表記へ差し替えて replaced。
// それ以外（not-found・conflicting・出典の条件を満たさない・応答に無い）は unverified で、訳は変えない。
export function applyVerification<T extends ResolvedRow>(
  resolved: readonly T[],
  targets: readonly VerifyTarget[],
  out: TermVerifyOut,
): { resolved: T[]; checks: TermCheck[] } {
  const bySrc = new Map<string, TermVerifyOut["terms"][number]>();
  const key = (src: string): string => src.trim().toLowerCase();
  for (const t of out.terms) if (!bySrc.has(key(t.src))) bySrc.set(key(t.src), t);
  const checks: TermCheck[] = [];
  const next = new Map<string, string>();
  for (const target of targets) {
    const row = resolved.find((r) => r.src === target.src);
    if (row === undefined) continue;
    const current = row.rendering === "bilingual" ? jaPartOf(row.form) : row.form;
    const hit = bySrc.get(key(target.src));
    const form = hit?.status === "found" ? usableForm(hit.form) : undefined;
    const sources =
      form === undefined
        ? []
        : hit!.sources.flatMap((s) => {
            const url = httpsUrl(s.url);
            return url !== undefined && s.quote.includes(form) ? [url] : [];
          });
    if (form === undefined || sources.length === 0) {
      checks.push({ src: row.src, status: "unverified", form: row.form, sources: [] });
    } else if (form === current) {
      checks.push({ src: row.src, status: "confirmed", form: row.form, sources });
    } else {
      const replaced = row.rendering === "bilingual" ? canonicalBilingualForm(`${form}(${row.src})`, row.src) : form;
      next.set(row.src, replaced);
      checks.push({ src: row.src, status: "replaced", form: replaced, original: row.form, sources });
    }
  }
  return {
    resolved: resolved.map((r) => {
      const form = next.get(r.src);
      return form === undefined ? { ...r } : { ...r, form };
    }),
    checks,
  };
}
