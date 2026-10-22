// 契約付録 §7・対訳 PDF ADR(20261006)。原文と訳文を段落ペアにして paracol の対訳 main.tex を組み立てる。
import {
  extractPreamble,
  releaseCounterAnchorNames,
  releaseLuatexjaNames,
  sanitizeMath,
  separateCjkAfterControlWords,
} from "./assemble-latex.js";
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
  // 訳文の comment 環境の開閉が原文と違ったセグメントの id（commentOutCommentEnvs）。
  commentMismatch: string[];
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

const COMMENT_BEGIN = /\\begin\s*\{comment\}/;
const COMMENT_END = /\\end\s*\{comment\}/;

function commentOutSegment(tex: string, inside: boolean): { tex: string; inside: boolean; opens: number } {
  let opens = 0;
  const lines = tex.split("\n").map((line) => {
    const code = stripComments(line);
    if (inside) {
      if (COMMENT_END.test(code)) inside = false;
      return `%${line}`;
    }
    const at = code.search(COMMENT_BEGIN);
    if (at === -1) return line;
    opens++;
    inside = !COMMENT_END.test(code.slice(at));
    return `${line.slice(0, at)}%${line.slice(at)}`;
  });
  return { tex: lines.join("\n"), inside, opens };
}

export interface CommentedPair {
  source: BilingualSegment[];
  translated: BilingualSegment[];
  // 訳文の comment 環境の開始の数か、セグメントの終わりで comment 環境の中にいるかが原文と違ったセグメントの id。
  commentMismatch: string[];
}

// comment 環境（comment パッケージ）の行を、開始と終了の行も含めて % で始まる行にする（空行も）。
// 開始と終了が別のセグメントにあっても前から順に追う。訳文側の状態は、原文と同じ id のセグメントの終わりで原文側に揃える。
// 契約付録 §8。⚠ landmines.md
export function commentOutCommentEnvs(
  source: readonly BilingualSegment[],
  translated: readonly BilingualSegment[],
): CommentedPair {
  const traces = new Map<string, { opens: number; inside: boolean }>();
  let inside = false;
  const src = source.map((s) => {
    const r = commentOutSegment(s.tex, inside);
    inside = r.inside;
    traces.set(s.id, { opens: r.opens, inside: r.inside });
    return { ...s, tex: r.tex };
  });
  const sourceEndsInside = inside;
  const commentMismatch: string[] = [];
  let openedAt: string | undefined;
  inside = false;
  const tr = translated.map((t) => {
    const r = commentOutSegment(t.tex, inside);
    const trace = traces.get(t.id);
    if (trace === undefined) {
      if (!inside && r.inside) openedAt = t.id;
      inside = r.inside;
    } else {
      if (r.opens !== trace.opens || r.inside !== trace.inside) commentMismatch.push(t.id);
      inside = trace.inside;
      openedAt = undefined;
    }
    return { ...t, tex: r.tex };
  });
  if (inside && !sourceEndsInside && openedAt !== undefined) commentMismatch.push(openedAt);
  return { source: src, translated: tr, commentMismatch };
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
  return tex
    .replace(/\\newcommand(?![A-Za-z@])/g, "\\providecommand")
    .replace(/\\newtheorem(?![A-Za-z@])/g, "\\jpProvideTheorem");
}

// ⚠ landmines.md
export function dropLabels(tex: string): string {
  return tex.replace(/^[ \t]*\\label\{[^{}]*\}[ \t]*\n/gm, "").replace(/\\label\{[^{}]*\}/g, "");
}

// ⚠ landmines.md
export function muteBibliography(tex: string): string {
  return tex.replace(/\\bibliography(?:style)?\{[^{}]*\}/g, (m) => `\\jpNoAux{${m}}`);
}

// 右の段の略語（acronym パッケージ）のキーに付ける接頭辞。契約付録 §8（対訳 PDF）
export const ACRONYM_PREFIX = "jpR";
// acronym パッケージで略語のキーを取る命令（acronym.sty）。
const ACRONYM_KEY_COMMANDS =
  "ac|acs|acl|acf|acp|acsp|aclp|acfp|acfi|acfip|acsu|aclu|iac|Iac|Ac|Acs|Acl|Acf|Acp|Acsp|Aclp|Acfp|Acfi|Acfip|Aclu|acused|acro|acrodef|acroplural|acrodefplural|acroindefinite|acrodefindefinite";
