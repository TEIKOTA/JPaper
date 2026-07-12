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

// 原前文へ共有部品（luatexja・引用フォールバック・graphicx 保証）を注入する。
export function injectShared(preamble: string): string {
  const graphicx = hasPackage(preamble, "graphicx") ? "" : "\n\\usepackage{graphicx}";
  return `${preamble.replace(/\s*$/, "")}\n${JP_INJECTION}${graphicx}\n`;
}

// \maketitle を成立させるため原前文から \title/\author ブロックを取り出す（テンプレへ引き継ぐ）。
export function extractCommand(preamble: string, name: string): string | undefined {
  const start = preamble.indexOf(`\\${name}`);
  if (start === -1) return undefined;
  let i = preamble.indexOf("{", start);
  if (i === -1) return undefined;
  let depth = 0;
  for (; i < preamble.length; i++) {
    const c = preamble[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return preamble.slice(start, i + 1);
  }
  return undefined;
}

function templatePreamble(originalPreamble: string): string {
  const title = extractCommand(originalPreamble, "title") ?? "\\title{}";
  const author = extractCommand(originalPreamble, "author") ?? "\\author{}";
  return [
    "\\documentclass[a4paper]{article}",
    "\\usepackage[ipaex]{luatexja-preset}",
    "\\usepackage{amsmath,amsfonts,amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs}",
    "\\usepackage{hyperref}",
    "\\providecommand{\\citep}{\\cite}",
    "\\providecommand{\\citet}{\\cite}",
    title,
    author,
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

export function assembleLatex(input: AssembleInput): AssembleOutput {
  const layout: Layout = input.mode ?? "original";
  const originalPreamble = extractPreamble(input.cleanLatex);
  const preamble =
    layout === "original"
      ? injectShared(neutralizePreamble(originalPreamble))
      : `${templatePreamble(originalPreamble)}\n`;
  const mainTex = `${preamble}${BEGIN_DOC}\n${assembleBody(input.chapters)}\n${END_DOC}\n`;
  return { mainTex, layout };
}
