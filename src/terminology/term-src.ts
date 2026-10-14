// 契約付録 §8。用語の src の末尾の句読点を落とす。略語の一部であるピリオドは残す。
import type { ResolvedTerm } from "../types/contract.js";

const TRAILING_MARK = new Set([",", ":", ";", "。", "．", "、", "，", "：", "；"]);

const ABBREVIATIONS = new Set([
  "al",
  "etc",
  "vs",
  "cf",
  "viz",
  "approx",
  "resp",
  "acc",
  "avg",
  "std",
  "fig",
  "figs",
  "eq",
  "eqs",
  "sec",
  "secs",
  "no",
  "nos",
  "vol",
  "pp",
  "ch",
  "def",
  "thm",
  "prop",
  "lem",
  "cor",
  "alg",
  "ref",
  "refs",
  "ed",
  "eds",
  "est",
  "misc",
  "inc",
  "ltd",
  "co",
  "corp",
  "jr",
  "sr",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "st",
  "dept",
  "univ",
]);

// 末尾の `.` が略語の一部か。e.g. / i.e. / Ph.D. / J.T.S.（字と点の連なり）、イニシャル（E.）、固定の略語の一覧。
function endsWithAbbreviation(s: string): boolean {
  let i = s.length - 1;
  while (i > 0 && /[A-Za-z.]/.test(s[i - 1]!)) i--;
  const word = s.slice(i, -1);
  if (word === "") return false;
  if (/^(?:[A-Za-z]{1,4}\.)+[A-Za-z]{1,4}$/.test(word)) return true;
  if (/^[A-Za-z]$/.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

export function trimTermPunctuation(src: string): string {
  let s = src.trimEnd();
  for (;;) {
    const last = s.at(-1);
    if (last === undefined) return s;
    if (TRAILING_MARK.has(last) || (last === "." && !endsWithAbbreviation(s))) {
      s = s.slice(0, -1).trimEnd();
      continue;
    }
    return s;
  }
}

// src の末尾の句読点を落とし、落とした語は form の末尾の句読点も落とす。同じ src になった語は先の 1 つを残す。
export function normalizeTermSrcs<T extends Pick<ResolvedTerm, "src" | "form">>(terms: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of terms) {
    const src = trimTermPunctuation(t.src);
    if (src === "" || seen.has(src)) continue;
    seen.add(src);
    if (src === t.src) {
      out.push(t);
      continue;
    }
    const form = trimTermPunctuation(t.form);
    out.push({ ...t, src, form: form === "" ? src : form });
  }
  return out;
}
