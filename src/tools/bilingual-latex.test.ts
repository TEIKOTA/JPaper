import { describe, it, expect } from "vitest";
import {
  splitParagraphs,
  balanceParagraphs,
  paragraphsOf,
  pairSegments,
  provideCommands,
  dropLabels,
  titleOf,
  bilingualPreamble,
  renderPairs,
  paracolBody,
  titleBlock,
  assembleBilingual,
  muteBibliography,
  replaceFrontmatter,
} from "./bilingual-latex.js";
import { findUnsafeTexCommands } from "./tex-safety.js";

describe("段落分割", () => {
  it("空行（空白だけの行を含む）で割り、空の段落は捨てる", () => {
    expect(splitParagraphs("a\nb\n\nc\n  \n\t\nd\n\n\n")).toEqual(["a\nb", "c", "d"]);
  });

  it("\\begin と \\end の数が揃うまでつなぎ直す", () => {
    const paras = [
      "前",
      "\\begin{table}\n\\begin{tabular}{ll}\na & b \\\\",
      "c & d\n\\end{tabular}\n\\end{table}",
      "後",
    ];
    expect(balanceParagraphs(paras)).toEqual([
      "前",
      "\\begin{table}\n\\begin{tabular}{ll}\na & b \\\\\n\nc & d\n\\end{tabular}\n\\end{table}",
      "後",
    ]);
  });

  it("% コメント内の \\begin は数えない", () => {
    expect(balanceParagraphs(["a % \\begin{x}", "b"])).toEqual(["a % \\begin{x}", "b"]);
  });

  it("エスケープした \\% の後ろは数える", () => {
    expect(balanceParagraphs(["5\\% \\begin{x}", "y \\end{x}", "z"])).toEqual([
      "5\\% \\begin{x}\n\ny \\end{x}",
      "z",
    ]);
  });

  it("閉じない環境は末尾までまとめ、\\end が余った段落の後は深さを 0 に戻す", () => {
    expect(balanceParagraphs(["\\end{x} a", "b", "\\begin{y}", "c"])).toEqual([
      "\\end{x} a",
      "b",
      "\\begin{y}\n\nc",
    ]);
  });

  it("波括弧の中の空行（複数段落の脚注・色付きの群）では割らない", () => {
    expect(paragraphsOf("Alpha.\\footnote{Alpha.\n\nBeta.} More.\n\nNext.")).toEqual([
      "Alpha.\\footnote{Alpha.\n\nBeta.} More.",
      "Next.",
    ]);
    expect(paragraphsOf("{\\color{blue} a\n\nb}\n\nc")).toEqual(["{\\color{blue} a\n\nb}", "c"]);
  });

  it("エスケープした波括弧とコメント内の波括弧は数えない", () => {
    expect(balanceParagraphs(["a \\{", "b % {", "c \\\\{", "d}", "e"])).toEqual([
      "a \\{",
      "b % {",
      "c \\\\{\n\nd}",
      "e",
    ]);
  });

  it("段落の対応は脚注の中の空行で崩れない", () => {
    const r = pairSegments(
      [{ id: "seg-0000", tex: "Alpha.\\footnote{Alpha.\n\nBeta.} More.\n\nNext." }],
      [{ id: "seg-0000", tex: "甲。\\footnote{甲。\n\n乙。}続き。\n\n次。" }],
    );
    expect(r.fallbackSegments).toEqual([]);
    expect(r.pairs.map((p) => p.right)).toEqual(["甲。\\footnote{甲。\n\n乙。}続き。", "次。"]);
  });

  it("数式環境内の空行は割らない", () => {
    expect(paragraphsOf("a\n\n\\begin{align}\nx\n\ny\n\\end{align}")).toEqual([
      "a",
      "\\begin{align}\nx\ny\n\\end{align}",
    ]);
  });
});

