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
    | "reference"
    | "symbol-command"
    | "unsafe-command"
    | "structure"
    | "title";
  message: string;
}

// 未翻訳と断ずるのに必要な地の文の語数。数式・図だけの節を誤検知しないための下限。
const MIN_PROSE_WORDS = 12;
// 原文 1 語あたり最低限期待する訳文の日本語文字数。実訳は 1 語 ≒ 1.5〜2.5 文字なので、
// 「訳したのに落ちる」を避けるため下限は大きく余裕を取る（目標値ではなく床）。
const MIN_JA_CHARS_PER_WORD = 0.5;
// 原文のラテン語がこの割合以上そのまま残っていれば未翻訳とみなす。忠実な訳でも
// keep-original の術語は残るので、余裕を持って 9 割に置く。
const MAX_RESIDUAL_LATIN = 0.9;
// 正規表現で読む「1 引数」の長さの上限。上限を書かないと、閉じない \includegraphics[ や
// \ref{ の羅列で開始位置ごとに末尾まで走査して二次になる（実測: 512KB で formalCheck
// 6,406ms・injectFootnotes 20,731ms、2.2MB で 99 秒）。ラベル・パス・オプションは
// これより遥かに短い。⚠ landmines.md
const MAX_INLINE_ARG = 200;

// ^^ 記法の展開は組版側の検査と同一実装を使う（正本は tools/tex-safety.ts）。
export { decodeCarets } from "../tools/tex-safety.js";
import { decodeCarets as decode } from "../tools/tex-safety.js";
import { blankSpans, mathSpans, MATH_ENVS } from "../tools/tex-spans.js";

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

// 文書をそこで終わらせる／以降を不可視にする綴り。LaTeX は \end{document} 以降を無視するので
// **ビルドは正常終了する**（実測: seg-0000 の訳末尾に 1 つ足すだけで exit 0 / buildOk true の
// まま PDF に最初の節しか出ない）。\iffalse を先頭・\fi を末尾に置けば中間を丸ごと消せる。
// 訳文が原文に無いこれらを持ち込むのは翻訳ではないので、再訳ではなく失敗に倒す。
const STRUCTURE_BREAKS = [
  "\\end{document}",
  "\\begin{document}",
  "\\endinput",
  "\\iffalse",
] as const;

export function introducedStructureBreaks(srcLatex: string, ja: string): string[] {
  const src = stripLineComments(decode(srcLatex));
  const out = stripLineComments(decode(ja));
  return STRUCTURE_BREAKS.filter(
    (tok) => countOccurrences(out, tok) > countOccurrences(src, tok),
  );
}

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
// 表・アルゴリズム・図の中身も同じ理由で除く。手法名・データセット名・指標名を
// 日本語化するのはむしろ誤訳なので、「地の文」と数えると忠実な訳ほど落ちる
// （実測: 見出し・キャプション・地の文をすべて正しく訳した節が、表の行数 20 で
// 「ラテン語優位」、40 で「日本語が見合わない」。表単独の節はキャプションだけが
// 訳対象なので 3 行でも発火した。翻訳者には直しようがなく exit 3）。
const NON_PROSE_ENVS = [
  "thebibliography",
  "verbatim",
  "Verbatim",
  "lstlisting",
  "minted",
  "alltt",
  "tabular",
  "tabularx",
  "tabulary",
  "longtable",
  "array",
  "algorithmic",
  "algorithm",
  "tikzpicture",
];

