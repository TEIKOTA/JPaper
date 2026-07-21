// 契約付録 §3・§8。節ループの形式検査（決定的・LLM 非依存）。
import type { ResolvedTerm } from "../types/contract.js";

export interface FormalIssue {
  kind: "math" | "graphics" | "label" | "heading" | "paragraph" | "keep-original" | "bilingual";
  message: string;
}

const HEADING_CMDS = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];
// ひらがな・カタカナ（＋長音/記号ブロック）・CJK 漢字。見出しに日本語が1字でもあれば訳済み/併記とみなす。
const JAPANESE = /[぀-ヿ㐀-鿿]/;

// 未訳の見出しを返す: 日本語ゼロ かつ keep-original 語を除いても小文字 Latin が残るもの。
// 全大文字の略語（BLEU 等）・数字は小文字を含まないので除外。keep-original の固有名（Transformer 等）も除外。
function untranslatedHeadings(ja: string, keepOriginal: string[]): string[] {
  const found: string[] = [];
  for (const cmd of HEADING_CMDS) {
    for (const h of commandArgs(ja, cmd, false)) {
      if (JAPANESE.test(h)) continue; // 日本語あり＝訳済み or 併記
      let rest = h;
      for (const k of keepOriginal) if (k) rest = rest.split(k).join(" "); // 固有名/略語を除去
      if (/[a-z]/.test(rest)) found.push(h); // 小文字 Latin が残る＝未訳の可能性大
    }
  }
  return found;
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

// TeX 行コメント（偶数個のバックスラッシュに続く生の % から行末）を除去する。
// % でコメントアウトした \includegraphics/\label を誤認せず、\includegraphics%\n{a} の見逃しも防ぐ。
// \% は 1 個（奇数）＝エスケープなのでコメント扱いしない。\\%（偶数）は % 以降がコメント。
function stripLineComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
}

// 指定コマンドの {引数} を出現順に抽出する（行コメント除去済み・前空白/オプション・入れ子波括弧に頑健）。
// optArg=true で \cmd[opts]{arg} のオプションを飛ばす（\includegraphics 用）。直後に { を要求＝別コマンドを拾わない。
function commandArgs(text: string, cmd: string, optArg: boolean): string[] {
  const opt = optArg ? "(?:\\[[^\\]]*\\]\\s*)?" : "";
  const head = new RegExp(`\\\\${cmd}\\*?\\s*${opt}\\{`, "g");
  const stripped = stripLineComments(text);
  const args: string[] = [];
  for (let m = head.exec(stripped); m; m = head.exec(stripped)) {
    // マッチ末尾は開き { の直後。そこから平衡した閉じ } まで読む（入れ子対応）。
    let depth = 1;
    let i = head.lastIndex;
    const start = i;
    for (; i < stripped.length && depth > 0; i++) {
      const c = stripped[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth !== 0) break; // 未閉じ = これ以降に平衡した引数は存在しない（壊れた入力での O(n²) 再走査も断つ）
    args.push(stripped.slice(start, i - 1).trim());
    head.lastIndex = i; // 読み終えた引数の先へ進める
  }
  return args;
}

// multiset（並べ替えて要素比較）が一致するか。出現順の違いは無視し、脱落・置換・重複・増減を検出。
function multisetMismatch(src: string[], ja: string[]): boolean {
  if (src.length !== ja.length) return true;
  const a = [...src].sort();
  const b = [...ja].sort();
  return a.some((x, i) => x !== b[i]);
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
  const srcGfx = commandArgs(srcLatex, "includegraphics", true);
  const jaGfx = commandArgs(ja, "includegraphics", true);
  if (multisetMismatch(srcGfx, jaGfx)) {
    issues.push({
      kind: "graphics",
      message: `図(\\includegraphics)の不一致: src=[${srcGfx.join(", ")}] ja=[${jaGfx.join(", ")}]`,
    });
  }

  // \label の脱落は \ref を未解決にして build-gate を落とす。名前の multiset で保持を検証する。
  const srcLbl = commandArgs(srcLatex, "label", false);
  const jaLbl = commandArgs(ja, "label", false);
  if (multisetMismatch(srcLbl, jaLbl)) {
    issues.push({
      kind: "label",
      message: `\\label の不一致: src=[${srcLbl.join(", ")}] ja=[${jaLbl.join(", ")}]`,
    });
  }

  // 見出し引数の訳し忘れ（英語のまま残る）を決定的に捕捉して再訳させる。keep-original 固有名は除外。
  const keepOriginal = terms.filter((t) => t.rendering === "keep-original").map((t) => t.src);
  const untranslated = untranslatedHeadings(ja, keepOriginal);
  if (untranslated.length > 0) {
    issues.push({ kind: "heading", message: `見出し未訳: ${untranslated.join(" / ")}` });
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
