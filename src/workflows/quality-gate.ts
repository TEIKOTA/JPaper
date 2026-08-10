// 契約付録 §3・§8。節ループの形式検査（決定的・LLM 非依存）。
import type { ResolvedTerm } from "../types/contract.js";

export interface FormalIssue {
  kind:
    | "math"
    | "graphics"
    | "label"
    | "paragraph"
    | "keep-original"
    | "bilingual"
    | "untranslated"
    | "unsafe-command";
  message: string;
}

// 未翻訳と断ずるのに必要な地の文の語数。数式・図だけの節を誤検知しないための下限。
const MIN_PROSE_WORDS = 12;

// ^^ 記法の展開は組版側の検査と同一実装を使う（正本は tools/tex-safety.ts）。
export { decodeCarets } from "../tools/tex-safety.js";
import { decodeCarets as decode } from "../tools/tex-safety.js";

// 実行・入出力に触れる制御綴り。訳文が原文に無いこれらを持ち込むのは翻訳ではない。
const UNSAFE_COMMANDS = [
  "directlua",
  "latelua",
  "luaescapestring",
  "write", // \write18 は \write の 18 番ストリーム。番号は綴りに含まれない。
  "immediate",
  "openout",
  "openin",
  "read",
  "catcode",
  "csname",
  "expandafter",
  "special",
  "shellescape",
  "ShellEscape",
  "usepackage",
  "RequirePackage",
  "input",
  "include",
  "documentclass",
  "makeatletter",
];

function usedCommands(tex: string): Set<string> {
  const found = new Set<string>();
  for (const m of decode(tex).matchAll(/\\([a-zA-Z]+)/g)) found.add(m[1]!);
  return found;
}

// 訳文が持ち込んだ危険コマンド（原文にあるものは翻訳者の仕業ではないので対象外）。
export function introducedUnsafeCommands(srcLatex: string, ja: string): string[] {
  const inSrc = usedCommands(srcLatex);
  const inJa = usedCommands(ja);
  return UNSAFE_COMMANDS.filter((c) => inJa.has(c) && !inSrc.has(c));
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// 訳さないのが正しい環境。参考文献の著者名・論題やコードリストを「地の文」と数えると、
// 忠実な訳ほど日本語比率が下がって untranslated が必ず発火する（実測: 30 件の
// thebibliography でラテン語 422 語と判定され、revision を使い切って exit 3）。
const NON_PROSE_ENVS = ["thebibliography", "verbatim", "lstlisting", "minted", "alltt"];

// 環境ごとに左から 1 回だけ走査する（閉じが無ければ以降のどの開始位置でも見つからない）。
// 正規表現の遅延一致だと閉じない \begin が並ぶ入力で二次になる。
function stripNonProseEnvs(tex: string): string {
  let out = tex;
  for (const env of NON_PROSE_ENVS) {
    const open = `\\begin{${env}}`;
    const close = `\\end{${env}}`;
    let acc = "";
    let pos = 0;
    for (;;) {
      const start = out.indexOf(open, pos);
      if (start === -1) break;
      const endAt = out.indexOf(close, start + open.length);
      if (endAt === -1) break;
      acc += `${out.slice(pos, start)} `;
      pos = endAt + close.length;
    }
    if (pos > 0) out = acc + out.slice(pos);
  }
  return out;
}

// 制御綴りと記号を線形時間で落として地の文だけを残す（壊れた入力でも O(n)）。
function proseOf(tex: string): string {
  return stripNonProseEnvs(tex)
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}[\]$&%#_^~\\]/g, " ");
}

// 3 文字以上のラテン語の語数。数式記号や略号を「地の文」と数えないための近似。
function proseWordCount(tex: string): number {
  return (proseOf(tex).match(/[A-Za-z]{3,}/g) ?? []).length;
}

function japaneseCharCount(tex: string): number {
  return (proseOf(tex).match(/[ぁ-ゖァ-ヺー㐀-鿿ｦ-ﾝ]/g) ?? []).length;
}