// 引数が PDF に描画されないコマンド。中身を「地の文」と数えると、\index{ひらがな}
// を足すだけで未翻訳検査を無効化できた（実測: 全文が英語原文のままの訳文に
// \index{あ×52} を足すと formalCheck が [] を返した。\printindex が無ければ
// 1 文字も描画されない）。⚠ landmines.md
const INVISIBLE_ARG_CMDS =
  /\\(?:index|label|(?:eq|auto|page|c|C)?ref|cite[a-zA-Z]*|url|nolinkurl|path|input|include|hypersetup|(?:re|provide)?newcommand|def|pdfbookmark|pdfstringdef|typeout|message|special|write|selectlanguage|usepackage|documentclass|bibliography|bibliographystyle)\*?\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,200}\}(?:\s*\{[^{}]{0,200}\})?/g;

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
// 行コメントを先に落とす。生テキストのまま環境を探すと、% でコメントアウトした
// \begin{verbatim} にも反応し、囲まれた英語（LaTeX 上はコメントではないので PDF に出る）が
// 地の文から消える。実測で全編未訳の訳文が 8 種すべて [] を返し exit 0 で通った。
function proseOf(tex: string): string {
  return stripNonProseEnvs(stripLineComments(tex))
    .replace(INVISIBLE_ARG_CMDS, " ")
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
  // 数式区間は線形走査で潰す。遅延正規表現だと閉じない \[ を詰めた見出しで二次になった
  // （実測 250KiB で 4,157ms）。入力は訳文なので上限は MAX_RESPONSE_CHARS。
  const noMath = blankSpans(s, mathSpans(s));
  return noMath
    .replace(/\\includegraphics\*?\s*(?:\[[^\]]{0,200}\])?\s*\{[^}]{0,200}\}/g, " ") // 図: オプション込みで引数ごと除去
    .replace(/\\(?:eqref|autoref|pageref|cref|Cref|ref|label|cite[a-zA-Z]*|url|nolinkurl|path|href|input|include)\s*\{[^}]{0,200}\}/g, " ") // 参照系・URL・パス系は不可視引数ごと除去
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

// 数式の本体（区切りを除いた中身）。個数だけを数えていた頃は、不等号の反転も
// 表示数式の空洞化も無検査だった（実測: $\alpha < 0.05$ → $\alpha > 0.95$ が [] を返す）。
// 学術論文の翻訳では数式は原文のまま持ち越すのが正しいので、決定的に照合できる。
function mathBodies(text: string): string[] {
  const src = stripLineComments(text);
  return mathSpans(src, MATH_ENVS)
    .map(([s, e]) => normalizeMath(src.slice(s, e)))
    .filter((b) => b !== "");
}

// 訳文が変えてよい差だけを潰す: 区切り・空白・間隔マクロと、数式内の地の文（\text 等）。
function normalizeMath(span: string): string {
  return span
    .replace(/^\$\$|\$\$$|^\$|\$$/g, "")
    .replace(/^\\[[(]|\\[\])]$/g, "")
    .replace(/^\\begin\{[^}]{0,200}\}|\\end\{[^}]{0,200}\}$/g, "")
    .replace(/\\(?:text|mbox|textrm|textnormal)\s*\{[^{}]{0,200}\}/g, "\\text{}")
    .replace(/\\(?:,|;|!|:|quad|qquad|thinspace|;)/g, "")
    .replace(/\s+/g, "");
}

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
  const opt = optArg ? `(?:\\[[^\\]]{0,${String(MAX_INLINE_ARG)}}\\]\\s*)?` : "";
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

// 差し戻しに載せる式の数と 1 件の長さ。プロンプトを膨らませないための上限。
const MAX_LISTED_MATH = 3;
const MAX_MATH_CHARS = 60;

function clip(s: string): string {
  return s.length > MAX_MATH_CHARS ? `${s.slice(0, MAX_MATH_CHARS)}…` : s;
}

// multiset の差（src にしか無い / ja にしか無い）を実際の式として返す。
// 「5 件中の差異」だけを返していた頃は、差し戻された側が全部を見直すしかなく、
// 小さいモデルでは改稿が当てずっぽうになって上限まで回っていた。
function multisetDiff(src: string[], ja: string[]): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const s of src) counts.set(s, (counts.get(s) ?? 0) + 1);
  const added: string[] = [];
  for (const j of ja) {
    const n = counts.get(j) ?? 0;
    if (n > 0) counts.set(j, n - 1);
    else added.push(j);
  }
  const missing: string[] = [];
  for (const [body, n] of counts) {
    for (let i = 0; i < n; i++) missing.push(body);
  }
  return { missing, added };
}

