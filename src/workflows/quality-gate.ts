// 契約付録 §3・§8。節ループの形式検査（決定的・LLM 非依存）。
import type { ResolvedTerm } from "../types/contract.js";

export interface FormalIssue {
  kind: "math" | "paragraph" | "keep-original" | "bilingual";
  message: string;
}

const MATH_ENVS = [
  "equation",
  "align",
  "gather",
  "multline",
  "eqnarray",
  "alignat",
  "flalign",
  "math",
  "displaymath",
];

function countMath(text: string): number {
  const dollars = (text.match(/(?<!\\)\$/g) ?? []).length;
  const open = (text.match(/(?<!\\)\\\[/g) ?? []).length;
  const close = (text.match(/(?<!\\)\\\]/g) ?? []).length;
  const envRe = new RegExp(`\\\\begin\\{(?:${MATH_ENVS.join("|")})\\*?\\}`, "g");
  const envs = (text.match(envRe) ?? []).length;
  return dollars + open + close + envs;
}

function countParagraphs(text: string): number {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "").length;
}

function countOccurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function formalCheck(
  srcLatex: string,
  ja: string,
  terms: ResolvedTerm[],
): FormalIssue[] {
  const issues: FormalIssue[] = [];

  const srcMath = countMath(srcLatex);
  const jaMath = countMath(ja);
  if (srcMath !== jaMath) {
    issues.push({ kind: "math", message: `数式個数不一致: src=${srcMath} ja=${jaMath}` });
  }

  const srcPar = countParagraphs(srcLatex);
  const jaPar = countParagraphs(ja);
  if (jaPar > srcPar) {
    issues.push({ kind: "paragraph", message: `段落水増し: src=${srcPar} ja=${jaPar}` });
  } else if (srcPar > 0 && jaPar < srcPar * 0.5) {
    issues.push({ kind: "paragraph", message: `段落欠落: src=${srcPar} ja=${jaPar}` });
  }

  for (const t of terms) {
    if (t.rendering === "keep-original") {
      const srcN = countOccurrences(srcLatex, t.src);
      const jaN = countOccurrences(ja, t.src);
      if (jaN < srcN) {
        issues.push({
          kind: "keep-original",
          message: `keep-original 未保持: ${t.src} src=${srcN} ja=${jaN}`,
        });
      }
    } else if (t.rendering === "bilingual") {
      if (t.firstOccurrence && !ja.includes(t.form)) {
        issues.push({ kind: "bilingual", message: `初出の併記形が無い: ${t.form}` });
      } else if (!t.firstOccurrence && ja.includes(t.form)) {
        issues.push({ kind: "bilingual", message: `2回目以降に併記形: ${t.form}` });
      }
    }
  }

  return issues;
}
