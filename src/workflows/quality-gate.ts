// 契約付録 §3・§8。節ループの形式検査（決定的・LLM 非依存）。
import type { ResolvedTerm } from "../types/contract.js";

export interface FormalIssue {
  kind: "math" | "graphics" | "paragraph" | "keep-original" | "bilingual";
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

// TeX 行コメント（エスケープされていない % から行末）を除去する。
// これで % でコメントアウトした \includegraphics を図と誤認せず、\includegraphics%\n{a} の見逃しも防ぐ。
function stripLineComments(text: string): string {
  return text.replace(/(?<!\\)%.*$/gm, "");
}

// \includegraphics のファイルパス引数を出現順に抽出する。
// オプション有無・* ・前空白・行コメントに頑健。直後に {path} を要求するため \includegraphicsbox 等は拾わない。
function graphicsPaths(text: string): string[] {
  const re = /\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripLineComments(text))) !== null) paths.push(m[1]!.trim());
  return paths;
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

  // 図はパスの multiset で照合する（個数一致だけでは {a},{b}→{a},{a} の置換=b脱落を見逃すため）。
  const srcGfx = graphicsPaths(srcLatex).sort();
  const jaGfx = graphicsPaths(ja).sort();
  if (srcGfx.length !== jaGfx.length || srcGfx.some((p, i) => p !== jaGfx[i])) {
    issues.push({
      kind: "graphics",
      message: `図(\\includegraphics)の不一致: src=[${srcGfx.join(", ")}] ja=[${jaGfx.join(", ")}]`,
    });
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
      const combined = /[（(][^）)]*[A-Za-z][^）)]*[）)]/.test(t.form); // 括弧内に原語(ラテン文字)を含む併記形か
      if (t.firstOccurrence) {
        if (!ja.includes(t.form)) {
          issues.push({ kind: "bilingual", message: `初出の併記形が無い: ${t.form}` });
        }
      } else if (combined && ja.includes(t.form)) {
        // 併記形を持つ語のみ「2回目以降は日本語のみ」を要求（括弧無しは誤検知しない）。
        issues.push({ kind: "bilingual", message: `2回目以降に併記形: ${t.form}` });
      }
    }
  }

  return issues;
}
