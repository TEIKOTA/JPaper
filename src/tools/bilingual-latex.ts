// 契約付録 §7・対訳 PDF ADR(20261006)。原文と訳文を段落ペアにして paracol の対訳 main.tex を組み立てる。
import { extractPreamble, releaseLuatexjaNames, sanitizeMath, separateCjkAfterControlWords } from "./assemble-latex.js";
import { DEFAULT_PROFILE, detectProfile, packageNames, type FrontMatterProfile } from "./frontmatter.js";
import { findTitleArg } from "./paper-title.js";

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

// open の [ に対応する ] の位置。波括弧・コメントの中と \[ \] は数えない。閉じなければ undefined。
function closingBracket(tex: string, open: number): number | undefined {
  let brace = 0;
  let depth = 0;
  for (let i = open; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") i++;
    else if (c === "%") {
      const nl = tex.indexOf("\n", i);
      if (nl === -1) return undefined;
      i = nl;
    } else if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (brace === 0 && c === "[") depth++;
    else if (brace === 0 && c === "]" && --depth === 0) return i;
  }
  return undefined;
}

const TWOCOLUMN = /\\twocolumn\s*\[/g;

// コメントの外で、型の selfSetting の命令を中身に含む最初の \twocolumn[…] の [ と ] を改行に置き換える。⚠ landmines.md
export function unwrapTitleBlock(tex: string, profile: FrontMatterProfile = DEFAULT_PROFILE): string {
  if (profile.selfSetting.length === 0) return tex;
  const setter = new RegExp(`\\\\(?:${profile.selfSetting.join("|")})(?![A-Za-z@])`);
  let skipUntil = -1;
  for (const m of tex.matchAll(TWOCOLUMN)) {
    if (m.index < skipUntil) continue;
    const prefix = tex.slice(tex.lastIndexOf("\n", m.index) + 1, m.index);
    if (stripComments(prefix) !== prefix) {
      const nl = tex.indexOf("\n", m.index);
      skipUntil = nl === -1 ? tex.length : nl;
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = closingBracket(tex, open);
    if (close === undefined) return tex;
    const inner = tex.slice(open + 1, close);
    if (!setter.test(stripComments(inner))) {
      skipUntil = close;
      continue;
    }
    return `${tex.slice(0, m.index)}\n${inner}\n${tex.slice(close + 1)}`;
  }
  return tex;
}

export function paragraphsOf(tex: string, profile: FrontMatterProfile = DEFAULT_PROFILE): string[] {
  return balanceParagraphs(splitParagraphs(sanitizeMath(separateCjkAfterControlWords(unwrapTitleBlock(tex, profile)))));
}

// 訳文セグメントの順に並べる。原文に同じ id が無いもの（訳注一覧）は左を空にする。
export function pairSegments(
  source: BilingualSegment[],
  translated: BilingualSegment[],
  profile: FrontMatterProfile = DEFAULT_PROFILE,
): PairResult {
  const bySource = new Map(source.map((s) => [s.id, s.tex]));
  const pairs: ParagraphPair[] = [];
  const fallbackSegments: string[] = [];
  for (const t of translated) {
    const right = paragraphsOf(t.tex, profile);
    const src = bySource.get(t.id);
    if (src === undefined) {
      pairs.push({ segmentId: t.id, left: "", right: right.join("\n\n") });
      continue;
    }
    const left = paragraphsOf(src, profile);
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

// 最後のタイトルの命令（型の表の命令名。既定は \title）の中身。無ければ undefined。
export function titleOf(tex: string, names: readonly string[] = DEFAULT_PROFILE.titleCommands): string | undefined {
  const arg = findTitleArg(tex, names);
  return arg === undefined ? undefined : tex.slice(arg.start, arg.end);
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

// 対訳ではリンクを作らない（hyperref の draft）。⚠ landmines.md
const NO_LINKS = "\\PassOptionsToPackage{draft}{hyperref} % JPaper 注入: 対訳はリンクを作らない";

// ICML の型の対訳の前文の手当て。icml\d{4} の \begin{document} のフックを外し、\thispagestyle を無効にし、
// 所属の番号を左右の段で共有し、\printAffiliationsAndNotice が進めた番号を戻し、\icmlcorrespondingauthor は左の段でだけ実行する。⚠ landmines.md
function icmlSetup(preamble: string, profile: FrontMatterProfile): string {
  if (profile.id !== "icml") return "";
  const names = [...new Set(packageNames(preamble).filter((p) => /^icml\d{4}$/.test(p)))];
  return [
    "% --- JPaper 注入: 対訳の ICML 手当て ---",
    ...names.map((n) => `\\RemoveFromHook{begindocument}[${n}]`),
    "\\makeatletter",
    "\\let\\thispagestyle\\@gobble",
    "\\@ifundefined{c@@affiliationcounter}{}{\\globalcounter{@affiliationcounter}}",
    "\\@ifundefined{icmlcorrespondingauthor}{}{\\let\\jp@icmlcorr\\icmlcorrespondingauthor" +
      "\\renewcommand{\\icmlcorrespondingauthor}[2]{\\ifnum\\pcol@currcol=\\z@\\jp@icmlcorr{#1}{#2}\\fi}}",
    "\\@ifundefined{printAffiliationsAndNotice}{}{\\let\\jp@icmlnotice\\printAffiliationsAndNotice" +
      "\\renewcommand{\\printAffiliationsAndNotice}[1]{\\jp@icmlnotice{#1}\\addtocounter{@affiliationcounter}{-1}}}",
    "\\makeatother",
    "",
  ].join("\n");
}

export function bilingualPreamble(preamble: string, profile: FrontMatterProfile = DEFAULT_PROFILE): string {
  return `${NO_LINKS}\n${preamble.replace(/\s*$/, "")}\n${SETUP}\n${icmlSetup(preamble, profile)}`;
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
function pairBlock(left: string, right: string): string {
  return `${left}\n\\switchcolumn\n${/^\s*\[/.test(right) ? "\\relax\n" : ""}${right}\n\\switchcolumn*`;
}

// コメントを除くと \if…（\iff を除く。続く \fi / \else / \or を含まない）/ \else / \or / \fi だけの行。
const CONDITIONAL_LINE =
  /^\\(?:if(?!f(?![A-Za-z@]))[A-Za-z@]*(?![A-Za-z@{])(?!.*\\(?:fi|else|or)(?![A-Za-z@])).*|else|or|fi)$/;

// コメントを除いて、\if…（\iff・\newif の直後・{ が続くものを除く）と \fi が釣り合い、
// \else / \or が開いた条件分岐の中にだけあるか。
export function conditionalsBalanced(tex: string): boolean {
  let depth = 0;
  let prev = "";
  for (const m of stripComments(tex).matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
    const name = m[1]!;
    const next = m.input[m.index + m[0].length];
    if (/^if(?!f$)/.test(name) && prev !== "newif" && next !== "{") depth++;
    else if (name === "fi") {
      if (depth === 0) return false;
      depth--;
    } else if ((name === "else" || name === "or") && depth === 0) return false;
    prev = name;
  }
  return depth === 0;
}

// 条件分岐が釣り合っていない段落だけを条件分岐の行で割る。段落の中で開いて段落の中で閉じる
// 環境・波括弧の内側の行では割らない。runs は conds より 1 つ多い。⚠ landmines.md
export function splitAtConditionals(tex: string): { runs: string[]; conds: string[] } {
  if (conditionalsBalanced(tex)) return { runs: [tex.trim()], conds: [] };
  const lines = tex.split("\n");
  // 各行の前で、段落の中で開いて閉じていない環境・波括弧の数（最後の要素は段落の末尾）。
  const env: number[] = [0];
  const brace: number[] = [0];
  for (const line of lines) {
    const n = nestingOf(line);
    env.push(Math.max(0, env[env.length - 1]! + n.env));
    brace.push(Math.max(0, brace[brace.length - 1]! + n.brace));
  }
  const suffixMin = (xs: number[]): number[] => {
    const out = [...xs];
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i]!, out[i + 1]!);
    return out;
  };
  const envMin = suffixMin(env);
  const braceMin = suffixMin(brace);
  const runs: string[] = [];
  const conds: string[] = [];
  let buf: string[] = [];
  lines.forEach((line, i) => {
    const bare = stripComments(line).trim();
    if (env[i] === envMin[i] && brace[i] === braceMin[i] && CONDITIONAL_LINE.test(bare)) {
      runs.push(buf.join("\n").trim());
      conds.push(bare);
      buf = [];
    } else {
      buf.push(line);
    }
  });
  runs.push(buf.join("\n").trim());
  return { runs, conds };
}

// 左右で条件分岐の行の並びが同じなら、条件分岐の行を段の切り替えの外に 1 回だけ置く。⚠ landmines.md
export function pairAcrossConditionals(left: string, right: string): string {
  const l = splitAtConditionals(left);
  const r = splitAtConditionals(right);
  if (l.conds.length === 0 || l.conds.join("\n") !== r.conds.join("\n")) return pairBlock(left, right);
  const out: string[] = [];
  l.runs.forEach((run, i) => {
    const other = r.runs[i]!;
    if (run !== "" || other !== "") out.push(pairBlock(run, other));
    if (i < l.conds.length) out.push(l.conds[i]!);
  });
  return out.join("\n");
}

// ⚠ landmines.md
export function renderPairs(
  pairs: ParagraphPair[],
  preambles: { left: string; right: string },
  profile: FrontMatterProfile = DEFAULT_PROFILE,
): { blocks: string[]; titled: boolean } {
  const blocks: string[] = [];
  const push = (left: string, right: string): void => {
    if (left.trim() === "" && right.trim() === "") return;
    const l = replaceFrontmatter(left, "left");
    const r = muteBibliography(dropLabels(provideCommands(replaceFrontmatter(right, "right"))));
    blocks.push(pairAcrossConditionals(l, r));
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
    // \maketitle がタイトルを組まない型（iopart）では置き換えない。
    const l = profile.maketitle ? findMaketitle(p.left) : undefined;
    const r = profile.maketitle ? findMaketitle(p.right) : undefined;
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
      titleBlock(
        titleOf(`${seenLeft}\n${leftBefore}`, profile.titleCommands) ?? "",
        titleOf(`${seenRight}\n${rightBefore}`, profile.titleCommands) ?? "",
      ),
    );
    titled = true;
    push(p.left.slice(l.end), r === undefined ? "" : p.right.slice(r.end));
  }
  return { blocks, titled };
}

export function paracolBody(blocks: string[]): string {
  // 段の中の \\textwidth は段の幅にする（原文の width=\\textwidth の図が隣の段へはみ出さない）。⚠ landmines.md
  return blocks.length === 0
    ? ""
    : `\\begin{paracol}{2}\n\\setlength{\\textwidth}{\\columnwidth}\n\\jpRobustNotes\n${blocks.join("\n\n")}\n\\end{paracol}\n`;
}

// translatedMainTex は採用されたレイアウトで組んだ和訳 main.tex（前文をそのまま使う）。
export function assembleBilingual(input: {
  cleanLatex: string;
  translatedMainTex: string;
  source: BilingualSegment[];
  translated: BilingualSegment[];
}): BilingualOutput {
  const preamble = extractPreamble(input.translatedMainTex);
  const profile = detectProfile(input.cleanLatex);
  const { pairs, fallbackSegments } = pairSegments(input.source, input.translated, profile);
  const { blocks, titled } = renderPairs(pairs, { left: extractPreamble(input.cleanLatex), right: preamble }, profile);
  const mainTex = releaseLuatexjaNames(`${bilingualPreamble(preamble, profile)}${BEGIN}\n${paracolBody(blocks)}\\end{document}\n`);
  const titleUnplaced = profile.maketitle && !titled && input.source.some((s) => TITLE_COMMANDS.test(stripComments(s.tex)));
  return { mainTex, pairs: blocks.length, fallbackSegments, titleUnplaced };
}
