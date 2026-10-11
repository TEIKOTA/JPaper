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
  // 開いた時点の波括弧の深さと、それまでに出た \end{document} の数。
  depth: number;
  endDocs: number;
  // 偽の枝の途中で深さが開いた時点より浅くなった。
  broken: boolean;
  // 偽の枝が閉じた（\else または \fi に達した）。
  closed: boolean;
  // \else に達した時点の判定。
  falseOk?: boolean;
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

// \begin{document} より後の閉じた無効ブロック（入れ子なら外側）を、\else の枝があればその中身に、
// 無ければ空に置き換える。verbatim・\verb・コメントの中の綴りは数えない。偽の枝の波括弧が
// 釣り合わない・\end{document} をまたぐブロックは残す。
export function dropDisabledBlocks(tex: string): string {
  const begin = tex.indexOf(BEGIN_DOCUMENT);
  if (begin === -1) return tex;
  const scan = maskChars(tex, verbatimSpans(tex));
  const ifs = newifNames(scan);
  const stack: Open[] = [];
  // 偽の枝が閉じていない無効ブロック。開いた時点の深さは下から順に広義単調増加。
  const pending: Open[] = [];
  const blocks: Block[] = [];
  let depth = 0;
  let endDocs = 0;
  // 偽の枝が閉じた時点で、波括弧が釣り合い \end{document} をまたがないか。
  const closeFalseBranch = (top: Open): boolean => {
    top.closed = true;
    return !top.broken && depth === top.depth && endDocs === top.endDocs;
  };
  for (let i = begin + BEGIN_DOCUMENT.length; i < scan.length; i++) {
    const c = scan[i];
    if (c === "%") {
      i = skipComment(scan, i) - 1;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      while (pending.length > 0 && pending[pending.length - 1]!.depth > depth) {
        const top = pending.pop()!;
        if (!top.closed) top.broken = true;
      }
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
    const open = (disabled: boolean): void => {
      const o: Open = { start: i, disabled, depth, endDocs, broken: false, closed: false };
      stack.push(o);
      if (disabled) pending.push(o);
    };
    if (name === "iffalse") {
      open(true);
    } else if (name === "if" && ifZeroEnd(scan, j) !== undefined) {
      open(true);
      j = ifZeroEnd(scan, j)!;
    } else if (PRIMITIVE_IFS.has(name) || ifs.has(name)) {
      open(false);
    } else if (scan.startsWith(END_DOCUMENT, i)) {
      endDocs++;
    } else if (name === "else") {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.elseEnd === undefined) {
        top.elseEnd = j;
        if (top.disabled) top.falseOk = closeFalseBranch(top);
      }
    } else if (name === "fi") {
      const top = stack.pop();
      if (top?.disabled === true) {
        const ok = top.elseEnd === undefined ? closeFalseBranch(top) : top.falseOk === true && endDocs === top.endDocs;
        if (ok) {
          blocks.push({
            start: top.start,
            end: j,
            ...(top.elseEnd === undefined ? {} : { keep: [top.elseEnd, i] as [number, number] }),
          });
        }
      }
    }
    i = j - 1;
  }
  blocks.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const b of blocks) {
    if (b.start < at) continue;
    out += tex.slice(at, b.start) + (b.keep === undefined ? "" : tex.slice(b.keep[0], b.keep[1]));
    at = b.end;
  }
  return out + tex.slice(at);
}
