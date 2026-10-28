// 契約付録 §7・組版レイアウト ADR(20260710)。訳文→main.tex 生成（原前文温存ハイブリッド）。
import { detectProfile } from "./frontmatter.js";
import { replaceTitle } from "./paper-title.js";

export type Layout = "original" | "template";

export interface AssembleInput {
  cleanLatex: string;
  chapters: string[];
  mode?: Layout;
}

export interface AssembleOutput {
  mainTex: string;
  layout: Layout;
}

const BEGIN_DOC = "\\begin{document}";
const END_DOC = "\\end{document}";

// LuaTeX ネイティブ UTF-8＋luatexja がフォントを担うため原前文から外す。
const DROP_PACKAGES = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{(?:inputenc|fontenc)\}[ \t]*\r?\n?/gm;

const JP_FONT = "\\usepackage[ipaex]{luatexja-preset} % JPaper 注入: 日本語組版 (契約付録 §7)";
const DOCUMENTCLASS_LINE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/;

const JP_INJECTION = [
  "% --- JPaper 注入: 共有引用 (契約付録 §7) ---",
  "\\providecommand{\\citep}{\\cite}",
  "\\providecommand{\\citet}{\\cite}",
  // acmart v2 の所属の国名の検査を外す。⚠ landmines.md
  "\\edef\\jpaperAtCatcode{\\the\\catcode`\\@}\\catcode`\\@=11",
  "\\@ifundefined{@ACM@resetaffil}{}{\\@ifundefined{@ACM@countrypresenttrue}{}{\\g@addto@macro\\@ACM@resetaffil{\\global\\@ACM@countrypresenttrue}}}",
  "\\catcode`\\@=\\jpaperAtCatcode\\relax",
  "% --- JPaper 注入ここまで ---",
].join("\n");

// 契約付録 §7・組版 shim ADR(20260809)。pdfTeX プリミティブを LuaTeX で有効化する。
const LUATEX85 = "\\RequirePackage{luatex85}";

export function extractPreamble(cleanLatex: string): string {
  const i = cleanLatex.indexOf(BEGIN_DOC);
  return i === -1 ? "" : cleanLatex.slice(0, i);
}