describe("段落ペア", () => {
  it("段落数が一致すれば段落ごとにペアにする", () => {
    const r = pairSegments(
      [{ id: "seg-0000", tex: "A1\n\nA2" }],
      [{ id: "seg-0000", tex: "和1\n\n和2" }],
    );
    expect(r.fallbackSegments).toEqual([]);
    expect(r.pairs).toEqual([
      { segmentId: "seg-0000", left: "A1", right: "和1" },
      { segmentId: "seg-0000", left: "A2", right: "和2" },
    ]);
  });

  it("段落数が一致しなければセグメント全体を 1 ペアにし、id を返す", () => {
    const r = pairSegments(
      [
        { id: "seg-0000", tex: "A1\n\nA2" },
        { id: "seg-0001", tex: "B" },
      ],
      [
        { id: "seg-0000", tex: "和1" },
        { id: "seg-0001", tex: "乙" },
      ],
    );
    expect(r.fallbackSegments).toEqual(["seg-0000"]);
    expect(r.pairs).toEqual([
      { segmentId: "seg-0000", left: "A1\n\nA2", right: "和1" },
      { segmentId: "seg-0001", left: "B", right: "乙" },
    ]);
  });

  it("原文に無いセグメント（訳注一覧）は左を空にする", () => {
    const r = pairSegments(
      [{ id: "seg-0000", tex: "A" }],
      [
        { id: "seg-0000", tex: "和" },
        { id: "backmatter", tex: "\\section*{訳注一覧}\n\n\\begin{itemize}\n\\item x\n\\end{itemize}" },
      ],
    );
    expect(r.fallbackSegments).toEqual([]);
    expect(r.pairs[1]).toEqual({
      segmentId: "backmatter",
      left: "",
      right: "\\section*{訳注一覧}\n\n\\begin{itemize}\n\\item x\n\\end{itemize}",
    });
  });
});

describe("訳文側の \\label 削除", () => {
  it("ラベルだけの行は行ごと消し、align* の中に空行を作らない", () => {
    const src = "\\begin{align*}\n    a &= b,\n    \\label{eq:dann}\n\\end{align*}";
    expect(dropLabels(src)).toBe("\\begin{align*}\n    a &= b,\n\\end{align*}");
  });

  it("行内のラベルは命令だけ消し、\\ref は残す", () => {
    expect(dropLabels("\\section{序論}\\label{sec:intro} 式~\\ref{eq:a} を見よ。")).toBe(
      "\\section{序論} 式~\\ref{eq:a} を見よ。",
    );
  });
});

describe("\\providecommand 置換", () => {
  it("\\newcommand と \\newcommand* を置き換え、似た名前は残す", () => {
    expect(provideCommands("\\newcommand{\\a}{1}\\newcommand*{\\b}{2}\\newcommandx{\\c}{3}")).toBe(
      "\\providecommand{\\a}{1}\\providecommand*{\\b}{2}\\newcommandx{\\c}{3}",
    );
  });

  it("訳文側（右）だけを置き換える", () => {
    const {
      blocks: [block],
    } = renderPairs([{ segmentId: "s", left: "\\newcommand{\\a}{1}", right: "\\newcommand{\\a}{1}" }], {
      left: "",
      right: "",
    });
    expect(block).toBe("\\newcommand{\\a}{1}\n\\switchcolumn\n\\providecommand{\\a}{1}\n\\switchcolumn*");
  });
});