const HEADING_CMDS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
// ひらがな・カタカナ（letters のみ・長音 ー=30FC を含む／中黒 ・=30FB は除外）・CJK 漢字・半角カタカナ。
// 1字でもあれば訳済み/併記とみなす。中黒を除くのは「Encoder・Decoder」を訳済みと誤認しないため。
const JAPANESE = /[ぁ-ゖァ-ヺー㐀-鿿ｦ-ﾝ]/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 見出し引数から可視テキストを取り出す（数式・参照系・制御綴り・波括弧を除去）。
// $p$ や \textsc/\emph の綴り、\ref{...} の不可視引数を「未訳の地の文」と誤認しないため。
function visibleText(s: string): string {
  return s
    .replace(/\$\$[\s\S]*?\$\$/g, " ") // $$...$$
    .replace(/\$[^$]*\$/g, " ") // $...$
    .replace(/\\\([\s\S]*?\\\)/g, " ") // \(...\)
    .replace(/\\\[[\s\S]*?\\\]/g, " ") // \[...\]
    .replace(/\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, " ") // 図: オプション込みで引数ごと除去
    .replace(/\\(?:eqref|autoref|pageref|cref|Cref|ref|label|cite[a-zA-Z]*|url|nolinkurl|path|href|input|include)\s*\{[^}]*\}/g, " ") // 参照系・URL・パス系は不可視引数ごと除去
    .replace(/\\[a-zA-Z]+\*?/g, " ") // 残る制御綴り名（\textsc 等）は名前だけ除去し可視な引数は残す
    .replace(/[{}]/g, " "); // 波括弧
}

// 未訳見出しを返す（非ブロッキング lint→heading-untranslated 訳注）: 可視テキストが日本語ゼロ かつ
// keep-original 語を語境界で除いても小文字 Latin が残るもの。全大文字略語・数字は小文字を含まず除外。
// 契約付録 §8（訳注生成契約 ④）。⚠ landmines.md
export function untranslatedHeadings(ja: string, keepOriginal: string[]): string[] {
  const found: string[] = [];
  for (const cmd of HEADING_CMDS) {
    // optArg=true で \section[短縮見出し]{本見出し} のオプション引数を飛ばして本引数を取る。
    for (const h of commandArgs(ja, cmd, true)) {
      let vis = visibleText(h);
      if (JAPANESE.test(vis)) continue; // 日本語あり＝訳済み or 併記
      for (const k of keepOriginal) {
        if (k) vis = vis.replace(new RegExp(`(?<![A-Za-z])${escapeRe(k)}(?![A-Za-z])`, "g"), " ");
      }
      if (/[a-z]/.test(vis)) found.push(h); // 小文字 Latin が残る＝未訳の可能性大
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

  // LLM の判定に依存しない下限。evaluator が汚染されても素通しさせない。
  const unsafe = introducedUnsafeCommands(srcLatex, ja);
  if (unsafe.length > 0) {
    issues.push({
      kind: "unsafe-command",
      message: `訳文が原文に無い危険コマンドを持ち込んだ: ${unsafe.map((c) => `\\${c}`).join(", ")}`,
    });
  }

  // 地の文が十分ある節でのみ判定する（数式・図だけの節は原文と一致しても正常）。
  // 「日本語がゼロか」ではなく割合で見る。1 文字だけ混ぜて検査を通す回避を塞ぐため。
  const words = proseWordCount(ja);
  if (words >= MIN_PROSE_WORDS && japaneseCharCount(ja) < words) {
    const identical = normalizeForCompare(srcLatex) === normalizeForCompare(ja);
    issues.push({
      kind: "untranslated",
      message: identical
        ? "訳文が原文と同一（未翻訳）"
        : `地の文に日本語が無い（未翻訳の疑い・ラテン語 ${words} 語）`,
    });
  }

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
