import { describe, it, expect } from "vitest";
import {
  findUnsafeTexCommands,
  findUnsafeSupportCommands,
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

describe("大小文字を畳む csname 照合（ラウンド4 の回避を塞ぐ）", () => {
  it("\\lowercase{\\csname OPENIN\\endcsname} を検出する", () => {
    // TeX の \lowercase は文字トークンだけを畳むので、実行時には \openin になる。
    const tex = String.raw`\newread\myin \lowercase{\csname OPENIN\endcsname}\myin=/etc/hosts \read\myin to\x`;
    expect(findUnsafeTexCommands(tex)).toContain("openin");
  });

  it("大文字・混在・空白入りの csname も拾う", () => {
    expect(findUnsafeTexCommands(String.raw`\csname DirectLua\endcsname`)).toContain("directlua");
    expect(findUnsafeTexCommands(String.raw`\csname  openin \endcsname`)).toContain("openin");
  });

  it("制御綴りそのものは大小文字を区別する（\\OPENIN は別のコマンド）", () => {
    // \OPENIN は \openin ではない。ここで畳むと正規のマクロ名を誤検知する。
    expect(findUnsafeTexCommands(String.raw`\newcommand{\OPENIN}{x}`)).toEqual([]);
  });
});

describe("findUnsafeSupportCommands（同梱 .sty/.cls 向けの狭い denylist）", () => {
  it("任意読み出しと Lua 実行を検出する", () => {
    expect(findUnsafeSupportCommands(String.raw`\directlua{io.open("/etc/hosts")}`)).toContain(
      "directlua",
    );
    expect(findUnsafeSupportCommands(String.raw`\openin\x=/etc/hosts`)).toContain("openin");
  });

  it("\\write / \\openout は対象外（正規のクラスファイルが日常的に使う）", () => {
    // 書き込み先は openout_any=p で build ツリーへ閉じ込め済み。ここで落とすと
    // elsarticle.cls / IEEEtran.cls / llncs.cls を同梱した論文が翻訳できなくなる。
    expect(findUnsafeSupportCommands(String.raw`\newwrite\tf@toc \immediate\write\tf@toc{x}`)).toEqual(
      [],
    );
    expect(findUnsafeSupportCommands(String.raw`\openout15=\jobname.aux`)).toEqual([]);
  });
});
