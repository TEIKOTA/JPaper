// 契約付録 §7・対訳 PDF ADR(20261006)。原文と訳文を段落ペアにして paracol の対訳 main.tex を組み立てる。
import { extractPreamble, sanitizeMath } from "./assemble-latex.js";

export interface BilingualSegment {
  id: string;
  tex: string;
}

export interface ParagraphPair {
  segmentId: string;
  left: string;
  right: string;
}

export interface PairResult {
  pairs: ParagraphPair[];
  // 段落数が一致せず、セグメント全体を 1 ペアにしたセグメントの id。
  fallbackSegments: string[];
}

export interface BilingualOutput {
  mainTex: string;
  pairs: number;
  fallbackSegments: string[];
}

const BLANK_LINES = /\n[ \t]*(?:\n[ \t]*)+/;
const LINE_COMMENT = /(?<!\\)%.*/g;

export function splitParagraphs(tex: string): string[] {
  return tex
    .split(BLANK_LINES)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

function count(s: string, needle: string): number {
  let n = 0;
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

// ⚠ landmines.md
export function balanceParagraphs(paras: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const p of paras) {
    const t = p.replace(LINE_COMMENT, "");
    depth += count(t, "\\begin{") - count(t, "\\end{");
    buf.push(p);
    if (depth <= 0) {
      out.push(buf.join("\n\n"));
      buf = [];
      depth = 0;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n\n"));
  return out;
}

export function paragraphsOf(tex: string): string[] {
  return balanceParagraphs(splitParagraphs(sanitizeMath(tex)));
}

// 訳文セグメントの順に並べる。原文に同じ id が無いもの（訳注一覧）は左を空にする。
export function pairSegments(
  source: BilingualSegment[],
  translated: BilingualSegment[],
): PairResult {
  const bySource = new Map(source.map((s) => [s.id, s.tex]));
  const pairs: ParagraphPair[] = [];
  const fallbackSegments: string[] = [];
  for (const t of translated) {
    const right = paragraphsOf(t.tex);
    const src = bySource.get(t.id);
    if (src === undefined) {
      pairs.push({ segmentId: t.id, left: "", right: right.join("\n\n") });
      continue;
    }
    const left = paragraphsOf(src);
    if (left.length === right.length) {
      left.forEach((l, i) => pairs.push({ segmentId: t.id, left: l, right: right[i]! }));
    } else {
      fallbackSegments.push(t.id);
      pairs.push({ segmentId: t.id, left: left.join("\n\n"), right: right.join("\n\n") });
    }
  }
  return { pairs, fallbackSegments };
}

// ⚠ landmines.md
export function provideCommands(tex: string): string {
  return tex.replace(/\\newcommand(?![A-Za-z@])/g, "\\providecommand");
}

function braceBody(s: string, open: number): string | undefined {
  let depth = 1;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(open, j);
  }
  return undefined;
}

// 前文の最後の \title{...} の中身。無ければ undefined。
export function titleOf(preamble: string): string | undefined {
  let last: number | undefined;
  for (const m of preamble.matchAll(/\\title\s*(?:\[[^\]]*\]\s*)?\{/g)) last = m.index + m[0].length;
  return last === undefined ? undefined : braceBody(preamble, last);
}

// ⚠ landmines.md
export const PAPER = "onecolumn,paperwidth=420mm,paperheight=297mm,top=18mm,bottom=22mm,left=16mm,right=16mm";

const SETUP = [
  "% --- JPaper 注入: 対訳 (対訳 PDF ADR 20261006) ---",
  "\\usepackage{paracol}",
  "\\usepackage{eso-pic}",
  "\\usepackage{xcolor}",
  "\\usepackage{geometry}",
  `\\geometry{${PAPER}}`,
  "\\setlength{\\columnsep}{32mm}",
  "\\setlength{\\parindent}{1em}",
  "\\makeatletter",
  "\\newcommand{\\jpTitleBlock}[1]{%",
  "  \\par\\hrule height 4\\p@\\vskip 0.15in",
  "  {\\centering\\Large\\bfseries #1\\par}",
  "  \\vskip 0.2in\\hrule height 1\\p@\\vskip 0.1in",
  "  {\\centering\\begingroup\\let\\thanks\\@gobble\\@author\\endgroup\\par}",
  "  \\vskip 0.15in}",
  // ⚠ landmines.md
  "\\renewenvironment{figure}[1][]{\\par\\vspace{1mm}\\begin{center}\\def\\@captype{figure}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{figure*}[1][]{\\par\\vspace{1mm}\\begin{center}\\def\\@captype{figure}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{table}[1][]{\\par\\vspace{1mm}\\begin{center}\\def\\@captype{table}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{table*}[1][]{\\par\\vspace{1mm}\\begin{center}\\def\\@captype{table}}{\\end{center}\\par\\vspace{1mm}}",
  "\\makeatother",
  "% --- JPaper 注入ここまで ---",
].join("\n");

export function bilingualPreamble(preamble: string): string {
  return `${preamble.replace(/\s*$/, "")}\n${SETUP}\n`;
}

const BEGIN = [
  "\\begin{document}",
  `\\newgeometry{${PAPER}}`,
  "\\pagestyle{empty}",
  // ⚠ landmines.md
  "\\AddToShipoutPictureFG{" +
    "\\put(105mm,10mm){\\makebox(0,0){\\small 原文 p.\\thepage}}" +
    "\\put(315mm,10mm){\\makebox(0,0){\\small 和訳 p.\\thepage}}" +
    "\\put(210mm,0mm){\\color{black!25}\\rule{0.3pt}{297mm}}}",
].join("\n");

export function titleBlock(left: string, right: string): string {
  return `\\jpTitleBlock{${left}}\n\\switchcolumn\n\\jpTitleBlock{${right}}\n\\switchcolumn*`;
}

const MAKETITLE = /^\\maketitle(?![A-Za-z@])\s*/;

// ⚠ landmines.md
export function renderPairs(
  pairs: ParagraphPair[],
  titles: { left: string; right: string },
): string[] {
  const blocks: string[] = [];
  for (const p of pairs) {
    let left = p.left;
    let right = p.right;
    if (MAKETITLE.test(left)) {
      blocks.push(titleBlock(titles.left, titles.right));
      left = left.replace(MAKETITLE, "");
      right = right.replace(MAKETITLE, "");
    }
    if (left.trim() === "" && right.trim() === "") continue;
    blocks.push(`${left}\n\\switchcolumn\n${provideCommands(right)}\n\\switchcolumn*`);
  }
  return blocks;
}

export function paracolBody(blocks: string[]): string {
  return blocks.length === 0 ? "" : `\\begin{paracol}{2}\n${blocks.join("\n\n")}\n\\end{paracol}\n`;
}

// translatedMainTex は採用されたレイアウトで組んだ和訳 main.tex（前文をそのまま使う）。
export function assembleBilingual(input: {
  cleanLatex: string;
  translatedMainTex: string;
  source: BilingualSegment[];
  translated: BilingualSegment[];
}): BilingualOutput {
  const preamble = extractPreamble(input.translatedMainTex);
  const { pairs, fallbackSegments } = pairSegments(input.source, input.translated);
  const blocks = renderPairs(pairs, {
    left: titleOf(extractPreamble(input.cleanLatex)) ?? "",
    right: titleOf(preamble) ?? "",
  });
  const mainTex = `${bilingualPreamble(preamble)}${BEGIN}\n${paracolBody(blocks)}\\end{document}\n`;
  return { mainTex, pairs: blocks.length, fallbackSegments };
}
