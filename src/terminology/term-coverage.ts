// 契約付録 §1（節に効く用語）。

const WORD = /[A-Za-z0-9]/;

// needle の出現位置。ラテン文字端の語は前後が英数字でない所だけを数え、末尾の複数形 s / es は同じ語とみなす。⚠ landmines.md
export function termOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  const headWord = WORD.test(needle[0]!);
  const tailWord = WORD.test(needle[needle.length - 1]!);
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (headWord && i > 0 && WORD.test(text[i - 1]!)) continue;
    let end = i + needle.length;
    if (tailWord) {
      if (text.startsWith("es", end) && !WORD.test(text[end + 2] ?? "")) end += 2;
      else if (text[end] === "s" && !WORD.test(text[end + 1] ?? "")) end += 1;
      if (WORD.test(text[end] ?? "")) continue;
    }
    out.push(i);
  }
  return out;
}

// 同じ扱いの用語のうち、別の語の複数形（末尾 s / es）にあたるものを除く。⚠ landmines.md
export function withoutPluralVariants<T extends { src: string; rendering?: string }>(terms: T[]): T[] {
  const bySrc = new Map(terms.map((t) => [t.src, t]));
  return terms.filter((t) => {
    for (const suffix of ["es", "s"]) {
      if (!t.src.endsWith(suffix)) continue;
      const base = bySrc.get(t.src.slice(0, -suffix.length));
      if (base && base.rendering === t.rendering) return false;
    }
    return true;
  });
}

// text に出現する語のうち、少なくとも 1 か所がより長い別の語の出現に含まれないものを返す。⚠ landmines.md
export function uncoveredTerms<T extends { src: string }>(text: string, terms: T[]): T[] {
  const spans = new Map<string, number[]>();
  for (const t of terms) {
    const occ = termOccurrences(text, t.src);
    if (occ.length > 0) spans.set(t.src, occ);
  }
  const present = terms.filter((t) => spans.has(t.src));
  return present.filter((t) => {
    const longer = present.filter((u) => u.src.length > t.src.length && u.src.includes(t.src));
    if (longer.length === 0) return true;
    return spans.get(t.src)!.some(
      (i) =>
        !longer.some((u) =>
          spans.get(u.src)!.some((j) => j <= i && i + t.src.length <= j + u.src.length),
        ),
    );
  });
}

// 各用語が uncoveredTerms で最初に効く節の id。
export function firstCoveringSegment<T extends { src: string }>(
  segments: { id: string; latex: string }[],
  terms: T[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const seg of segments) {
    for (const t of uncoveredTerms(seg.latex, terms)) if (!index.has(t.src)) index.set(t.src, seg.id);
  }
  return index;
}