describe("タイトル", () => {
  it("前文の最後の \\title の中身を波括弧の対応で取り出す", () => {
    expect(titleOf("\\title{}\n\\title[short]{A {B} \\{C}\n\\author{x}")).toBe("A {B} \\{C");
  });

  it("\\titlerunning などは \\title として扱わない", () => {
    expect(titleOf("\\titlerunning{x}")).toBeUndefined();
  });

  it("段落が \\maketitle だけのペアを、前文の \\title から作ったタイトルブロックに置き換える", () => {
    const { blocks, titled } = renderPairs(
      [
        { segmentId: "s", left: "\\maketitle", right: "\\maketitle" },
        { segmentId: "s", left: "A", right: "和" },
      ],
      { left: "\\title{Title}", right: "\\title{題}" },
    );
    expect(titled).toBe(true);
    expect(blocks).toEqual([titleBlock("Title", "題"), "A\n\\switchcolumn\n和\n\\switchcolumn*"]);
    expect(blocks[0]).toBe("\\jpTitleBlock{Title}\n\\switchcolumn\n\\jpTitleBlock{題}\n\\switchcolumn*");
  });

  it("\\maketitle で始まる段落はタイトルブロックと残りに分ける", () => {
    const { blocks } = renderPairs([{ segmentId: "s", left: "\\maketitle\nA", right: "\\maketitle\n和" }], {
      left: "\\title{T}",
      right: "\\title{題}",
    });
    expect(blocks).toEqual([titleBlock("T", "題"), "A\n\\switchcolumn\n和\n\\switchcolumn*"]);
  });

  it("本文の \\title と同じ段落の \\maketitle: 前を残し、本文の \\title でタイトルブロックを作る", () => {
    const { blocks, titled } = renderPairs(
      [
        {
          segmentId: "s",
          left: "\\title{The Real Title}\n\\author{Ann\\thanks{x}}\n\\maketitle\n\\section{Intro}",
          right: "\\title{本当の題}\n\\author{Ann\\thanks{x}}\n\\maketitle\n\\section{はじめに}",
        },
      ],
      { left: "\\documentclass{article}\n", right: "\\documentclass{article}\n\\title{}\n" },
    );
    expect(titled).toBe(true);
    expect(blocks).toEqual([
      "\\title{The Real Title}\n\\author{Ann\\thanks{x}}\n\\switchcolumn\n\\title{本当の題}\n\\author{Ann\\thanks{x}}\n\\switchcolumn*",
      titleBlock("The Real Title", "本当の題"),
      "\\section{Intro}\n\\switchcolumn\n\\section{はじめに}\n\\switchcolumn*",
    ]);
  });

  it("\\title と \\maketitle が別の段落でも、本文の \\title でタイトルブロックを作る", () => {
    const { blocks } = renderPairs(
      [
        { segmentId: "s", left: "\\title{T}\n\\author{Ann}", right: "\\title{題}\n\\author{Ann}" },
        { segmentId: "s", left: "\\maketitle", right: "\\maketitle" },
      ],
      { left: "", right: "" },
    );
    expect(blocks).toEqual([
      "\\title{T}\n\\author{Ann}\n\\switchcolumn\n\\title{題}\n\\author{Ann}\n\\switchcolumn*",
      titleBlock("T", "題"),
    ]);
  });

  it("コメント内の \\maketitle と、環境・波括弧の中の \\maketitle は置き換えない", () => {
    const pairs = [
      { segmentId: "s", left: "% \\maketitle\nA", right: "% \\maketitle\n和" },
      {
        segmentId: "s",
        left: "\\begin{center}\n\\title{T}\n\\maketitle\n\\end{center}",
        right: "\\begin{center}\n\\title{題}\n\\maketitle\n\\end{center}",
      },
      { segmentId: "s", left: "{\\maketitle}", right: "{\\maketitle}" },
    ];
    const { blocks, titled } = renderPairs(pairs, { left: "", right: "" });
    expect(titled).toBe(false);
    expect(blocks).toEqual(pairs.map((p) => `${p.left}\n\\switchcolumn\n${p.right}\n\\switchcolumn*`));
  });

  it("タイトルブロックは題の \\thanks も潰す", () => {
    expect(bilingualPreamble("")).toContain("\\bfseries\\begingroup\\let\\thanks\\@gobble #1\\endgroup");
  });

  it("環境の中の \\maketitle のようにタイトルブロックへ置き換えられなければ titleUnplaced で知らせる", () => {
    const boxed = "\\begin{center}\n\\maketitle\n\\end{center}";
    const out = assembleBilingual({
      cleanLatex: "\\documentclass{article}\\title{T}\\begin{document}\\end{document}",
      translatedMainTex: "\\documentclass{article}\\title{題}\n\\begin{document}\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: `${boxed}\n\nA` }],
      translated: [{ id: "seg-0000", tex: `${boxed}\n\n和` }],
    });
    expect(out.titleUnplaced).toBe(true);
    const plain = assembleBilingual({
      cleanLatex: "\\documentclass{article}\\begin{document}\\end{document}",
      translatedMainTex: "\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "% \\maketitle\nA" }],
      translated: [{ id: "seg-0000", tex: "和" }],
    });
    expect(plain.titleUnplaced).toBe(false);
  });
});

