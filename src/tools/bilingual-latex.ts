// 契約付録 §7・対訳 PDF ADR(20261006)。原文と訳文を段落ペアにして paracol の対訳 main.tex を組み立てる。
import { extractPreamble, releaseLuatexjaNames, sanitizeMath, separateCjkAfterControlWords } from "./assemble-latex.js";

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
  // 原文にタイトルを組む命令（\maketitle・frontmatter 環境）があるのに、タイトルブロックに置き換えられなかった。
  titleUnplaced: boolean;
}

const BLANK_LINES = /\n[ \t]*(?:\n[ \t]*)+/;

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

// エスケープしていない % から行末までを除く。
export function stripComments(tex: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") {
      i++;
    } else if (c === "%") {
      out += tex.slice(from, i);
      const nl = tex.indexOf("\n", i);
      if (nl === -1) return out;
      from = nl;
      i = nl - 1;
    }
  }
  return out + tex.slice(from);
}

// コメントを除いた \begin{ と \end{ の差（env）、エスケープしていない { と } の差（brace）。
export function nestingOf(tex: string): { env: number; brace: number } {
  const text = stripComments(tex);
  let brace = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
  }
  return { env: count(text, "\\begin{") - count(text, "\\end{"), brace };
}

// ⚠ landmines.md
export function balanceParagraphs(paras: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let env = 0;
  let brace = 0;
  for (const p of paras) {
    const n = nestingOf(p);
    env += n.env;
    brace += n.brace;
    buf.push(p);
    if (env <= 0 && brace <= 0) {
      out.push(buf.join("\n\n"));
      buf = [];
      env = 0;
      brace = 0;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n\n"));
  return out;
}

export function paragraphsOf(tex: string): string[] {
  return balanceParagraphs(splitParagraphs(sanitizeMath(separateCjkAfterControlWords(tex))));
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

// ⚠ landmines.md
export function dropLabels(tex: string): string {
  return tex.replace(/^[ \t]*\\label\{[^{}]*\}[ \t]*\n/gm, "").replace(/\\label\{[^{}]*\}/g, "");
}

// ⚠ landmines.md
export function muteBibliography(tex: string): string {
  return tex.replace(/\\bibliography(?:style)?\{[^{}]*\}/g, (m) => `\\jpNoAux{${m}}`);
}

const FRONTMATTER_LABELS = { left: "{Abstract}{Keywords}", right: "{概要}{キーワード}" } as const;

// ⚠ landmines.md
export function replaceFrontmatter(tex: string, side: "left" | "right"): string {
  return tex
    .replace(/\\begin\{frontmatter\}/g, `\\begin{jpFrontmatter}${FRONTMATTER_LABELS[side]}`)
    .replace(/\\end\{frontmatter\}/g, "\\end{jpFrontmatter}");
}

function hasFrontmatter(tex: string): boolean {
  return stripComments(tex).includes("\\begin{frontmatter}");
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

// 最後の \title{...} の中身。無ければ undefined。
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
  "\\newcommand{\\jp@titleblock}[2]{%",
  "  \\par\\hrule height 4\\p@\\vskip 0.15in",
  "  {\\centering\\Large\\bfseries\\begingroup\\let\\thanks\\@gobble #1\\endgroup\\par}",
  "  \\vskip 0.2in\\hrule height 1\\p@\\vskip 0.1in",
  // 著者の \\and / \\And / \\AND はタイトルの表組みの中でしか使えないので、ここでは区切りの空白にする。⚠ landmines.md
  "  {\\centering\\begingroup\\let\\thanks\\@gobble\\def\\and{\\unskip\\quad}\\let\\And\\and\\def\\AND{\\unskip\\par}#2\\endgroup\\par}",
  "  \\vskip 0.15in}",
  "\\newcommand{\\jpTitleBlock}[1]{\\jp@titleblock{#1}{\\@author}}",
  // ⚠ landmines.md
  "\\newif\\ifjp@fmpending",
  "\\def\\jp@fmhead{\\ifjp@fmpending\\global\\jp@fmpendingfalse\\jp@titleblock{\\jp@fmtitle}{\\jp@fmauthors}\\fi}",
  "\\def\\jp@gobbleom{\\@ifnextchar[{\\jp@gobbleom@}{\\jp@gobbleom@[]}}",
  "\\def\\jp@gobbleom@[#1]#2{}",
  "\\def\\jp@fm@title[#1]#2{\\def\\jp@fmtitle{#2}}",
  "\\def\\jp@fm@author[#1]#2{\\ifx\\jp@fmauthors\\@empty\\def\\jp@fmauthors{#2}\\else" +
    "\\expandafter\\def\\expandafter\\jp@fmauthors\\expandafter{\\jp@fmauthors, #2}\\fi}",
  "\\newenvironment{jpFrontmatter}[2]{%",
  "  \\global\\jp@fmpendingtrue\\def\\jp@fmtitle{}\\let\\jp@fmauthors\\@empty",
  "  \\def\\title{\\@ifnextchar[{\\jp@fm@title}{\\jp@fm@title[]}}%",
  "  \\def\\author{\\@ifnextchar[{\\jp@fm@author}{\\jp@fm@author[]}}%",
  "  \\let\\corref\\@gobble\\let\\fnref\\@gobble\\let\\tnoteref\\@gobble\\let\\thanksref\\@gobble\\let\\dochead\\@gobble",
  "  \\let\\cortext\\jp@gobbleom\\let\\fntext\\jp@gobbleom\\let\\tnotetext\\jp@gobbleom\\let\\ead\\jp@gobbleom",
  "  \\let\\affiliation\\jp@gobbleom\\let\\address\\jp@gobbleom",
  "  \\def\\abstract{\\jp@fmhead\\par\\medskip\\noindent\\textbf{#1}\\par\\noindent\\ignorespaces}\\def\\endabstract{\\par}%",
  "  \\def\\keyword{\\jp@fmhead\\par\\medskip\\noindent\\textit{#2:}\\ \\def\\sep{\\unskip, }\\ignorespaces}\\def\\endkeyword{\\par}%",
  "  \\def\\highlights{\\jp@fmhead\\par\\medskip\\noindent\\textbf{Highlights}\\begin{itemize}}\\def\\endhighlights{\\end{itemize}}%",
  "  \\def\\graphicalabstract{\\jp@fmhead\\par\\medskip\\noindent\\textbf{Graphical Abstract}\\par}\\def\\endgraphicalabstract{\\par}%",
  "}{\\jp@fmhead\\par\\medskip}",
  // ⚠ landmines.md
  "\\newcommand{\\jpRobustNotes}{\\MakeRobust\\footnote\\MakeRobust\\footnotemark\\MakeRobust\\footnotetext}",
  // ⚠ landmines.md
  "\\newcommand{\\jpNoAux}[1]{\\begingroup\\@fileswfalse#1\\endgroup}",
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

const MAKETITLE = /\\maketitle(?![A-Za-z@])\s*/g;
const TITLE_COMMANDS = /\\maketitle(?![A-Za-z@])|\\begin\{frontmatter\}/;

// コメント外で最初の \maketitle の範囲（後続の空白を含む）。
function findMaketitle(tex: string): { start: number; end: number } | undefined {
  for (const m of tex.matchAll(MAKETITLE)) {
    const prefix = tex.slice(tex.lastIndexOf("\n", m.index) + 1, m.index);
    if (stripComments(prefix) === prefix) return { start: m.index, end: m.index + m[0].length };
  }
  return undefined;
}

function atTopLevel(tex: string): boolean {
  const n = nestingOf(tex);
  return n.env === 0 && n.brace === 0;
}

// ⚠ landmines.md
export function renderPairs(
  pairs: ParagraphPair[],
  preambles: { left: string; right: string },
): { blocks: string[]; titled: boolean } {
  const blocks: string[] = [];
  const push = (left: string, right: string): void => {
    if (left.trim() === "" && right.trim() === "") return;
    const l = replaceFrontmatter(left, "left");
    const r = muteBibliography(dropLabels(provideCommands(replaceFrontmatter(right, "right"))));
    blocks.push(`${l}\n\\switchcolumn\n${r}\n\\switchcolumn*`);
  };
  let seenLeft = preambles.left;
  let seenRight = preambles.right;
  let titled = false;
  for (const p of pairs) {
    if (titled) {
      push(p.left, p.right);
      continue;
    }
    if (hasFrontmatter(p.left)) {
      push(p.left, p.right);
      titled = true;
      continue;
    }
    const l = findMaketitle(p.left);
    const r = findMaketitle(p.right);
    const leftBefore = l === undefined ? p.left : p.left.slice(0, l.start);
    const rightBefore = r === undefined ? p.right : p.right.slice(0, r.start);
    if (l === undefined || !atTopLevel(leftBefore) || !atTopLevel(rightBefore)) {
      seenLeft += `\n${p.left}`;
      seenRight += `\n${p.right}`;
      push(p.left, p.right);
      continue;
    }
    push(leftBefore.trimEnd(), rightBefore.trimEnd());
    blocks.push(
      titleBlock(titleOf(`${seenLeft}\n${leftBefore}`) ?? "", titleOf(`${seenRight}\n${rightBefore}`) ?? ""),
    );
    titled = true;
    push(p.left.slice(l.end), r === undefined ? "" : p.right.slice(r.end));
  }
  return { blocks, titled };
}

export function paracolBody(blocks: string[]): string {
  return blocks.length === 0 ? "" : `\\begin{paracol}{2}\n\\jpRobustNotes\n${blocks.join("\n\n")}\n\\end{paracol}\n`;
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
  const { blocks, titled } = renderPairs(pairs, { left: extractPreamble(input.cleanLatex), right: preamble });
  const mainTex = releaseLuatexjaNames(`${bilingualPreamble(preamble)}${BEGIN}\n${paracolBody(blocks)}\\end{document}\n`);
  const titleUnplaced = !titled && input.source.some((s) => TITLE_COMMANDS.test(stripComments(s.tex)));
  return { mainTex, pairs: blocks.length, fallbackSegments, titleUnplaced };
}