// 命令・星・（\ac[2]{…} の改行のペナルティなどの）任意引数・キー。
const ACRONYM_KEY = new RegExp(`\\\\(${ACRONYM_KEY_COMMANDS})(\\*?)(\\s*(?:\\[[^\\]]*\\])?\\s*)\\{([^{}]*)\\}`, "g");
// 略語を定義する命令とキー。
const ACRONYM_DEFINITION = /\\(acro|acrodef|acroplural|acrodefplural)\*?\s*\{([^{}]*)\}/g;

export function usesAcronymPackage(preamble: string): boolean {
  return /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bacronym\b[^}]*\}/.test(stripComments(preamble));
}

// 右の段の本文で \acro / \acrodef が定義するキーと、作者が複数形を定めたキー。
export function acronymKeysOf(texs: readonly string[]): { defined: Set<string>; plural: Set<string> } {
  const defined = new Set<string>();
  const plural = new Set<string>();
  for (const tex of texs) {
    for (const m of stripComments(tex).matchAll(ACRONYM_DEFINITION)) (m[1]!.includes("plural") ? plural : defined).add(m[2]!);
  }
  return { defined, plural };
}

// 右の段の本文で定義する略語のキーに接頭辞を付け、左の段の定義・初出と分ける（前文やマクロで定義する略語は変えない）。⚠ landmines.md
export function separateAcronyms(tex: string, keys: { defined: Set<string>; plural: Set<string> }): string {
  return japanesePlurals(prefixAcronymKeys(tex, keys.defined), keys.plural);
}

// 和訳の略語の定義の直後に、正式名の複数形を正式名のまま（s を付けない）と定める（作者が複数形を定めたキーは除く）。
// \acroplural は acronym 環境の中でだけ使えるので、\acrodef には \acrodefplural を足す。
function japanesePlurals(tex: string, authored: Set<string>): string {
  const def = new RegExp(`\\\\(acro|acrodef)\\{${ACRONYM_PREFIX}([^{}]*)\\}\\s*\\[([^\\]]*)\\]\\s*\\{`, "g");
  let out = "";
  let from = 0;
  for (const m of tex.matchAll(def)) {
    if (m.index < from || authored.has(m[2]!)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < tex.length && depth > 0; i++) {
      if (tex[i] === "\\") i++;
      else if (tex[i] === "{") depth++;
      else if (tex[i] === "}") depth--;
    }
    if (depth !== 0) continue;
    const long = tex.slice(m.index + m[0].length, i - 1);
    const cmd = m[1] === "acro" ? "acroplural" : "acrodefplural";
    out += `${tex.slice(from, i)}\\${cmd}{${ACRONYM_PREFIX}${m[2]!}}[${m[3]!}s]{${long}}`;
    from = i;
  }
  return out + tex.slice(from);
}

