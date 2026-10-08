// 契約付録 §4。本文の無効ブロック（\iffalse … \fi・\if 0 … \fi）を取り除く。走査は 1 回。⚠ landmines.md
import { maskChars, verbatimSpans } from "../tools/tex-spans.js";
import { newifNames, PRIMITIVE_IFS, skipComment } from "../tools/paper-title.js";

const BEGIN_DOCUMENT = "\\begin{document}";
const END_DOCUMENT = "\\end{document}";
// \if の後の空白を飛ばした「0 と空白」。0 と空白（字句）を比べるので常に偽。
const IF_ZERO = /[ \t]*0[ \t\r\n]/y;

interface Open {
  start: number;
  disabled: boolean;
  // \else の直後の位置。
  elseEnd?: number;
}

interface Block {
  start: number;
  end: number;
  // \else の枝（残す中身）の範囲。
  keep?: [number, number];
}

// \if の名前の直後 from が「0 と空白」なら 0 の直後の位置。
function ifZeroEnd(tex: string, from: number): number | undefined {
  IF_ZERO.lastIndex = from;
  return IF_ZERO.test(tex) ? IF_ZERO.lastIndex - 1 : undefined;
}

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

// \begin{document} より後の閉じた無効ブロック（入れ子なら外側）を、\else の枝があればその中身に、
// 無ければ空に置き換える。verbatim・\verb・コメントの中の綴りは数えない。偽の枝の波括弧が
// 釣り合わない・\end{document} をまたぐブロックは残す。
export function dropDisabledBlocks(tex: string): string {
  const begin = tex.indexOf(BEGIN_DOCUMENT);
  if (begin === -1) return tex;
  const scan = maskChars(tex, verbatimSpans(tex));
  const ifs = newifNames(scan);
  const stack: Open[] = [];
  const blocks: Block[] = [];
  for (let i = begin + BEGIN_DOCUMENT.length; i < scan.length; i++) {
    const c = scan[i];
    if (c === "%") {
      i = skipComment(scan, i) - 1;
      continue;
    }
    if (c !== "\\") continue;
    let j = i + 1;
    while (j < scan.length && /[a-zA-Z]/.test(scan[j]!)) j++;
    if (j === i + 1) {
      i++;
      continue;
    }
    const name = scan.slice(i + 1, j);
    if (name === "iffalse") {
      stack.push({ start: i, disabled: true });
    } else if (name === "if" && ifZeroEnd(scan, j) !== undefined) {
      stack.push({ start: i, disabled: true });
      j = ifZeroEnd(scan, j)!;
    } else if (PRIMITIVE_IFS.has(name) || ifs.has(name)) {
      stack.push({ start: i, disabled: false });
    } else if (name === "else") {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.elseEnd === undefined) top.elseEnd = j;
    } else if (name === "fi") {
      const top = stack.pop();
      if (top?.disabled === true) {
        blocks.push({
          start: top.start,
          end: j,
          ...(top.elseEnd === undefined ? {} : { keep: [top.elseEnd, i] as [number, number] }),
        });
      }
    }
    i = j - 1;
  }
  blocks.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const b of blocks) {
    if (b.start < at) continue;
    const falseBranch = scan.slice(b.start, b.keep === undefined ? b.end : b.keep[0]);
    if (tex.slice(b.start, b.end).includes(END_DOCUMENT) || !balancedBraces(falseBranch)) continue;
    out += tex.slice(at, b.start) + (b.keep === undefined ? "" : tex.slice(b.keep[0], b.keep[1]));
    at = b.end;
  }
  return out + tex.slice(at);
}
