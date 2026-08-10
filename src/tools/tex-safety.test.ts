import { describe, it, expect } from "vitest";
import {
  findUnsafeTexCommands,
  stripTexComments,
  decodeCarets,
} from "./tex-safety.js";

describe("findUnsafeTexCommands", () => {
  it("プリアンブルの読み出しプリミティブを検出する", () => {
    const tex = String.raw`\documentclass{article}
\newread\myin \openin\myin=/etc/passwd \read\myin to\leaked \closein\myin
\begin{document}x\end{document}`;
    expect(findUnsafeTexCommands(tex)).toEqual(["openin", "read"]);
  });

  it("Lua 実行を検出する（shell_escape=f を迂回する経路）", () => {
    const tex = String.raw`\directlua{local f=io.open("/etc/hosts","r") tex.sprint(f:read("*a"))}`;
    expect(findUnsafeTexCommands(tex)).toContain("directlua");
  });

  it("^^ 記法の難読化を展開してから検出する", () => {
    // \^^64irectlua は \directlua として展開される。
    expect(findUnsafeTexCommands("\\^^64irectlua{x}")).toContain("directlua");
  });

  it("\\csname による綴りの組み立ても拾う", () => {
    expect(findUnsafeTexCommands(String.raw`\csname openin\endcsname`)).toContain("openin");
  });

  it("コメント内は検出しない（正規の論文での誤検知を避ける）", () => {
    expect(findUnsafeTexCommands("% \\directlua{x}\n\\section{Intro}")).toEqual([]);
    // エスケープされた % はコメント開始ではない。
    expect(findUnsafeTexCommands("100\\% \\directlua{x}")).toContain("directlua");
  });

  it("正規のプリアンブルは通す（\\input / \\usepackage / \\newcommand は対象外）", () => {
    const tex = String.raw`\documentclass[review]{elsarticle}
\usepackage{amsmath}\usepackage{graphicx}
\input{macros}
\newcommand{\vect}[1]{\mathbf{#1}}
\begin{document}\section{Intro}Text.\end{document}`;
    expect(findUnsafeTexCommands(tex)).toEqual([]);
  });

  it("同じコマンドは 1 回だけ報告する", () => {
    expect(findUnsafeTexCommands("\\openin1 \\openin2 \\openin3")).toEqual(["openin"]);
  });
});

describe("stripTexComments", () => {
  it("行コメントを落とし、エスケープした % は残す", () => {
    expect(stripTexComments("a % b\nc")).toBe("a \nc");
    expect(stripTexComments("50\\% off % note")).toBe("50\\% off ");
  });
});

describe("decodeCarets", () => {
  it("16 進と XOR 64 の両表記を戻す", () => {
    expect(decodeCarets("^^41")).toBe("A");
    expect(decodeCarets("\\^^64irectlua")).toBe("\\directlua");
  });
});