function prefixAcronymKeys(tex: string, defined: Set<string>): string {
  return tex.replace(ACRONYM_KEY, (m, cmd: string, star: string, sp: string, key: string, offset: number, all: string) => {
    if (!defined.has(key)) return m;
    const head = `\\${cmd}${star}${sp}{${ACRONYM_PREFIX}${key}}`;
    // 定義で略称（[…]）を省くとキーが略称になるので、元のキーを略称として書く（複数形の定義は単数の略称を引くので補わない）。
    if (cmd !== "acro" && cmd !== "acrodef") return head;
    return /^\s*\[/.test(all.slice(offset + m.length)) ? head : `${head}[${key}]`;
  });
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
  // jmlr2e の \name・\email・\addr は \maketitle の中でだけ定義されるので、未定義なら同じ意味で補う。⚠ landmines.md
  "  {\\centering\\begingroup\\let\\thanks\\@gobble\\def\\and{\\unskip\\quad}\\let\\And\\and\\def\\AND{\\unskip\\par}" +
    "\\@ifundefined{name}{\\def\\name{\\normalsize\\bfseries}}{}\\@ifundefined{email}{\\def\\email{\\hfill\\small\\scshape}}{}" +
    "\\@ifundefined{addr}{\\def\\addr{\\small\\itshape}}{}#2\\endgroup\\par}",
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
  // \newtheorem{名前}[数え方]{見出し}[親] の定義済みの名前は、引数ごと読み飛ばす。⚠ landmines.md
  "\\newcommand{\\jpProvideTheorem}{\\@ifstar{\\jp@providetheorem@s}{\\jp@providetheorem}}",
  "\\def\\jp@providetheorem#1{\\@ifundefined{#1}{\\newtheorem{#1}}{\\jp@skiptheorem}}",
  "\\def\\jp@providetheorem@s#1{\\@ifundefined{#1}{\\newtheorem*{#1}}{\\@gobble}}",
  "\\def\\jp@skiptheorem{\\@ifnextchar[{\\jp@skiptheorem@}{\\jp@skiptheorem@@}}",
  "\\def\\jp@skiptheorem@[#1]#2{}",
  "\\def\\jp@skiptheorem@@#1{\\@ifnextchar[{\\jp@gobbleopt}{}}",
  "\\def\\jp@gobbleopt[#1]{}",
  // ⚠ landmines.md
  "\\newcommand{\\jpRobustNotes}{\\MakeRobust\\footnote\\MakeRobust\\footnotemark\\MakeRobust\\footnotetext}",
  // ⚠ landmines.md
  "\\newcommand{\\jpNoAux}[1]{\\begingroup\\@fileswfalse#1\\endgroup}",
  // ⚠ landmines.md
  "\\def\\jp@vspace@wrap{\\@ifstar{\\jp@vspace@s}{\\jp@vspace@n}}",
  "\\def\\jp@clampvspace{\\ifx\\vspace\\jp@vspace@wrap\\else\\let\\jp@vspace\\vspace\\let\\vspace\\jp@vspace@wrap\\fi}",
  "\\def\\jp@vspace@n#1{\\jp@vspace@c{#1}{\\jp@vspace{#1}}}",
  "\\def\\jp@vspace@s#1{\\jp@vspace@c{#1}{\\jp@vspace*{#1}}}",
  "\\def\\jp@vspace@c#1#2{\\skip@#1\\relax\\ifdim\\skip@<\\z@\\else#2\\fi}",
  "\\renewenvironment{figure}[1][]{\\par\\vspace{1mm}\\begin{center}\\jp@clampvspace\\def\\@captype{figure}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{figure*}[1][]{\\par\\vspace{1mm}\\begin{center}\\jp@clampvspace\\def\\@captype{figure}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{table}[1][]{\\par\\vspace{1mm}\\begin{center}\\jp@clampvspace\\def\\@captype{table}}{\\end{center}\\par\\vspace{1mm}}",
  "\\renewenvironment{table*}[1][]{\\par\\vspace{1mm}\\begin{center}\\jp@clampvspace\\def\\@captype{table}}{\\end{center}\\par\\vspace{1mm}}",
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

// 後ろに比較の対象を続けて書く TeX の条件分岐。
const OPERAND_CONDITIONALS = new Set([
  "if", "ifcat", "ifnum", "ifdim", "ifodd", "ifx", "ifcase", "ifdefined", "ifcsname", "iffontchar",
  "ifvoid", "ifhbox", "ifvbox", "ifeof", "ifincsname", "ifabsnum", "ifabsdim", "ifpdfabsnum",
  "ifpdfabsdim", "ifpdfprimitive", "ifprimitive",
]);

// コメントを除いた \if…（\iff と \newif の直後を除く。brace は直後に { が続くか）/ \else / \or / \fi の並び。
function conditionalTokens(tex: string): { name: string; brace: boolean }[] {
  const out: { name: string; brace: boolean }[] = [];
  let prev = "";
  for (const m of stripComments(tex).matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
    const name = m[1]!;
    if ((/^if(?!f$)/.test(name) && prev !== "newif") || name === "else" || name === "or" || name === "fi") {
      out.push({ name, brace: m.input[m.index + m[0].length] === "{" });
    }
    prev = name;
  }
  return out;
}

// \if… と \fi が釣り合い、\else / \or が開いた条件分岐の中にだけあるか。strict でなければ { が続く \if…
// （etoolbox の \ifbool{…} など）を数えない。
export function conditionalsBalanced(tex: string, strict = false): boolean {
  let depth = 0;
  for (const t of conditionalTokens(tex)) {
    if (t.name === "fi") {
      if (depth === 0) return false;
      depth--;
    } else if (t.name === "else" || t.name === "or") {
      if (depth === 0) return false;
    } else if (strict || !t.brace) depth++;
  }
  return depth === 0;
}

// { が続く \if… を数えても数えなくても条件分岐が釣り合う。
function conditionalsClosed(tex: string): boolean {
  return conditionalsBalanced(tex) && conditionalsBalanced(tex, true);
}

// コメントを除いて \else / \fi だけの行か、比較の対象を取らない \if…（\iff と OPERAND_CONDITIONALS を除く）
// だけの行。⚠ landmines.md
export function isConditionalLine(bare: string): boolean {
  if (/^\\(?:else|fi)$/.test(bare)) return true;
  const m = /^\\(if[A-Za-z@]*)$/.exec(bare);
  return m !== null && m[1] !== "iff" && !OPERAND_CONDITIONALS.has(m[1]!);
}

// 条件分岐が段落の中で閉じない段落だけを条件分岐の行で割る。段落の中で開いて段落の中で閉じる
// 環境・波括弧の内側の行では割らない。割った後のどれかの部分で条件分岐が閉じなければ割らない。
// runs は conds より 1 つ多い。⚠ landmines.md
export function splitAtConditionals(tex: string): { runs: string[]; conds: string[] } {
  const whole = { runs: [tex.trim()], conds: [] };
  if (conditionalsClosed(tex)) return whole;
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
    if (
      env[i] === envMin[i] &&
      brace[i] === braceMin[i] &&
      isConditionalLine(bare) &&
      endsWithoutPrefix(lines[i - 1] ?? "")
    ) {
      runs.push(buf.join("\n").trim());
      conds.push(bare);
      buf = [];
    } else {
      buf.push(line);
    }
  });
  runs.push(buf.join("\n").trim());
  return runs.every(conditionalsClosed) ? { runs, conds } : whole;
}