describe("elsarticle の frontmatter", () => {
  const front = (title: string) =>
    `\\begin{frontmatter}\n\\title{${title}}\n\\author[a]{Ann\\corref{c1}}\n\\cortext[c1]{Corr}\n\n\\begin{abstract}\nX\n\\end{abstract}\n\\end{frontmatter}`;

  it("左右それぞれの frontmatter を列の中で組む jpFrontmatter に置き換え、見出しを左右の言語で渡す", () => {
    expect(replaceFrontmatter(front("T"), "left")).toBe(
      front("T")
        .replace("\\begin{frontmatter}", "\\begin{jpFrontmatter}{Abstract}{Keywords}")
        .replace("\\end{frontmatter}", "\\end{jpFrontmatter}"),
    );
    expect(replaceFrontmatter(front("題"), "right")).toContain("\\begin{jpFrontmatter}{概要}{キーワード}");
    expect(replaceFrontmatter(front("題"), "right")).not.toContain("{frontmatter}");
  });

  it("frontmatter のペアをタイトルとして扱い、titleUnplaced にしない", () => {
    const out = assembleBilingual({
      cleanLatex: "\\documentclass{elsarticle}\\begin{document}\\end{document}",
      translatedMainTex: "\\documentclass{elsarticle}\n\\begin{document}\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: `${front("T")}\n\nA` }],
      translated: [{ id: "seg-0000", tex: `${front("題")}\n\n和` }],
    });
    expect(out.titleUnplaced).toBe(false);
    expect(out.mainTex).toContain("\\begin{jpFrontmatter}{Abstract}{Keywords}\n\\title{T}");
    expect(out.mainTex).toContain("\\switchcolumn\n\\begin{jpFrontmatter}{概要}{キーワード}\n\\title{題}");
    expect(out.mainTex).not.toContain("\\begin{frontmatter}");
    expect(out.pairs).toBe(2);
  });

  it("コメント内の \\begin{frontmatter} はタイトルとして扱わない", () => {
    const { titled } = renderPairs([{ segmentId: "s", left: "% \\begin{frontmatter}\nA", right: "和" }], {
      left: "",
      right: "",
    });
    expect(titled).toBe(false);
  });

  it("前文の jpFrontmatter は著者の脚注系コマンドを列の中で潰し、abstract・keyword をその場で組む", () => {
    const pre = bilingualPreamble("");
    expect(pre).toContain("\\newenvironment{jpFrontmatter}[2]{");
    for (const s of ["\\let\\corref\\@gobble", "\\let\\cortext\\jp@gobbleom", "\\let\\tnoteref\\@gobble", "\\let\\ead\\jp@gobbleom"]) {
      expect(pre).toContain(s);
    }
    expect(pre).toContain("\\def\\abstract{\\jp@fmhead");
    expect(pre).toContain("\\def\\keyword{\\jp@fmhead");
  });
});

describe("参考文献と脚注", () => {
  it("右の \\bibliography / \\bibliographystyle は .aux へ書かない形で包む", () => {
    expect(muteBibliography("\\bibliographystyle{unsrt}\n\\bibliography{ref,more}")).toBe(
      "\\jpNoAux{\\bibliographystyle{unsrt}}\n\\jpNoAux{\\bibliography{ref,more}}",
    );
    expect(muteBibliography("\\bibliographyfoo{x}")).toBe("\\bibliographyfoo{x}");
  });

  it("包むのは右（和訳）だけで、左は原文のまま", () => {
    const { blocks } = renderPairs([{ segmentId: "s", left: "\\bibliography{ref}", right: "\\bibliography{ref}" }], {
      left: "",
      right: "",
    });
    expect(blocks).toEqual(["\\bibliography{ref}\n\\switchcolumn\n\\jpNoAux{\\bibliography{ref}}\n\\switchcolumn*"]);
    expect(bilingualPreamble("")).toContain("\\newcommand{\\jpNoAux}[1]{\\begingroup\\@fileswfalse#1\\endgroup}");
  });

  it("paracol の先頭で脚注命令を頑丈にする（見出しの中の訳注脚注のため）", () => {
    expect(paracolBody(["A"])).toBe("\\begin{paracol}{2}\n\\jpRobustNotes\nA\n\\end{paracol}\n");
    expect(bilingualPreamble("")).toContain("\\MakeRobust\\footnote\\MakeRobust\\footnotemark\\MakeRobust\\footnotetext");
  });
});

