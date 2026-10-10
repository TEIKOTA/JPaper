import { describe, it, expect } from "vitest";
import { dropDisabledBlocks } from "./disabled-blocks.js";
import { fastestMs } from "../testing/timing.js";

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}`;

describe("dropDisabledBlocks（契約付録 §4）", () => {
  it("本文の \\if 0 … \\fi と \\iffalse … \\fi を取り除く", () => {
    expect(dropDisabledBlocks(doc("A\n\\if 0\n\\subsection{Old}\nold text\n\\fi\nB"))).toBe(doc("A\n\nB"));
    expect(dropDisabledBlocks(doc("A \\iffalse old \\fi B"))).toBe(doc("A  B"));
    expect(dropDisabledBlocks(doc("A \\if0 old\\fi B"))).toBe(doc("A  B"));
  });

  it("\\else の枝は残す。入れ子の条件分岐（\\newif の綴りを含む）は 1 つのブロックとして数える", () => {
    expect(dropDisabledBlocks(doc("\\iffalse old \\else new \\fi"))).toBe(doc(" new "));
    const nested = "\\if 0 a \\ifdraft b \\else c \\fi \\ifx\\a\\b d\\fi e \\fi";
    expect(dropDisabledBlocks(doc(`X ${nested} Y`, "\\newif\\ifdraft\n"))).toBe(doc("X  Y", "\\newif\\ifdraft\n"));
  });

  it("前文・偽でない \\if・閉じないブロック・波括弧が釣り合わないブロックは残す", () => {
    const pre = doc("A", "\\iffalse x \\fi\n");
    expect(dropDisabledBlocks(pre)).toBe(pre);
    for (const body of ["\\if 00 x \\fi", "\\if 1 x \\fi", "\\ifx\\a\\b x\\fi", "\\iffalse never closed", "\\iffalse { \\fi }"]) {
      expect(dropDisabledBlocks(doc(body))).toBe(doc(body));
    }
  });

  it("コメントの中の \\iffalse・\\fi は数えない", () => {
    expect(dropDisabledBlocks(doc("A \\iffalse x % \\fi\n y \\fi B"))).toBe(doc("A  B"));
    expect(dropDisabledBlocks(doc("A % \\iffalse\nB \\fi"))).toBe(doc("A % \\iffalse\nB \\fi"));
  });

  it("verbatim・\\verb の中の \\iffalse・\\fi は数えない（組版に出る本文を消さない）", () => {
    const verb = "Use \\verb|\\iffalse| to start and \\verb|\\fi| to end.";
    expect(dropDisabledBlocks(doc(verb))).toBe(doc(verb));
    const env = "\\begin{verbatim}\n\\iffalse\n\\end{verbatim}\nLIVE\n\\begin{verbatim}\n\\fi\n\\end{verbatim}";
    expect(dropDisabledBlocks(doc(env))).toBe(doc(env));
  });

  it("4 バイト文字があっても、取り除く位置がずれない", () => {
    const env = "\\begin{verbatim}\n𝑥𝑦𝑧\n\\end{verbatim}\nAB \\iffalse old \\fi CD";
    expect(dropDisabledBlocks(doc(env))).toBe(doc("\\begin{verbatim}\n𝑥𝑦𝑧\n\\end{verbatim}\nAB  CD"));
    expect(dropDisabledBlocks(doc("\\verb|😀😀| KEEP1 \\iffalse old \\fi KEEP2"))).toBe(doc("\\verb|😀😀| KEEP1  KEEP2"));
  });

  it("検査で残した外側のブロックの内側にある無効ブロックは取り除く。コメントの中の波括弧は数えない", () => {
    expect(dropDisabledBlocks(doc("\\iffalse { \\iffalse x \\fi \\fi }"))).toBe(doc("\\iffalse {  \\fi }"));
    expect(dropDisabledBlocks(doc("A \\iffalse x % {\n\\fi B"))).toBe(doc("A  B"));
    expect(dropDisabledBlocks(doc("\\iffalse { \\else } \\fi"))).toBe(doc("\\iffalse { \\else } \\fi"));
    expect(dropDisabledBlocks(doc("\\iffalse }{ \\fi"))).toBe(doc("\\iffalse }{ \\fi"));
  });

  it("\\end{document} をまたぐブロックは \\else の枝でも残す。コメントの中の \\end{document} は数えない", () => {
    const tex = "\\documentclass{article}\n\\begin{document}\nA \\iffalse x \\else \\end{document} \\fi";
    expect(dropDisabledBlocks(tex)).toBe(tex);
    expect(dropDisabledBlocks(doc("A \\iffalse x % \\end{document}\n\\fi B"))).toBe(doc("A  B"));
  });

  it.each([
    ["入れ子の \\iffalse {", "\\iffalse { ", "\\fi "],
    ["入れ子の \\iffalse { \\else", "\\iffalse { \\else ", "\\fi "],
    ["\\end{document} をまたぐ入れ子", "\\iffalse ", "\\fi ", "\\end{document}"],
    ["遠くで閉じる \\lstinline{", "\\lstinline{", "}"],
  ])("外側が検査で落ちる入れ子でも走査は入力長に対して線形（%s）", (_label, open, close, middle = "") => {
    const k = Math.ceil((1 << 20) / (open.length + close.length));
    const body = open.repeat(k) + middle + close.repeat(k);
    expect(fastestMs(2, () => dropDisabledBlocks(doc(body)))).toBeLessThan(2000);
  });

  it.each([
    ["閉じない \\iffalse", "\\iffalse "],
    ["\\fi の無い \\else", "\\iffalse\\else "],
    ["閉じない \\if 0", "\\if 0 x "],
    ["波括弧が釣り合わない", "\\iffalse { \\fi "],
  ])("走査は入力長に対して線形（%s の羅列）", (_label, unit) => {
    const body = unit.repeat(Math.ceil((1 << 20) / unit.length));
    expect(fastestMs(2, () => dropDisabledBlocks(doc(body)))).toBeLessThan(2000);
  });
});