// 行の末尾が命令（\unless・\expandafter など次のトークンを取りうるもの）でも、行をつなぐコメントでもない。
function endsWithoutPrefix(line: string): boolean {
  return stripComments(line) === line && !/\\(?:[A-Za-z@]+|[^A-Za-z@])\s*$/.test(line);
}

type ConditionalPlan = "closed" | { left: { runs: string[]; conds: string[] }; right: { runs: string[]; conds: string[] } };

// closed は左右とも条件分岐が段落の中で閉じる。割れるのは左右が同じ条件分岐の行で割れるときだけで、
// それ以外は undefined。
function planConditionals(left: string, right: string): ConditionalPlan | undefined {
  if (conditionalsClosed(left) && conditionalsClosed(right)) return "closed";
  const l = splitAtConditionals(left);
  const r = splitAtConditionals(right);
  if (l.conds.length === 0 || l.conds.join("\n") !== r.conds.join("\n")) return undefined;
  return { left: l, right: r };
}

// 条件分岐の行の並びが入れ子として閉じるか（\else は 1 つの条件分岐に 1 回）。
export function conditionalLinesNest(conds: readonly string[]): boolean {
  const open: { sawElse: boolean }[] = [];
  for (const c of conds) {
    const top = open[open.length - 1];
    if (c === "\\fi") {
      if (top === undefined) return false;
      open.pop();
    } else if (c === "\\else") {
      if (top === undefined || top.sawElse) return false;
      top.sawElse = true;
    } else {
      open.push({ sawElse: false });
    }
  }
  return open.length === 0;
}

