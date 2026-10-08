// 契約付録 §4。本文の無効ブロック（\iffalse … \fi・\if 0 … \fi）を取り除く。
import { newifNames, skipComment, skipIffalse } from "../tools/paper-title.js";

const BEGIN_DOCUMENT = "\\begin{document}";
// \if の後の空白を飛ばした「0 と空白」。0 と空白（字句）を比べるので常に偽。
const IF_ZERO = /[ \t]*0[ \t\r\n]/y;

function balancedBraces(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// \begin{document} より後の無効ブロックを、\else の枝があればその中身に、無ければ空に置き換える。
// 閉じない・波括弧の釣り合わない・\end{document} をまたぐブロックは残す。
export function dropDisabledBlocks(tex: string): string {
  const begin = tex.indexOf(BEGIN_DOCUMENT);
  if (begin === -1) return tex;
  let ifs: Set<string> | undefined;
  let out = "";
  let at = 0;
  for (let i = begin + BEGIN_DOCUMENT.length; i < tex.length; i++) {
    const c = tex[i];
    if (c === "%") {
      i = skipComment(tex, i) - 1;
      continue;
    }
    if (c !== "\\") continue;
    let j = i + 1;
    while (j < tex.length && /[a-zA-Z]/.test(tex[j]!)) j++;
    if (j === i + 1) {
      i++;
      continue;
    }
    const name = tex.slice(i + 1, j);
    let from: number | undefined;
    if (name === "iffalse") from = j;
    else if (name === "if") {
      IF_ZERO.lastIndex = j;
      if (IF_ZERO.test(tex)) from = IF_ZERO.lastIndex - 1;
    }
    if (from === undefined) {
      i = j - 1;
      continue;
    }
    ifs ??= newifNames(tex);
    const block = disabledBlock(tex, i, from, ifs);
    if (block === undefined) {
      i = j - 1;
      continue;
    }
    out += tex.slice(at, i) + block.keep;
    at = block.end;
    i = block.end - 1;
  }
  return out + tex.slice(at);
}

const endsAt = (tex: string, at: number, word: string): boolean => tex.startsWith(word, at - word.length);

function disabledBlock(
  tex: string,
  start: number,
  from: number,
  ifs: ReadonlySet<string>,
): { end: number; keep: string } | undefined {
  const first = skipIffalse(tex, from, ifs);
  let end = first;
  let keep = "";
  if (endsAt(tex, first, "\\else")) {
    end = skipIffalse(tex, first, ifs);
    if (!endsAt(tex, end, "\\fi")) return undefined;
    keep = tex.slice(first, end - "\\fi".length);
  } else if (!endsAt(tex, first, "\\fi")) {
    return undefined;
  }
  if (tex.slice(start, end).includes("\\end{document}")) return undefined;
  // 偽の枝（\else まで）の波括弧が釣り合わないブロックは残す。
  if (!balancedBraces(tex.slice(start, first))) return undefined;
  return { end, keep };
}
