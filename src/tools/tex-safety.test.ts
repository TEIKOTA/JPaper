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

describe("読み込みコマンド（\\input 系）の判定", () => {
  it("\\csname で綴りを組み立てた読み込みは引数に関わらず落とす", () => {
    // expandInputs の正規表現をすり抜けてプリアンブルに残る経路。
    expect(findUnsafeTexCommands(String.raw`\csname input\endcsname{/etc/passwd}`)).toContain(
      "input",
    );
    expect(findUnsafeTexCommands(String.raw`\lowercase{\csname INPUT\endcsname{x}}`)).toContain(
      "input",
    );
    expect(findUnsafeSupportCommands(String.raw`\csname input\endcsname{secret}`)).toContain(
      "input",
    );
  });

  it("build ツリーの外を指す引数を落とす（括弧なしの TeX 形式も）", () => {
    expect(findUnsafeTexCommands(String.raw`\input{/etc/passwd}`)).toContain("input");
    expect(findUnsafeTexCommands(String.raw`\input /etc/passwd `)).toContain("input");
    expect(findUnsafeTexCommands(String.raw`\include{../../secret}`)).toContain("include");
    expect(findUnsafeTexCommands(String.raw`\input{~/.ssh/id_rsa}`)).toContain("input");
    expect(findUnsafeTexCommands(String.raw`\InputIfFileExists{/proc/self/environ}{}{}`)).toContain(
      "InputIfFileExists",
    );
  });

  it("build ツリー内を指す正規の読み込みは通す（誤検知で論文を落とさない）", () => {
    expect(findUnsafeTexCommands(String.raw`\input{chapters/intro.tex}\include{sec2}`)).toEqual([]);
    expect(findUnsafeSupportCommands(String.raw`\input{myclass.def}`)).toEqual([]);
    // ..を含む語であってもパス区切りで分かれていなければ別物。
    expect(findUnsafeTexCommands(String.raw`\input{fig..old/x}`)).toEqual([]);
  });

  it("\\csname の本体全体でのみ照合する（部分一致で配布 .sty を落とさない）", () => {
    expect(findUnsafeTexCommands(String.raw`\csname my-input\endcsname`)).toEqual([]);
    expect(findUnsafeTexCommands(String.raw`\csname the@input\endcsname`)).toEqual([]);
  });
});

describe("読み込みコマンドの引数（多引数・マクロ）", () => {
  it("\\import は第 2 引数も検査する（第 1 引数を無害に見せる回避を塞ぐ）", () => {
    // 実機の latexmk でビルドツリー外の読み取りと PDF への流出を確認した綴り。
    expect(findUnsafeTexCommands(String.raw`\import{./}{../host/secret}`)).toContain("import");
    expect(findUnsafeTexCommands(String.raw`\subimport{./}{/etc/passwd}`)).toContain("subimport");
    expect(findUnsafeTexCommands(String.raw`\import{sections/}{intro.tex}`)).toEqual([]);
  });

  it("main.tex では引数が制御綴りの読み込みを落とす（静的に検証できない）", () => {
    expect(findUnsafeTexCommands(String.raw`\def\p{/x/secret}\input\p`)).toContain("input");
    expect(findUnsafeTexCommands(String.raw`\InputIfFileExists{\p}{}{}`)).toContain(
      "InputIfFileExists",
    );
  });

  it("連続する読み込みを引数と誤認しない", () => {
    expect(findUnsafeTexCommands(String.raw`\input{chapters/intro.tex}\include{sec2}`)).toEqual([]);
  });

  it("同梱 .sty/.cls ではマクロ引数を許す（配布クラスが日常的に使う）", () => {
    // \InputIfFileExists{\@filef@und} 形は配布クラス 18 件中 10 件が使う。ここで落とすと
    // 会議テンプレを同梱した正規の論文が翻訳できなくなる。絶対パス・.. は引き続き落とす。
    expect(findUnsafeSupportCommands(String.raw`\InputIfFileExists{\@filef@und}{}{}`)).toEqual([]);
    expect(findUnsafeSupportCommands(String.raw`\import{./}{../secret}`)).toContain("import");
  });
});

describe("TeX の空白（改行・CR）を挟む回避", () => {
  const nl = "\n";

  it("コマンドと引数の間の改行・CR を読み飛ばして判定する", () => {
    // TeX のファイル名スキャナは改行も読み飛ばすので、空白だけ飛ばすと引数が空に見える。
    expect(findUnsafeTexCommands(`\\input${nl}/etc/hostname`)).toContain("input");
    expect(findUnsafeTexCommands("\\input\r/etc/hostname")).toContain("input");
    expect(findUnsafeTexCommands(`\\@@input${nl}../../../etc/hostname`)).toContain("@@input");
  });

  it("改行を挟んだ正規の読み込みは通す", () => {
    expect(
      findUnsafeTexCommands(`\\input{chapters/intro.tex}${nl}\\include{sec2}${nl}`),
    ).toEqual([]);
  });
});

describe("\\csname の本体にマクロを挟む回避", () => {
  it("綴りが実行時に決まる \\csname は main.tex では拒否する", () => {
    // \def\x{directlua}\csname\x\endcsname は実機で \directlua として発火し、
    // io.open による任意ファイル読み出しが PDF に出ることを確認した。
    expect(findUnsafeTexCommands(String.raw`\def\x{directlua}\csname\x\endcsname{io.open("/etc/passwd")}`)).toContain(
      "csname",
    );
    expect(findUnsafeTexCommands(String.raw`\csname\romannumeral0 directlua\endcsname{x}`)).toContain("csname");
    expect(findUnsafeTexCommands(String.raw`\def\x{input}\csname\x\endcsname{/etc/passwd}`)).toContain("csname");
  });

  it("静的に決まる \\csname は従来どおり名前で判定する", () => {
    expect(findUnsafeTexCommands(String.raw`\csname directlua\endcsname`)).toEqual(["directlua"]);
    expect(findUnsafeTexCommands(String.raw`\csname section\endcsname`)).toEqual([]);
  });

  it("同梱 .sty/.cls には適用しない（配布クラスが日常的に使う）", () => {
    // 実測: 配布 18 件のうち 12 件が \csname の本体に制御綴りを含む。ここで落とすと
    // 会議テンプレを同梱した正規の論文が通らなくなる。
    expect(findUnsafeSupportCommands(String.raw`\csname\@currenvir\endcsname`)).toEqual([]);
  });

  it("正常なプリアンブルは通す", () => {
    expect(
      findUnsafeTexCommands(
        String.raw`\documentclass{article}\usepackage{amsmath}\newcommand\x{y}\begin{document}A\end{document}`,
      ),
    ).toEqual([]);
  });
});

describe("走査コストの上限", () => {
  it("閉じない \\input{ の羅列で二次にならない", () => {
    // 引数の閉じ波括弧を末尾まで探していた頃は マッチ数 × 末尾走査 = O(n²) で、
    // 4MiB の支援ファイルが 20,040ms、6.3KB のアップロードで 40 秒止まった。
    const tex = "\\input{".repeat(Math.floor((4 * 1024 * 1024) / 7));
    const started = Date.now();
    expect(() => findUnsafeSupportCommands(tex)).toThrowError(/上限/);
    expect(() => findUnsafeTexCommands(tex)).toThrowError(/上限/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("実在の論文規模の \\input 件数は通す", () => {
    const tex = Array.from({ length: 500 }, (_, i) => `\\input{sec/s${String(i)}}`).join("\n");
    expect(findUnsafeTexCommands(tex)).toEqual([]);
  });
});