// 割る \if… の名前は、文書の中で \newif で宣言され、宣言とそれだけの行の外に現れない。
export function conditionalNamesDeclared(conds: readonly string[], doc: string): boolean {
  const lines = doc.split("\n").map((l) => stripComments(l));
  return conds
    .filter((c) => c.startsWith("\\if"))
    .every((c) => {
      const name = c.slice(1);
      const use = new RegExp(`\\\\${name}(?![A-Za-z@])`, "g");
      const decl = new RegExp(`\\\\newif\\s*\\\\${name}(?![A-Za-z@])`);
      let declared = false;
      for (const line of lines) {
        const uses = line.match(use)?.length ?? 0;
        if (uses === 0) continue;
        if (decl.test(line)) {
          declared = true;
          if (uses > 1 || line.replace(decl, "").trim() !== "") return false;
        } else if (line.trim() !== c) {
          return false;
        }
      }
      return declared;
    });
}

// 文書のすべての段落の対が、条件分岐が段落の中で閉じるか左右が同じ条件分岐の行で割れ、割った条件分岐の行を
// 文書の順に並べると入れ子として閉じるか。⚠ landmines.md
export function conditionalsSplittable(
  pairs: readonly { left: string; right: string }[],
  preamble = "",
): boolean {
  const conds: string[] = [];
  for (const p of pairs) {
    const plan = planConditionals(p.left, p.right);
    if (plan === undefined) return false;
    if (plan !== "closed") conds.push(...plan.left.conds);
  }
  const doc = [preamble, ...pairs.flatMap((p) => [p.left, p.right])].join("\n");
  return conditionalLinesNest(conds) && conditionalNamesDeclared(conds, doc);
}

// 左右が同じ条件分岐の行で割れれば、条件分岐の行を段の切り替えの外に 1 回だけ置く。⚠ landmines.md
export function pairAcrossConditionals(left: string, right: string): string {
  const plan = planConditionals(left, right);
  if (plan === undefined || plan === "closed") return pairBlock(left, right);
  const out: string[] = [];
  plan.left.runs.forEach((run, i) => {
    const other = plan.right.runs[i]!;
    if (run !== "" || other !== "") out.push(pairBlock(run, other));
    if (i < plan.left.conds.length) out.push(plan.left.conds[i]!);
  });
  return out.join("\n");
}

// ⚠ landmines.md
export function renderPairs(
  pairs: ParagraphPair[],
  preambles: { left: string; right: string },
  profile: FrontMatterProfile = DEFAULT_PROFILE,
): { blocks: string[]; titled: boolean } {
  const entries: (string | { left: string; right: string })[] = [];
  const acronyms = usesAcronymPackage(preambles.right) ? acronymKeysOf(pairs.map((p) => p.right)) : undefined;
  const push = (left: string, right: string): void => {
    if (left.trim() === "" && right.trim() === "") return;
    const l = replaceFrontmatter(left, "left");
    const r0 = muteBibliography(dropLabels(provideCommands(replaceFrontmatter(right, "right"))));
    const r = acronyms === undefined ? r0 : separateAcronyms(r0, acronyms);
    entries.push({ left: l, right: r });
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
    entries.push(
      titleBlock(
        titleOf(`${seenLeft}\n${leftBefore}`, profile.titleCommands) ?? "",
        titleOf(`${seenRight}\n${rightBefore}`, profile.titleCommands) ?? "",
      ),
    );
    titled = true;
    push(p.left.slice(l.end), r === undefined ? "" : p.right.slice(r.end));
  }
  const paired = entries.filter((e) => typeof e !== "string");
  const split = conditionalsSplittable(paired, preambles.left);
  return {
    blocks: entries.map((e) =>
      typeof e === "string" ? e : split ? pairAcrossConditionals(e.left, e.right) : pairBlock(e.left, e.right),
    ),
    titled,
  };
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
  const commented = commentOutCommentEnvs(input.source, input.translated);
  const { pairs, fallbackSegments } = pairSegments(commented.source, commented.translated, profile);
  const { blocks, titled } = renderPairs(pairs, { left: extractPreamble(input.cleanLatex), right: preamble }, profile);
  const mainTex = releaseCounterAnchorNames(
    releaseLuatexjaNames(`${bilingualPreamble(preamble, profile)}${BEGIN}\n${paracolBody(blocks)}\\end{document}\n`),
  );
  const titleUnplaced = profile.maketitle && !titled && input.source.some((s) => TITLE_COMMANDS.test(stripComments(s.tex)));
  return { mainTex, pairs: blocks.length, fallbackSegments, titleUnplaced, commentMismatch: commented.commentMismatch };
}