function describeMathDiff(src: string[], ja: string[]): string {
  const { missing, added } = multisetDiff(src, ja);
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `訳文に無い数式: ${missing.slice(0, MAX_LISTED_MATH).map(clip).join(" / ")}${missing.length > MAX_LISTED_MATH ? ` ほか ${String(missing.length - MAX_LISTED_MATH)} 件` : ""}`,
    );
  }
  if (added.length > 0) {
    parts.push(
      `原文に無い数式: ${added.slice(0, MAX_LISTED_MATH).map(clip).join(" / ")}${added.length > MAX_LISTED_MATH ? ` ほか ${String(added.length - MAX_LISTED_MATH)} 件` : ""}`,
    );
  }
  return parts.join("。");
}

// 契約付録 §3
const REFERENCE_COMMANDS = [
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "footnote",
  "footnotemark",
  "url",
  "href",
  "ref",
  "autoref",
  "eqref",
  "cref",
  "Cref",
  "pageref",
  "nameref",
];

// 1 走査で全綴りを数える。\\cite（行終端＋地の文の cite）は綴りではないので、
// 直前の backslash の偶奇で綴りの開始かどうかを決める。
function countCommands(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") continue;
    let back = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) back++;
    if (back % 2 === 1) continue; // 自身がエスケープされた backslash
    let end = i + 1;
    while (end < text.length && /[a-zA-Z]/.test(text[end]!)) end++;
    if (end === i + 1) continue; // 記号だけの綴り（別の検査が見る）
    const name = text.slice(i + 1, end);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    i = end - 1;
  }
  return counts;
}

// 契約付録 §3
const PAIRED_SYMBOLS = ["\\\\"];
const INTRODUCED_SYMBOLS = ["\\(", "\\)", "\\[", "\\]"];
const INTRODUCED_BARE = ["%", "#", "$"];

// 直前の backslash の数で「エスケープされた綴り」と「綴りそのもの」を区別する。
function countSymbolCommand(text: string, cmd: string): number {
  const sym = cmd.slice(1);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") continue;
    let back = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) back++;
    if (back % 2 === 1) continue; // 自身がエスケープされている
    if (text.startsWith(sym, i + 1)) n++;
  }
  return n;
}