function hasPackage(preamble: string, name: string): boolean {
  return new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${name}\\}`).test(preamble);
}

export function neutralizePreamble(preamble: string): string {
  return preamble.replace(DROP_PACKAGES, "");
}

// \documentclass より前に置く必要があるため、共有部品の注入とは別工程で先頭へ足す。
export function prependLuatexCompat(preamble: string): string {
  if (preamble.includes("luatex85")) return preamble;
  return `${LUATEX85}\n${preamble}`;
}

// 原前文へ共有部品（luatexja・引用フォールバック・graphicx 保証）を注入する。
export function injectShared(preamble: string): string {
  const graphicx = hasPackage(preamble, "graphicx") ? "" : "\n\\usepackage{graphicx}";
  return `${injectJapaneseFont(prependLuatexCompat(preamble)).replace(/\s*$/, "")}\n${JP_INJECTION}${graphicx}\n`;
}

// luatexja は \documentclass の直後に読む。⚠ landmines.md
function injectJapaneseFont(preamble: string): string {
  const m = DOCUMENTCLASS_LINE.exec(preamble);
  if (m === null) return `${preamble.replace(/\s*$/, "")}\n${JP_FONT}\n`;
  const at = m.index + m[0].length;
  const sep = m[0].endsWith("\n") ? "" : "\n";
  return `${preamble.slice(0, at)}${sep}${JP_FONT}\n${preamble.slice(at)}`;
}

// 命令語の直後に続く和文字の前に {} を挟む。直前のバックスラッシュが奇数個なら末尾の 1 つ（\system\（ の制御記号）を {} に替える（LuaTeX では和文字も命令名の一部として読まれる）。⚠ landmines.md
export function separateCjkAfterControlWords(tex: string): string {
  return tex
    .replace(/(?<!\\)(\\[A-Za-z@]+)(?=[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef])/g, "$1{}")
    .replace(/(?<!\\)((?:\\\\)*)\\(?=[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef])/g, "$1{}");
}

// luatexja が定義済みの命令名（和文書体の切り替え）。
const LUATEXJA_NAMES = ["mc", "gt"];

// 論文が \newcommand で定義し直す luatexja の命令名を、定義済みでも通る \DeclareRobustCommand に替える。⚠ landmines.md
export function releaseLuatexjaNames(tex: string): string {
  const names = LUATEXJA_NAMES.join("|");
  return tex.replace(
    new RegExp(`\\\\newcommand(\\*?)\\s*(\\{\\s*\\\\(?:${names})\\s*\\}|\\\\(?:${names})(?![A-Za-z@]))`, "g"),
    "\\DeclareRobustCommand$1$2",
  );
}

// 論文の \newcommand{\theH<カウンタ名>} を、カーネルが定義済みでも通る \providecommand に替える。⚠ landmines.md
export function releaseCounterAnchorNames(tex: string): string {
  return tex.replace(
    /\\newcommand(\*?)\s*(\{\s*\\theH[A-Za-z]+\s*\}|\\theH[A-Za-z]+(?![A-Za-z@]))/g,
    "\\providecommand$1$2",
  );
}

// \caption の引数の中の空行を、行数を変えずに段落区切りでなくする。⚠ landmines.md
export function fuseCaptionParagraphs(tex: string): string {
  let out = "";
  let from = 0;
  const re = /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex)) !== null) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < tex.length && depth > 0; i++) {
      const c = tex[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth !== 0) break;
    out += tex.slice(from, open) + tex.slice(open, i).replace(/\n[ \t]*(?=\n)/g, "\n%");
    from = i;
    re.lastIndex = i;
  }
  return out + tex.slice(from);
}

const KEYWORDS_SHIM = Symbol("keywords");

// 契約付録 §7・組版 shim ADR(20260809)。原 class 固有のマークアップを article 上で吸収する。
const CLASS_SHIM = [
  "% --- JPaper 注入: class 固有マークアップの吸収 ---",
  "\\makeatletter",
  "\\newcommand{\\jpaper@env}[3]{\\@ifundefined{#1}{\\newenvironment{#1}{#2}{#3}}{}}",
  // elsarticle
  "\\jpaper@env{frontmatter}{}{\\maketitle}",
  "\\jpaper@env{keyword}{\\par\\noindent\\textbf{キーワード: }}{\\par}",
  "\\providecommand{\\sep}{;\\ }",
  "\\providecommand{\\ead}[2][]{}",
  "\\providecommand{\\address}[2][]{}",
  "\\providecommand{\\cortext}[2][]{}",
  "\\providecommand{\\fntext}[2][]{}",
  "\\providecommand{\\tnotetext}[2][]{}",
  "\\providecommand{\\corref}[1]{}",
  "\\providecommand{\\fnref}[1]{}",
  "\\providecommand{\\tnoteref}[1]{}",
  "\\providecommand{\\journal}[1]{}",
  "\\providecommand{\\biboptions}[1]{}",
  // IEEEtran
  "\\jpaper@env{IEEEkeywords}{\\par\\noindent\\textbf{キーワード: }}{\\par}",
  "\\providecommand{\\IEEEauthorblockN}[1]{#1}",
  "\\providecommand{\\IEEEauthorblockA}[1]{#1}",
  "\\providecommand{\\IEEEPARstart}[2]{#1#2}",
  "\\providecommand{\\IEEEpubid}[1]{}",
  // acmart（CCSXML は XML なので verbatim の comment で丸ごと捨てる）
  "\\jpaper@env{CCSXML}{\\comment}{\\endcomment}",
  "\\providecommand{\\ccsdesc}[2][]{}",
  KEYWORDS_SHIM,
  "\\providecommand{\\institution}[1]{#1}",
  "\\providecommand{\\city}[1]{#1}",
  "\\providecommand{\\country}[1]{#1}",
  "\\providecommand{\\affiliation}[2][]{}",
  "\\providecommand{\\email}[1]{#1}",
  // revtex
  "\\providecommand{\\altaffiliation}[2][]{}",
  "\\providecommand{\\homepage}[2][]{}",
  "\\providecommand{\\collaboration}[1]{}",
  "\\providecommand{\\preprint}[1]{}",
  "\\providecommand{\\pacs}[1]{}",
  // llncs / springer
  "\\providecommand{\\institute}[1]{}",
  "\\providecommand{\\inst}[1]{}",
  "\\providecommand{\\orcidID}[1]{}",
  "\\providecommand{\\titlerunning}[1]{}",
  "\\providecommand{\\authorrunning}[1]{}",
  "\\providecommand{\\subtitle}[1]{}",
  "\\makeatother",
  "% --- JPaper 注入ここまで ---",
];

// acmart の前文・著者欄・謝辞の命令。acmart の論文だけに入れる（名前がありふれていて、他の論文の定義とぶつかる）。⚠ landmines.md
const ACMART_SHIM = [
  "\\providecommand{\\state}[1]{#1}",
  "\\providecommand{\\streetaddress}[1]{#1}",
  "\\providecommand{\\postcode}[1]{#1}",
  "\\providecommand{\\orcid}[1]{}",
  "\\providecommand{\\authornote}[1]{}",
  "\\providecommand{\\authornotemark}[1][]{}",
  "\\providecommand{\\additionalaffiliation}[1]{}",
  "\\providecommand{\\titlenote}[1]{}",
  "\\providecommand{\\shortauthors}{}",
  "\\providecommand{\\Description}[2][]{}",
  "\\providecommand{\\setcopyright}[1]{}",
  "\\providecommand{\\copyrightyear}[1]{}",
  "\\providecommand{\\acmYear}[1]{}",
  "\\providecommand{\\acmConference}[4][]{}",
  "\\providecommand{\\acmBooktitle}[1]{}",
  "\\providecommand{\\acmPrice}[1]{}",
  "\\providecommand{\\acmDOI}[1]{}",
  "\\providecommand{\\acmISBN}[1]{}",
  "\\providecommand{\\acmJournal}[1]{}",
  "\\providecommand{\\acmVolume}[1]{}",
  "\\providecommand{\\acmNumber}[1]{}",
  "\\providecommand{\\acmArticle}[1]{}",
  "\\providecommand{\\acmMonth}[1]{}",
  "\\providecommand{\\acmSubmissionID}[1]{}",
  "\\providecommand{\\settopmatter}[1]{}",
  "\\providecommand{\\received}[2][]{}",
  "\\jpaper@env{acks}{\\section*{謝辞}}{}",
];

const DOCUMENTCLASS = /\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[ \t]*\r?\n?/;

// 原 \documentclass を落として残り（パッケージ・ユーザー定義マクロ）は丸ごと引き継ぐ。
export function stripDocumentClass(preamble: string): string {
  return preamble.replace(DOCUMENTCLASS, "");
}

// 原 class が内部で読むパッケージを article 上で読み直す（elsarticle は natbib を読む）。⚠ landmines.md
export function classPackages(cleanLatex: string): string[] {
  const m = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*([^}]*?)\s*\}/.exec(cleanLatex);
  if (m === null || m[2] !== "elsarticle") return [];
  const opts = (m[1] ?? "").split(",").map((o) => o.trim());
  if (opts.includes("nonatbib")) return [];
  // \biboptions は本文に書かれることもある（elsarticle は .spl 経由で次回の組版に効かせる）。
  const bib = [...cleanLatex.matchAll(/\\biboptions\s*\{([^}]*)\}/g)].map((b) => b[1]!.trim()).filter((b) => b !== "").join(",");
  const base = opts.includes("authoryear") ? "round,authoryear" : "numbers";
  return [`\\usepackage[${bib ? `${base},${bib}` : base}]{natbib}`];
}

// keywords を環境で使う論文（jmlr2e）は \keywords を前文で定義しない（後から読むパッケージの定義とぶつかる）。⚠ landmines.md
function classShim(cleanLatex: string): string {
  const keywords = /\\begin\s*\{keywords\}/.test(cleanLatex)
    ? "\\AtBeginDocument{\\jpaper@env{keywords}{\\par\\noindent\\textbf{キーワード: }}{\\par}}"
    : "\\providecommand{\\keywords}[1]{\\par\\noindent\\textbf{キーワード: }#1\\par}";
  const acmart = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*acmart\s*\}/.test(cleanLatex);
  return CLASS_SHIM.flatMap((l) => {
    if (l === KEYWORDS_SHIM) return [keywords];
    if (l === "\\makeatother" && acmart) return [...ACMART_SHIM, l];
    return [l];
  }).join("\n");
}

function templatePreamble(originalPreamble: string, cleanLatex: string): string {
  const carriedRaw = stripDocumentClass(neutralizePreamble(originalPreamble)).trim();
  const sentinel = "\\usepackage{hyperref}\n";
  const hoisted = placeCleverefAfterHyperref(`${carriedRaw}\n${sentinel}`);
  const carried = (hoisted.endsWith(sentinel) ? hoisted.slice(0, -sentinel.length) : hoisted).trim();
  return [
    LUATEX85,
    "\\documentclass[a4paper]{article}",
    // ⚠ landmines.md
    "\\usepackage[ipaex]{luatexja-preset}",
    "\\title{}",
    "\\author{}",
    classShim(cleanLatex),
    ...classPackages(cleanLatex),
    ...(carried === "" ? [] : ["% --- JPaper 注入: 原前文の引き継ぎ（documentclass のみ差し替え）---", carried]),
    "% --- JPaper 注入: 日本語組版・共有引用 ---",
    "\\usepackage{amsmath,amsfonts,amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs}",
    "\\usepackage{verbatim}",
    "\\usepackage{hyperref}",
    "\\providecommand{\\citep}{\\cite}",
    "\\providecommand{\\citet}{\\cite}",
  ].join("\n");
}

const MATH_ENVS = [
  "align*", "align", "equation*", "equation", "gather*", "gather",
  "multline*", "multline", "eqnarray*", "eqnarray", "alignat*", "alignat",
  "flalign*", "flalign",
];

// 数式環境内の空行は \par を発生させビルドを壊すため潰す（訳文が挿入し得る）。
// 環境ごとに左から 1 回だけ走査する。正規表現の遅延一致だと \end の無い \begin が
// 並ぶ入力で開始位置ごとに末尾までスキャンして二次になる（実測 7MB で 11,023ms）。
export function sanitizeMath(tex: string): string {
  for (const env of MATH_ENVS) {
    const open = `\\begin{${env}}`;
    const close = `\\end{${env}}`;
    let out = "";
    let pos = 0;
    for (;;) {
      const start = tex.indexOf(open, pos);
      if (start === -1) break;
      const endAt = tex.indexOf(close, start + open.length);
      // 閉じが無いなら、これ以降のどの開始位置でも見つからない。
      if (endAt === -1) break;
      const stop = endAt + close.length;
      out += tex.slice(pos, start) + tex.slice(start, stop).replace(/\n[ \t]*\n/g, "\n");
      pos = stop;
    }
    if (pos > 0) tex = out + tex.slice(pos);
  }
  return tex;
}

function assembleBody(chapters: string[]): string {
  return chapters
    .map((c) => sanitizeMath(c).trim())
    .filter((c) => c !== "")
    .join("\n\n");
}

const PKG_LINE = (name: string): RegExp =>
  new RegExp(`^[ \\t]*\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{${name}\\}[^\\n]*(?:\\n|$)`, "m");
const MOVE_BLOCKERS = /\\(?:usepackage|RequirePackage|PassOptionsToPackage|documentclass|if[A-Za-z@]*|else|or|fi)(?![A-Za-z@])/;

// 契約付録 §8 / ⚠ landmines.md
export function placeCleverefAfterHyperref(preamble: string): string {
  const clev = PKG_LINE("cleveref").exec(preamble);
  const hyper = PKG_LINE("hyperref").exec(preamble);
  if (clev === null || hyper === null || clev.index > hyper.index) return preamble;
  const restStart = clev.index + clev[0].length;
  const rest = preamble.slice(restStart, hyper.index);
  if (MOVE_BLOCKERS.test(rest.replace(/(^|[^\\])%.*$/gm, "$1"))) return preamble;
  const hyperLine = hyper[0].endsWith("\n") ? hyper[0] : `${hyper[0]}\n`;
  return `${preamble.slice(0, clev.index)}${hyperLine}${clev[0]}${rest}${preamble.slice(hyper.index + hyper[0].length)}`;
}

// title を渡すと前文の \title の主引数だけを差し替える（契約付録 §8）。
export function buildPreamble(cleanLatex: string, mode: Layout, title?: string): string {
  const preamble = extractPreamble(cleanLatex);
  const original = title === undefined ? preamble : replaceTitle(preamble, title, detectProfile(cleanLatex));
  return placeCleverefAfterHyperref(
    mode === "original" ? injectShared(neutralizePreamble(original)) : `${templatePreamble(original, cleanLatex)}\n`,
  );
}

export function assembleLatex(input: AssembleInput): AssembleOutput {
  const layout: Layout = input.mode ?? "original";
  const mainTex = `${buildPreamble(input.cleanLatex, layout)}${BEGIN_DOC}\n${assembleBody(input.chapters)}\n${END_DOC}\n`;
  return { mainTex, layout };
}

export interface Segment {
  id: string;
  tex: string;
}
export interface SourceSpan {
  id: string;
  startLine: number;
  endLine: number;
}
export interface AssembledWithMap extends AssembleOutput {
  sourceMap: SourceSpan[];
}

function lineCount(s: string): number {
  return (s.match(/\n/g) ?? []).length;
}

// エラー行→セグメント逆引き用に、本文各セグメントの main.tex 上の行範囲(1始まり)を返す。
export function assembleWithMap(input: {
  cleanLatex: string;
  segments: Segment[];
  mode?: Layout;
  title?: string;
}): AssembledWithMap {
  const layout: Layout = input.mode ?? "original";
  let out = `${buildPreamble(input.cleanLatex, layout, input.title)}${BEGIN_DOC}\n`;
  const parts = input.segments
    .map((s) => ({ id: s.id, tex: sanitizeMath(fuseCaptionParagraphs(separateCjkAfterControlWords(s.tex))).trim() }))
    .filter((p) => p.tex !== "");
  const sourceMap: SourceSpan[] = [];
  parts.forEach((p, i) => {
    const base = lineCount(out);
    sourceMap.push({ id: p.id, startLine: base + 1, endLine: base + 1 + lineCount(p.tex) });
    out += p.tex;
    if (i < parts.length - 1) out += "\n\n";
  });
  out += `\n${END_DOC}\n`;
  return { mainTex: releaseCounterAnchorNames(releaseLuatexjaNames(out)), layout, sourceMap };
}

export function segmentAtLine(sourceMap: SourceSpan[], line: number): string | undefined {
  const hit = sourceMap.find((s) => line >= s.startLine && line <= s.endLine);
  return hit?.id;
}
