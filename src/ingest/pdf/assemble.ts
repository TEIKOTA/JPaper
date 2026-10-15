// 契約付録 §8（PDF 入力）・PDF 入力 ADR(20261015) 決定 3・7。ページごとの LaTeX を 1 本の main.tex にする。
import { OMITTED_MARK } from "./word-check.js";
import { PAGE_PREAMBLE, splitContinues } from "./page-reader.js";
import { figureKey } from "./figures.js";

export interface AssembledPage {
  page: number;
  // テキスト層（繰り返す行を落とした後）。つなぐかの判断に使う。
  text: string;
  status: "ok" | "fallback";
  tex: string;
  continues: boolean;
  // fallback のページ画像（main.tex からの相対パス）。
  image?: string;
}

// LLM が図の代わりに置く目印。契約付録 §8（PDF 入力・図）
export const FIGURE_PLACEHOLDER = /(\\noindent\s*)?\\fbox\{Figure omitted[^{}]*\}/g;
// 目印の後ろでキャプションの番号を探す範囲（文字数）。
const CAPTION_LOOKAHEAD = 400;

// 目印ごとに、後ろ（次の目印まで）に最初に現れる図の番号と同じ番号の図を貼る。番号が無い・合う図が無い目印はそのまま残す。
export function placeFigures(
  tex: string,
  figures: readonly { key: string; file: string }[],
): { tex: string; placed: number; marks: number } {
  const used = new Set<string>();
  let placed = 0;
  let marks = 0;
  const out = tex.replace(FIGURE_PLACEHOLDER, (m: string, noindent: string | undefined, offset: number) => {
    marks++;
    const rest = tex.slice(offset + m.length, offset + m.length + CAPTION_LOOKAHEAD);
    const next = rest.search(/\\fbox\{Figure omitted/);
    const key = figureKey(next < 0 ? rest : rest.slice(0, next));
    const f = figures.find((x) => x.key === key && !used.has(x.file));
    if (key === undefined || f === undefined) return m;
    used.add(f.file);
    placed++;
    const graphic = `\\includegraphics[width=\\linewidth,height=0.45\\textheight,keepaspectratio]{${f.file}}`;
    // 段落の頭（\noindent の直後）の目印だけを center で包む。
    return noindent === undefined ? graphic : `\\begin{center}${graphic}\\end{center}`;
  });
  return { tex: out, placed, marks };
}

// 文末として扱う終わり方（閉じ括弧・引用符が後ろに付いてよい）。
const TERMINAL = /[.?!:;]["'”’)\]]*$/;

function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1]?.trim() ?? "";
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

// 前のページの末尾と次のページの先頭を、段落を切らずにつなぐか。
export function shouldJoin(prevText: string, nextText: string, marked: boolean): boolean {
  const ended = TERMINAL.test(lastLine(prevText));
  const head = firstLine(nextText);
  const lower = /^[a-z]/.test(head);
  const upper = /^[A-Z0-9\\]/.test(head);
  return marked ? !(ended && upper) : !ended && lower;
}

// \name{...}（入れ子の波括弧を含む）の区間。見つからなければ undefined。
function commandSpan(tex: string, name: string): [number, number] | undefined {
  const re = new RegExp(`\\\\${name}\\s*\\{`);
  const m = re.exec(tex);
  if (m === null) return undefined;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return [m.index, i + 1];
  }
  return undefined;
}

function dropOmitted(tex: string): string {
  return tex
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(OMITTED_MARK))
    .join("\n")
    .trim();
}

function fallbackTex(p: AssembledPage): string {
  return [
    "\\begin{center}",
    `\\includegraphics[width=\\linewidth,height=0.85\\textheight,keepaspectratio]{${p.image ?? ""}}`,
    "\\end{center}",
  ].join("\n");
}

// ページをまたいで続く環境（閉じと開きを潰して 1 つにする）。
const LIST_ENVS = ["thebibliography", "itemize", "enumerate", "description"];
const envEnd = (env: string): RegExp => new RegExp(`\\\\end\\{${env}\\}\\s*$`);
const envBegin = (env: string): RegExp => new RegExp(`^\\s*\\\\begin\\{${env}\\}(?:\\{[^}]*\\}|\\[[^\\]]*\\])?`);

export function assembleMainTex(pages: readonly AssembledPage[]): string {
  const front: string[] = [];
  let body = "";
  let prev: AssembledPage | undefined;
  for (const p0 of pages) {
    const split = splitContinues(p0.tex);
    const p = { ...p0, continues: p0.continues || split.continues };
    let tex = p.status === "ok" ? dropOmitted(split.tex) : fallbackTex(p);
    if (p.status === "ok") {
      // 最初に現れた \title・\author を前文へ移し、\title の位置に \maketitle を置く。
      for (const name of ["title", "author"] as const) {
        if (front.some((f) => f.startsWith(`\\${name}`))) continue;
        const span = commandSpan(tex, name);
        if (span === undefined) continue;
        front.push(tex.slice(span[0], span[1]));
        tex = `${tex.slice(0, span[0])}${name === "title" ? "\\maketitle" : ""}${tex.slice(span[1])}`.trim();
      }
    }
    const adjacent = prev !== undefined && prev.page + 1 === p.page && prev.status === "ok" && p.status === "ok";
    // 参考文献の一覧は常に、ほかのリストは続きのページのときだけ 1 つにする。
    const join = adjacent && shouldJoin(prev!.text, p.text, p.continues);
    const env = adjacent
      ? LIST_ENVS.find(
          (e) => (e === "thebibliography" || join || p.continues) && envEnd(e).test(body) && envBegin(e).test(tex),
        )
      : undefined;
    if (env !== undefined) {
      body = body.replace(envEnd(env), "").trimEnd();
      tex = tex.replace(envBegin(env), "").trimStart();
      body += `\n${tex}`;
    } else if (join) {
      // 行末で分綴した語がページをまたぐなら、ハイフンを除いてつなぐ。
      const end = body.trimEnd();
      const head = tex.trimStart();
      body = /[A-Za-z]-$/.test(end) && /^[a-z]/.test(head) ? `${end.slice(0, -1)}${head}` : `${end}\n${head}`;
    } else {
      body += `${body === "" ? "" : "\n\n"}${tex}`;
    }
    prev = p;
  }
  return `${PAGE_PREAMBLE}${front.map((f) => `${f}\n`).join("")}\\begin{document}\n${body}\n\\end{document}\n`;
}