// backslash が付いていない特殊文字。奇数個の backslash が前置されていればエスケープ済み。
function countBareSpecial(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ch) continue;
    let back = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) back++;
    if (back % 2 === 0) n++;
  }
  return n;
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

  const breaks = introducedStructureBreaks(srcLatex, ja);
  if (breaks.length > 0) {
    issues.push({
      kind: "structure",
      message: `訳文が原文に無い文書構造コマンドを持ち込んだ: ${breaks.join(", ")}`,
    });
  }

  // 地の文が十分ある節でのみ判定する（数式・図だけの節は原文と一致しても正常）。
  // 判定の入口は**原文側**の地の文の量にする。訳文側の語数を入口にすると、訳文で地の文を
  // 消すだけで検査ごと無効化できた（実測: 訳文「あ」1 文字、% でコメントアウトした
  // \begin{verbatim} で英語を囲む綴り。どちらも 8 種すべて [] で exit 0）。
  const srcWords = proseWordCount(srcLatex);
  const jaChars = japaneseCharCount(ja);
  if (srcWords >= MIN_PROSE_WORDS) {
    const identical = normalizeForCompare(srcLatex) === normalizeForCompare(ja);
    const jaWords = proseWordCount(ja);
    if (jaChars < srcWords * MIN_JA_CHARS_PER_WORD) {
      issues.push({
        kind: "untranslated",
        message: identical
          ? "訳文が原文と同一（未翻訳）"
          : `訳文の日本語が原文の地の文に見合わない（未翻訳・欠落の疑い・原文 ${srcWords} 語 / 訳文 ${jaChars} 文字）`,
      });
    } else if (jaWords > jaChars) {
      issues.push({
        kind: "untranslated",
        message: `地の文がラテン語優位（未翻訳の疑い・ラテン語 ${jaWords} 語 / 日本語 ${jaChars} 文字）`,
      });
    } else if (jaWords >= srcWords * MAX_RESIDUAL_LATIN) {
      // 上の 2 本はどちらも「訳文の日本語がどれだけ増えたか」しか見ないので、
      // 英語を 1 語も消さずに日本語を足すだけで通せた。原文のラテン語が
      // ほぼそのまま残っていること自体を未翻訳の証拠として扱う。
      issues.push({
        kind: "untranslated",
        message: `原文のラテン語がほぼそのまま残っている（未翻訳の疑い・原文 ${srcWords} 語 / 訳文 ${jaWords} 語）`,
      });
    }
  }

  const srcMath = countMath(srcLatex);
  const jaMath = countMath(ja);
  const srcBodies = mathBodies(srcLatex);
  const jaBodies = mathBodies(ja);
  // どの式が消えた・変わったのかを添える。件数だけを返すと、差し戻された側は全部を
  // 見直すしかない（実測: ローカルの 12B は改稿 4 回を使い切っても直せなかった）。
  const diff = describeMathDiff(srcBodies, jaBodies);
  const detail = diff === "" ? "" : `。${diff}`;
  if (srcMath !== jaMath) {
    issues.push({
      kind: "math",
      message: `数式個数不一致: src=${srcMath} ja=${jaMath}${detail}`,
    });
  } else if (multisetMismatch(srcBodies, jaBodies)) {
    // 個数が合っていても中身は自由に変えられる（不等号の反転・空洞化）。数式は原文の
    // まま持ち越すのが正しいので、正規化した本体を multiset で照合する。
    issues.push({
      kind: "math",
      message: `数式の内容が原文と一致しません（${String(srcBodies.length)} 件中の差異）${detail}`,
    });
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

  // 引用・参照・脚注・箇条書き・見出しは、落ちても組版が成功するので黙って本文が減る。
  // 契約付録 §3
  {
    const inSrc = countCommands(stripLineComments(srcLatex));
    const inJa = countCommands(stripLineComments(ja));
    const diffs = REFERENCE_COMMANDS.map((c) => ({
      cmd: c,
      src: inSrc.get(c) ?? 0,
      ja: inJa.get(c) ?? 0,
    })).filter((d) => d.src !== d.ja);
    if (diffs.length > 0) {
      issues.push({
        kind: "reference",
        message: `引用・参照の個数不一致: ${diffs
          .map((d) => `\\${d.cmd} src=${String(d.src)} ja=${String(d.ja)}`)
          .join(" / ")}。原文と同じ綴りのまま残してください（\\citet を \\cite に置き換えない、脚注を本文へ畳まない）。`,
      });
    }
  }

  // 記号だけの制御綴りは usedCommands（\\[a-zA-Z]+）に掛からず、どの検査も見ていなかった。
  // 契約付録 §3
  {
    const srcText = stripLineComments(srcLatex);
    const jaText = stripLineComments(ja);
    const diffs = [
      ...PAIRED_SYMBOLS.map((cmd) => ({
        cmd,
        src: countSymbolCommand(srcText, cmd),
        ja: countSymbolCommand(jaText, cmd),
      })).filter((d) => d.src !== d.ja),
      ...INTRODUCED_SYMBOLS.map((cmd) => ({
        cmd,
        src: countSymbolCommand(srcText, cmd),
        ja: countSymbolCommand(jaText, cmd),
      })).filter((d) => d.ja > d.src),
      // 生の特殊文字はコメント除去前の本文で数える（% 自身が剥がされてしまうため）。
      ...INTRODUCED_BARE.map((ch) => ({
        cmd: ch,
        src: countBareSpecial(srcLatex, ch),
        ja: countBareSpecial(ja, ch),
      })).filter((d) => d.ja > d.src),
    ];
    if (diffs.length > 0) {
      issues.push({
        kind: "symbol-command",
        message: `記号の制御綴りの個数不一致: ${diffs
          .map((d) => `${d.cmd} src=${String(d.src)} ja=${String(d.ja)}`)
          .join(" / ")}。原文の書き方をそのまま持ち越してください（\\\\ を \\ に縮めない、) を \\) にしない、\\% の backslash を落として % にしない）。`,
      });
    }
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
