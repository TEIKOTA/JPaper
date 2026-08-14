// 契約付録 §4。文書ブリーフの根拠を本文から決定的に切り出す。
// 全文は文脈長に入らない（実測 109KiB / 文脈窓 32,768）ので、論旨と節構成が読める
// 最小限だけを選ぶ。人手で論文固有の知識を書き足さないこと（純粋なモデル性能の測定を壊す）。
import { blankSpans, mathSpans, verbatimSpans } from "../tools/tex-spans.js";

// プロンプト全体を膨らませない上限。超えた分は末尾から捨てる（節の並び順は保つ）。
export const MAX_DIGEST_CHARS = 6000;
const MAX_ABSTRACT_CHARS = 1800;
const MAX_LEAD_CHARS = 240;
const MAX_HEADINGS = 60;
// 見出し 1 本の引数として読む長さの上限（走査の打ち切り）。
const MAX_HEADING_ARG = 500;
const HEADING_CMDS = ["part", "chapter", "section", "subsection", "subsubsection"];

function stripComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
}

// 制御綴りと記号を落として地の文だけ残す（数式・verbatim は先に潰す）。
function proseOf(tex: string): string {
  const blanked = blankSpans(blankSpans(tex, mathSpans(tex)), verbatimSpans(tex));
  return blanked
    .replace(
      /\\(?:label|(?:eq|auto|page|c|C)?ref|cite[a-zA-Z]*|url|nolinkurl|href|includegraphics|input|include|index)\*?\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,300}\}/g,
      " ",
    )
    .replace(/\\begin\{[a-zA-Z*]+\}(?:\[[^\]]{0,200}\])?|\\end\{[a-zA-Z*]+\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}[\]$&%#_^~\\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:)])/g, "$1") // 綴りを落とした跡の空白が句読点の前に残る
    .trim();
}

function abstractOf(tex: string): string {
  const open = tex.indexOf("\\begin{abstract}");
  if (open === -1) return "";
  const close = tex.indexOf("\\end{abstract}", open);
  if (close === -1) return "";
  return proseOf(tex.slice(open + "\\begin{abstract}".length, close)).slice(0, MAX_ABSTRACT_CHARS);
}

// 見出しの引数を平衡した波括弧で読む（入れ子の {} を含む見出しがある）。
// \section[短縮見出し]{本見出し} のオプション引数は飛ばす。
function headingAt(tex: string, from: number): { title: string; end: number } | undefined {
  let i = from;
  while (i < tex.length && (tex[i] === " " || tex[i] === "\t")) i++;
  if (tex[i] === "[") {
    const close = tex.indexOf("]", i);
    if (close === -1 || close - i > MAX_LEAD_CHARS) return undefined;
    i = close + 1;
    while (i < tex.length && (tex[i] === " " || tex[i] === "\t")) i++;
  }
  if (tex[i] !== "{") return undefined;
  // 走査に上限を置く。書かないと、閉じない \section{ の羅列で開始位置ごとに末尾まで
  // 舐めて二次になる（実測 50,000 個で 19,455ms）。見出しはこれより遥かに短い。
  // ⚠ landmines.md
  const limit = Math.min(tex.length, i + MAX_HEADING_ARG);
  let depth = 0;
  for (let j = i; j < limit; j++) {
    if (tex[j] === "{") depth++;
    else if (tex[j] === "}") {
      depth--;
      if (depth === 0) return { title: tex.slice(i + 1, j), end: j + 1 };
    }
  }
  return undefined;
}

interface Section {
  level: string;
  title: string;
  lead: string;
}

function sectionsOf(tex: string): Section[] {
  const out: Section[] = [];
  const re = new RegExp(`\\\\(${HEADING_CMDS.join("|")})\\*?`, "g");
  let m = re.exec(tex);
  while (m !== null && out.length < MAX_HEADINGS) {
    const h = headingAt(tex, m.index + m[0].length);
    if (h === undefined) {
      m = re.exec(tex);
      continue;
    }
    // 次の見出しまでを本節とみなし、その先頭だけを取る（論旨は節の入口に出る）。
    re.lastIndex = h.end;
    const level = m[1]!;
    m = re.exec(tex);
    const body = tex.slice(h.end, m ? m.index : tex.length);
    out.push({ level, title: proseOf(h.title), lead: proseOf(body).slice(0, MAX_LEAD_CHARS) });
  }
  return out;
}

// ブリーフの根拠。abstract＋見出しの並び＋各節の書き出しだけを、決定的に選ぶ。
export function paperDigest(cleanLatex: string, max = MAX_DIGEST_CHARS): string {
  const tex = stripComments(cleanLatex);
  const parts: string[] = [];
  const abs = abstractOf(tex);
  if (abs !== "") parts.push(`### abstract\n${abs}`);
  for (const s of sectionsOf(tex)) {
    const head = `### ${s.level}: ${s.title}`;
    parts.push(s.lead === "" ? head : `${head}\n${s.lead}`);
  }
  let out = "";
  for (const p of parts) {
    if (out.length + p.length + 2 > max) break;
    out += (out === "" ? "" : "\n\n") + p;
  }
  return out;
}
