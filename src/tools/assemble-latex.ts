// 契約付録 §7・組版レイアウト ADR(20260710)。訳文→main.tex 生成（原前文温存ハイブリッド）。
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

const JP_INJECTION = [
  "% --- JPaper 注入: 日本語組版・共有引用 (契約付録 §7) ---",
  "\\usepackage[ipaex]{luatexja-preset}",
  "\\providecommand{\\citep}{\\cite}",
  "\\providecommand{\\citet}{\\cite}",
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
  return `${prependLuatexCompat(preamble).replace(/\s*$/, "")}\n${JP_INJECTION}${graphicx}\n`;
}

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
  "\\providecommand{\\keywords}[1]{\\par\\noindent\\textbf{キーワード: }#1\\par}",
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
].join("\n");

const DOCUMENTCLASS = /\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[ \t]*\r?\n?/;

// 原 \documentclass を落として残り（パッケージ・ユーザー定義マクロ）は丸ごと引き継ぐ。
export function stripDocumentClass(preamble: string): string {
  return preamble.replace(DOCUMENTCLASS, "");
}

function templatePreamble(originalPreamble: string): string {
  const carried = stripDocumentClass(neutralizePreamble(originalPreamble)).trim();
  return [
    LUATEX85,
    "\\documentclass[a4paper]{article}",
    "\\title{}",
    "\\author{}",
    CLASS_SHIM,
    ...(carried === "" ? [] : ["% --- JPaper 注入: 原前文の引き継ぎ（documentclass のみ差し替え）---", carried]),
    "% --- JPaper 注入: 日本語組版・共有引用 ---",
    "\\usepackage[ipaex]{luatexja-preset}",
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
  "align\\*", "align", "equation\\*", "equation", "gather\\*", "gather",
  "multline\\*", "multline", "eqnarray\\*", "eqnarray", "alignat\\*", "alignat",
  "flalign\\*", "flalign",
];

// 数式環境内の空行は \par を発生させビルドを壊すため潰す（訳文が挿入し得る）。
export function sanitizeMath(tex: string): string {
  for (const env of MATH_ENVS) {
    const re = new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g");
    tex = tex.replace(re, (blk) => blk.replace(/\n[ \t]*\n/g, "\n"));
  }
  return tex;
}

function assembleBody(chapters: string[]): string {
  return chapters
    .map((c) => sanitizeMath(c).trim())
    .filter((c) => c !== "")
    .join("\n\n");
}

export function buildPreamble(cleanLatex: string, mode: Layout): string {
  const original = extractPreamble(cleanLatex);
  return mode === "original"
    ? injectShared(neutralizePreamble(original))
    : `${templatePreamble(original)}\n`;
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
}): AssembledWithMap {
  const layout: Layout = input.mode ?? "original";
  let out = `${buildPreamble(input.cleanLatex, layout)}${BEGIN_DOC}\n`;
  const parts = input.segments
    .map((s) => ({ id: s.id, tex: sanitizeMath(s.tex).trim() }))
    .filter((p) => p.tex !== "");
  const sourceMap: SourceSpan[] = [];
  parts.forEach((p, i) => {
    const base = lineCount(out);
    sourceMap.push({ id: p.id, startLine: base + 1, endLine: base + 1 + lineCount(p.tex) });
    out += p.tex;
    if (i < parts.length - 1) out += "\n\n";
  });
  out += `\n${END_DOC}\n`;
  return { mainTex: out, layout, sourceMap };
}

export function segmentAtLine(sourceMap: SourceSpan[], line: number): string | undefined {
  const hit = sourceMap.find((s) => line >= s.startLine && line <= s.endLine);
  return hit?.id;
}