describe("paracol 本文", () => {
  it("行が無ければ paracol を作らない", () => {
    expect(paracolBody([])).toBe("");
  });

  it("タイトルが本文先頭でも空の paracol を作らない", () => {
    const out = assembleBilingual({
      cleanLatex: "\\documentclass{article}\\title{T}\\begin{document}\\maketitle\\end{document}",
      translatedMainTex: "\\documentclass{article}\\title{題}\n\\begin{document}\n\\maketitle\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "\\maketitle\n\nA" }],
      translated: [{ id: "seg-0000", tex: "\\maketitle\n\n和" }],
    });
    expect(out.mainTex).not.toMatch(/\\begin\{paracol\}\{2\}\s*\\end\{paracol\}/);
    expect(out.mainTex.match(/\\begin\{paracol\}/g)).toHaveLength(1);
    expect(out.mainTex).toContain(`\\begin{paracol}{2}\n\\jpRobustNotes\n${titleBlock("T", "題")}\n\n`);
    expect(out.pairs).toBe(2);
  });
});

describe("前文", () => {
  it("和訳の前文に paracol・eso-pic・geometry・タイトルブロック・非フロート差し替えを足す", () => {
    const pre = bilingualPreamble("\\documentclass{article}\n\\usepackage{x}\n\n");
    expect(pre.startsWith("\\documentclass{article}\n\\usepackage{x}\n")).toBe(true);
    for (const s of [
      "\\usepackage{paracol}",
      "\\usepackage{eso-pic}",
      "\\geometry{onecolumn,paperwidth=420mm,paperheight=297mm",
      "\\setlength{\\columnsep}{",
      "\\newcommand{\\jpTitleBlock}",
      "\\renewenvironment{figure}[1][]{",
      "\\renewenvironment{figure*}[1][]{",
      "\\renewenvironment{table}[1][]{",
      "\\renewenvironment{table*}[1][]{",
      "\\def\\@captype{figure}",
      "\\def\\@captype{table}",
    ]) {
      expect(pre).toContain(s);
    }
  });

  it("組み立てた main.tex は和訳の前文を使い、本文先頭で紙面と左右のページ番号を設定する", () => {
    const out = assembleBilingual({
      cleanLatex: "\\documentclass{article}\\begin{document}A\\end{document}",
      translatedMainTex: "\\RequirePackage{luatex85}\n\\documentclass{article}\n\\usepackage[ipaex]{luatexja-preset}\n\\begin{document}\n和\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "A" }],
      translated: [{ id: "seg-0000", tex: "和" }],
    });
    expect(out.mainTex.startsWith("\\RequirePackage{luatex85}\n\\documentclass{article}\n\\usepackage[ipaex]{luatexja-preset}\n")).toBe(true);
    const body = out.mainTex.slice(out.mainTex.indexOf("\\begin{document}"));
    expect(body).toContain("\\newgeometry{onecolumn,paperwidth=420mm,paperheight=297mm");
    expect(body).toContain("\\pagestyle{empty}");
    expect(body).toContain("\\AddToShipoutPictureFG{");
    expect(body).not.toContain("\\AddToShipoutPictureFG*");
    expect(body).toContain("原文 p.\\thepage");
    expect(body).toContain("和訳 p.\\thepage");
    expect(body).toContain("\\begin{paracol}{2}\n\\jpRobustNotes\nA\n\\switchcolumn\n和\n\\switchcolumn*\n\\end{paracol}\n\\end{document}\n");
    expect(out.mainTex.match(/\\begin\{document\}/g)).toHaveLength(1);
    expect(out.fallbackSegments).toEqual([]);
  });

  it("二段組の原プリアンブルでも、前文と本文先頭の両方で一段組に戻す", () => {
    const out = assembleBilingual({
      cleanLatex: "\\documentclass[twocolumn]{article}\\begin{document}A\\end{document}",
      translatedMainTex: "\\documentclass[twocolumn]{article}\n\\begin{document}\n和\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "A" }],
      translated: [{ id: "seg-0000", tex: "和" }],
    });
    const at = out.mainTex.indexOf("\\begin{document}");
    expect(out.mainTex.slice(0, at)).toContain("\\geometry{onecolumn,");
    expect(out.mainTex.slice(at)).toContain("\\newgeometry{onecolumn,");
  });

  it("注入する部品は組版の安全検査に掛からない", () => {
    const out = assembleBilingual({
      cleanLatex: "\\documentclass{article}\\begin{document}A\\end{document}",
      translatedMainTex: "\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "A" }],
      translated: [{ id: "seg-0000", tex: "和" }],
    });
    expect(findUnsafeTexCommands(out.mainTex)).toEqual([]);
  });
});
