import { describe, it, expect } from "vitest";
import { detectProfile } from "./frontmatter.js";
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
  unwrapTitleBlock,
  splitAtConditionals,
  pairAcrossConditionals,
  conditionalsBalanced,
  conditionalsSplittable,
  conditionalLinesNest,
  isConditionalLine,
  conditionalNamesDeclared,
  separateAcronyms,
  usesAcronymPackage,
  acronymKeysOf,
} from "./bilingual-latex.js";
import { findUnsafeTexCommands } from "./tex-safety.js";
import { fastestMs } from "../testing/timing.js";

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

describe("列の切り替え", () => {
  it("右の列が [ で始まると \\switchcolumn の引数に読まれないよう \\relax を挟む（契約付録 §8 PDF 入力）", () => {
    const pair = (right: string) =>
      renderPairs([{ segmentId: "s", left: "As shown in [BCN18], x.", right }], { left: "", right: "" }).blocks[0];
    expect(pair("[BCN18] で示されているように、x。")).toBe(
      "As shown in [BCN18], x.\n\\switchcolumn\n\\relax\n[BCN18] で示されているように、x。\n\\switchcolumn*",
    );
    expect(pair("x は [BCN18] で示された。")).toBe(
      "As shown in [BCN18], x.\n\\switchcolumn\nx は [BCN18] で示された。\n\\switchcolumn*",
    );
  });
});

describe("タイトル", () => {
  it("前文の最後の \\title の中身を波括弧の対応で取り出す", () => {
    expect(titleOf("\\title{}\n\\title[short]{A {B} \\{C}\n\\author{x}")).toBe("A {B} \\{C");
  });

  it("\\titlerunning などは \\title として扱わない", () => {
    expect(titleOf("\\titlerunning{x}")).toBeUndefined();
  });

  it("型の表のタイトルの命令から取り出し、コメントの中の \\title は数えない", () => {
    expect(titleOf("\\Title{Deep}\n\\TitleCitation{x}", ["Title"])).toBe("Deep");
    expect(titleOf("\\title{Real}\n% \\title{Old}")).toBe("Real");
  });

  it("\\maketitle がタイトルを組まない型（iopart）では \\maketitle をタイトルブロックに置き換えない", () => {
    const profile = detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}");
    const { blocks, titled } = renderPairs(
      [{ segmentId: "s", left: "\\title{T}\n\\maketitle", right: "\\title{題}\n\\maketitle" }],
      { left: "", right: "" },
      profile,
    );
    expect(titled).toBe(false);
    expect(blocks).toEqual(["\\title{T}\n\\maketitle\n\\switchcolumn\n\\title{題}\n\\maketitle\n\\switchcolumn*"]);
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
    // 著者欄は表の外で組むので、\and 系を区切りの空白にしてから展開する（issue #324）。
    expect(bilingualPreamble("")).toContain(
      "\\begingroup\\let\\thanks\\@gobble\\def\\and{\\unskip\\quad}\\let\\And\\and\\def\\AND{\\unskip\\par}#2\\endgroup",
    );
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
    const iop = assembleBilingual({
      cleanLatex: "\\documentclass{iopart}\\begin{document}\\end{document}",
      translatedMainTex: "\\documentclass{iopart}\n\\begin{document}\n\\end{document}\n",
      source: [{ id: "seg-0000", tex: "\\title{T}\n\\maketitle\n\nA" }],
      translated: [{ id: "seg-0000", tex: "\\title{題}\n\\maketitle\n\n和" }],
    });
    expect(iop.titleUnplaced).toBe(false);
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
    expect(paracolBody(["A"])).toBe("\\begin{paracol}{2}\n\\setlength{\\textwidth}{\\columnwidth}\n\\jpRobustNotes\nA\n\\end{paracol}\n");
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
    expect(out.mainTex).toContain(`\\begin{paracol}{2}\n\\setlength{\\textwidth}{\\columnwidth}\n\\jpRobustNotes\n${titleBlock("T", "題")}\n\n`);
    expect(out.pairs).toBe(2);
  });
});

describe("前文", () => {
  it("和訳の前文に paracol・eso-pic・geometry・タイトルブロック・非フロート差し替えを足す", () => {
    const pre = bilingualPreamble("\\documentclass{article}\n\\usepackage{x}\n\n");
    expect(pre.startsWith("\\PassOptionsToPackage{draft}{hyperref} % JPaper 注入: 対訳はリンクを作らない\n\\documentclass{article}\n\\usepackage{x}\n")).toBe(true);
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
    expect(out.mainTex.startsWith("\\PassOptionsToPackage{draft}{hyperref} % JPaper 注入: 対訳はリンクを作らない\n\\RequirePackage{luatex85}\n\\documentclass{article}\n\\usepackage[ipaex]{luatexja-preset}\n")).toBe(true);
    const body = out.mainTex.slice(out.mainTex.indexOf("\\begin{document}"));
    expect(body).toContain("\\newgeometry{onecolumn,paperwidth=420mm,paperheight=297mm");
    expect(body).toContain("\\pagestyle{empty}");
    expect(body).toContain("\\AddToShipoutPictureFG{");
    expect(body).not.toContain("\\AddToShipoutPictureFG*");
    expect(body).toContain("原文 p.\\thepage");
    expect(body).toContain("和訳 p.\\thepage");
    expect(body).toContain("\\begin{paracol}{2}\n\\setlength{\\textwidth}{\\columnwidth}\n\\jpRobustNotes\nA\n\\switchcolumn\n和\n\\switchcolumn*\n\\end{paracol}\n\\end{document}\n");
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

describe("ICML のタイトルブロック（契約付録 §7・§8）", () => {
  const ICML_PRE = "\\documentclass{article}\n\\usepackage[accepted]{icml2023}\n";
  const icml = detectProfile(`${ICML_PRE}\\begin{document}\n\\end{document}`);
  const block = (title: string) =>
    [
      "\\twocolumn[",
      `\\icmltitle{${title}}`,
      "",
      "\\icmlsetsymbol{equal}{*}",
      "",
      "\\begin{icmlauthorlist}",
      "\\icmlauthor{Ann Lee}{tor}",
      "\\end{icmlauthorlist}",
      "",
      "\\icmlaffiliation{tor}{University of Toronto}",
      "\\icmlkeywords{Machine Learning, [x]}",
      "\\vskip 0.3in",
      "]",
      "",
      "\\printAffiliationsAndNotice{}",
    ].join("\n");

  it("\\icmltitle を含む \\twocolumn[…] を外し、中身を段の中に残す", () => {
    const out = unwrapTitleBlock(block("Fast Things"), icml);
    expect(out).not.toContain("\\twocolumn");
    expect(out.startsWith("\n\n\\icmltitle{Fast Things}")).toBe(true);
    expect(out).toContain("\\vskip 0.3in\n\n\n\n\\printAffiliationsAndNotice{}");
    expect(unwrapTitleBlock("\\twocolumn[\\icmltitle{T}\\par]abc", icml)).toBe("\n\\icmltitle{T}\\par\nabc");
  });

  it.each([
    ["波括弧の中の対にならない角括弧", "\\twocolumn[\\icmltitle{T}\\icmlkeywords{[0,1)}]X", "\n\\icmltitle{T}\\icmlkeywords{[0,1)}\nX"],
    ["コメントの中の ]", "\\twocolumn[\\icmltitle{T} % ]\n]X", "\n\\icmltitle{T} % ]\n\nX"],
    ["\\] と \\[", "\\twocolumn[\\icmltitle{T} \\[x\\] ]X", "\n\\icmltitle{T} \\[x\\] \nX"],
    ["エスケープした \\% と \\{", "\\twocolumn[\\icmltitle{T} 50\\% \\{]X", "\n\\icmltitle{T} 50\\% \\{\nX"],
    ["タイトルを含まない先の \\twocolumn[…] は飛ばす", "\\twocolumn[\\section*{N}]\n\\twocolumn[\\icmltitle{T}]", "\\twocolumn[\\section*{N}]\n\n\\icmltitle{T}\n"],
  ])("角括弧の対応: %s", (_label, tex, want) => {
    expect(unwrapTitleBlock(tex, icml)).toBe(want);
  });

  it("コメントの中にだけある \\icmltitle では外さない", () => {
    const tex = "\\twocolumn[% \\icmltitle{T}\n\\section*{N}]";
    expect(unwrapTitleBlock(tex, icml)).toBe(tex);
  });

  it("既定の型・タイトルを含まない \\twocolumn[…]・コメントの中の \\twocolumn は外さない", () => {
    expect(unwrapTitleBlock(block("T"))).toBe(block("T"));
    const plain = "\\twocolumn[\\section*{Notes}]\nText";
    expect(unwrapTitleBlock(plain, icml)).toBe(plain);
    const commented = "% \\twocolumn[\nX\n" + block("T");
    expect(unwrapTitleBlock(commented, icml)).toBe("% \\twocolumn[\nX\n" + unwrapTitleBlock(block("T"), icml));
    const unclosed = "\\twocolumn[\\icmltitle{T}";
    expect(unwrapTitleBlock(unclosed, icml)).toBe(unclosed);
  });

  it("左右とも 1 段落ずつのペアになり、角括弧の中で段を切り替えない", () => {
    const { pairs, fallbackSegments } = pairSegments(
      [{ id: "seg-0000", tex: block("Fast Things") }],
      [{ id: "seg-0000", tex: block("速いもの") }],
      icml,
    );
    expect(fallbackSegments).toEqual([]);
    expect(pairs[0]).toEqual({ segmentId: "seg-0000", left: "\\icmltitle{Fast Things}", right: "\\icmltitle{速いもの}" });
    expect(pairs.map((p) => p.left)).toEqual(paragraphsOf(block("Fast Things"), icml));
    expect(pairs.some((p) => p.left.includes("]") && !p.left.includes("["))).toBe(false);
  });

  it("前文に ICML の版面検査を外す手当てと、段をまたぐ所属・連絡先の手当てを足す。ICML でなければ足さない", () => {
    const pre = bilingualPreamble(ICML_PRE, icml);
    expect(pre).toContain("\\RemoveFromHook{begindocument}[icml2023]");
    expect(pre).toContain("\\let\\thispagestyle\\@gobble");
    expect(pre).toContain("\\globalcounter{@affiliationcounter}");
    expect(pre).toContain("\\ifnum\\pcol@currcol=\\z@\\jp@icmlcorr{#1}{#2}\\fi");
    expect(pre).toContain("\\addtocounter{@affiliationcounter}{-1}");
    expect(pre.indexOf("\\RemoveFromHook")).toBeGreaterThan(pre.indexOf("\\usepackage{paracol}"));
    expect(findUnsafeTexCommands(pre)).toEqual([]);
    expect(bilingualPreamble(ICML_PRE)).not.toContain("JPaper 注入: 対訳の ICML 手当て");
    const renamed = "\\documentclass{article}\n\\usepackage{myicml}\n";
    const renamedPre = bilingualPreamble(renamed, detectProfile(`${renamed}\\begin{document}\n\\twocolumn[\\icmltitle{T}]\n\\end{document}`));
    expect(renamedPre).toContain("\\globalcounter{@affiliationcounter}");
    expect(renamedPre).not.toContain("RemoveFromHook");
  });

  it("assembleBilingual は型の表を引いて ICML のタイトルブロックを外す", () => {
    const out = assembleBilingual({
      cleanLatex: `${ICML_PRE}\\begin{document}\n${block("Fast Things")}\n\\end{document}`,
      translatedMainTex: `${ICML_PRE}\\begin{document}\n${block("速いもの")}\n\\end{document}\n`,
      source: [{ id: "seg-0000", tex: block("Fast Things") }],
      translated: [{ id: "seg-0000", tex: block("速いもの") }],
    });
    const body = out.mainTex.slice(out.mainTex.indexOf("\\begin{document}"));
    expect(body).not.toContain("\\twocolumn");
    expect(body).toContain("\\icmltitle{Fast Things}\n\\switchcolumn\n\\icmltitle{速いもの}\n\\switchcolumn*");
    expect(out.titleUnplaced).toBe(false);
  });

  it.each([
    ["コメントの中の \\twocolumn[ を 1 行に", "% " + "\\twocolumn[".repeat(90_000)],
    ["閉じない \\twocolumn[", "\\twocolumn[\\icmltitle{T}" + "x".repeat(1 << 20)],
    ["閉じないコメントの \\twocolumn[ を各行に", "% \\twocolumn[\n".repeat(70_000)],
  ])("走査は入力長に対して線形（%s・1MiB）", (_label, tex) => {
    expect(fastestMs(2, () => void unwrapTitleBlock(tex, icml))).toBeLessThan(2000);
  });
});

// 行ごとに TeX の条件分岐（偽の枝は入れ子の \if… を数えて読み飛ばす）と paracol の段の切り替えをなぞり、
// 実行された行をその段の番号と一緒に返す。truth に無い条件は偽。
function runColumns(body: string, truth: Record<string, boolean> = {}): { col: number; line: string }[] {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const isIf = (l: string): boolean => /^\\if[A-Za-z@]*/.test(l) && !/^\\newif/.test(l);
  const out: { col: number; line: string }[] = [];
  let col = 0;
  // 偽の枝を読み飛ばし、対応する \else（stopAtElse のとき）か \fi の次の位置を返す。
  const skip = (from: number, stopAtElse: boolean): number => {
    let depth = 0;
    for (let i = from; i < lines.length; i++) {
      const l = lines[i]!;
      if (isIf(l)) depth++;
      else if (l === "\\fi") {
        if (depth === 0) return i + 1;
        depth--;
      } else if (l === "\\else" && depth === 0 && stopAtElse) return i + 1;
    }
    return lines.length;
  };
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (isIf(l)) {
      i = truth[l] === true ? i + 1 : skip(i + 1, true);
    } else if (l === "\\else") {
      i = skip(i + 1, false);
    } else if (l === "\\fi") {
      i++;
    } else if (l === "\\switchcolumn" || l === "\\switchcolumn*") {
      col = 1 - col;
      i++;
    } else {
      out.push({ col, line: l });
      i++;
    }
  }
  return out;
}

describe("段落の境目の条件分岐（issue #378）", () => {
  // 2607.28007（MICCAI・llncs）の前付けの形。\ifpeerreview は偽。
  const lncs = [
    { segmentId: "s", left: "\\newif\\ifpeerreview", right: "\\newif\\ifpeerreview" },
    { segmentId: "s", left: "\\ifpeerreview\n\\author{Anon}", right: "\\ifpeerreview\n\\author{Anon}" },
    { segmentId: "s", left: "\\else", right: "\\else" },
    { segmentId: "s", left: "\\author{Real}", right: "\\author{Real}" },
    { segmentId: "s", left: "\\institute{Inst}", right: "\\institute{Inst}" },
    { segmentId: "s", left: "\\fi\n\\maketitle", right: "\\fi\n\\maketitle" },
    { segmentId: "s", left: "Abstract EN", right: "概要" },
  ];

  it("偽の条件の枝を読み飛ばしても左右の段が入れ替わらず、\\else の枝の \\author が両段で実行される", () => {
    const { blocks, titled } = renderPairs(lncs, { left: "\\title{T}", right: "\\title{題}" });
    expect(titled).toBe(true);
    const run = runColumns(blocks.join("\n\n"));
    expect(run).toContainEqual({ col: 0, line: "Abstract EN" });
    expect(run).toContainEqual({ col: 1, line: "概要" });
    expect(run).toContainEqual({ col: 0, line: "\\jpTitleBlock{T}" });
    expect(run).toContainEqual({ col: 1, line: "\\jpTitleBlock{題}" });
    expect(run.filter((x) => x.line === "\\author{Real}").map((x) => x.col)).toEqual([0, 1]);
    expect(run.some((x) => x.line === "\\author{Anon}")).toBe(false);
  });

  it("真の条件でも左右の段が入れ替わらず、真の枝だけが両段で実行される", () => {
    const { blocks } = renderPairs(lncs, { left: "\\title{T}", right: "\\title{題}" });
    const run = runColumns(blocks.join("\n\n"), { "\\ifpeerreview": true });
    expect(run).toContainEqual({ col: 0, line: "Abstract EN" });
    expect(run).toContainEqual({ col: 1, line: "概要" });
    expect(run.filter((x) => x.line === "\\author{Anon}").map((x) => x.col)).toEqual([0, 1]);
    expect(run.some((x) => x.line === "\\author{Real}")).toBe(false);
  });

  it("段落の境目の \\if… / \\else / \\fi は対訳に 1 回だけ置く", () => {
    const body = renderPairs(lncs, { left: "\\title{T}", right: "\\title{題}" }).blocks.join("\n\n");
    expect(body.match(/^\\ifpeerreview$/gm)).toHaveLength(1);
    expect(body.match(/^\\else$/gm)).toHaveLength(1);
    expect(body.match(/^\\fi$/gm)).toHaveLength(1);
  });

  it("条件分岐の行で割った後の右の列が [ で始まっても、\\switchcolumn の後に \\relax を挟む", () => {
    const out = pairAcrossConditionals("A\n\\fi\n[BCN18] x", "甲\n\\fi\n[BCN18] 乙");
    expect(out).toBe("A\n\\switchcolumn\n甲\n\\switchcolumn*\n\\fi\n[BCN18] x\n\\switchcolumn\n\\relax\n[BCN18] 乙\n\\switchcolumn*");
  });

  it("1 つの段落の中で閉じた条件分岐は割らず、従来どおり段落ごと左右に置く", () => {
    const l = "\\ifdraft\nA\n\\else\nB\n\\fi\nC";
    const r = "\\ifdraft\n甲\n\\else\n乙\n\\fi\n丙";
    expect(pairAcrossConditionals(l, r)).toBe(`${l}\n\\switchcolumn\n${r}\n\\switchcolumn*`);
    expect(pairAcrossConditionals("text\n\\ifdraft\nnote\n\\fi\nmore", "本文\n\\ifdraft\n注\n\\fi\n続き")).toBe(
      "text\n\\ifdraft\nnote\n\\fi\nmore\n\\switchcolumn\n本文\n\\ifdraft\n注\n\\fi\n続き\n\\switchcolumn*",
    );
  });

  it("制御綴り以外を含む条件の行（\\ifnum\\x>0）で開いて閉じる段落は割らず、偽・真のどちらでも左右が入れ替わらない", () => {
    const l = "\\ifnum\\x>0\nPositiveL\n\\fi";
    const r = "\\ifnum\\x>0\nPositiveR\n\\fi";
    expect(pairAcrossConditionals(l, r)).toBe(`${l}\n\\switchcolumn\n${r}\n\\switchcolumn*`);
    const { blocks } = renderPairs(
      [
        { segmentId: "s", left: l, right: r },
        { segmentId: "s", left: "AfterL", right: "AfterR" },
      ],
      { left: "", right: "" },
      detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}"),
    );
    const body = blocks.join("\n\n");
    expect(runColumns(body)).toEqual([
      { col: 0, line: "AfterL" },
      { col: 1, line: "AfterR" },
    ]);
    expect(runColumns(body, { "\\ifnum\\x>0": true })).toEqual([
      { col: 0, line: "PositiveL" },
      { col: 1, line: "PositiveR" },
      { col: 0, line: "AfterL" },
      { col: 1, line: "AfterR" },
    ]);
  });

  it("\\if… と本文が同じ行の条件分岐・\\ifcase と \\or・角括弧の引数の中の条件分岐は、段落の中で閉じていれば割らない", () => {
    expect(splitAtConditionals("\\ifdraft Note\n\\fi").conds).toEqual([]);
    expect(splitAtConditionals("\\ifcase\\x\nA\n\\or\nB\n\\fi").conds).toEqual([]);
    expect(splitAtConditionals("\\twocolumn[\n\\ifarxiv\nX\n\\else\nY\n\\fi\n]").conds).toEqual([]);
  });

  it("比較の対象を取る \\ifnum\\x>0 / \\ifcase の段落をまたぐ条件分岐は割らず、修正前と同じく左右に置く", () => {
    expect(splitAtConditionals("\\ifcase\\x\nA\n\\or\nB").conds).toEqual([]);
    const { blocks } = renderPairs(
      [
        { segmentId: "s", left: "\\ifnum\\x>0\nPositiveL", right: "\\ifnum\\x>0\nPositiveR" },
        { segmentId: "s", left: "MoreL\n\\fi\nAfterL", right: "MoreR\n\\fi\nAfterR" },
      ],
      { left: "", right: "" },
      detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}"),
    );
    const body = blocks.join("\n\n");
    expect(body.match(/^\\ifnum\\x>0$/gm)).toHaveLength(2);
    expect(body.match(/^\\fi$/gm)).toHaveLength(2);
  });

  it("コメント付きの行・\\ifx の比較・\\fi の後の空の残りを扱う", () => {
    expect(splitAtConditionals("\\ifdraft % note\nA")).toEqual({ runs: ["", "A"], conds: ["\\ifdraft"] });
    expect(splitAtConditionals("\\ifx\\a\\b % note\nA").conds).toEqual([]);
    expect(splitAtConditionals("A\n\\fi  % end")).toEqual({ runs: ["A", ""], conds: ["\\fi"] });
  });

  it("条件分岐の釣り合いは \\iff・\\newif の直後・{ が続く \\if…（etoolbox など）を数えない", () => {
    expect(conditionalsBalanced("\\newif\\ifpeerreview")).toBe(true);
    expect(conditionalsBalanced("$a \\iff b$")).toBe(true);
    expect(conditionalsBalanced("\\ifbool{x}{a}{b}")).toBe(true);
    expect(conditionalsBalanced("\\ifpeerreview")).toBe(false);
    expect(conditionalsBalanced("\\else")).toBe(false);
    expect(conditionalsBalanced("\\fi\n\\maketitle")).toBe(false);
    expect(conditionalsBalanced("\\ifx\\a\\b x\\else y\\fi % \\fi")).toBe(true);
  });

  it("波括弧・環境の中の条件分岐の行（マクロ定義など）と \\iff の行では割らない", () => {
    const def = "\\fi\n\\newcommand{\\foo}{%\n\\ifdraft\nx\n\\else\ny\n\\fi\n}";
    expect(splitAtConditionals(def).conds).toEqual(["\\fi"]);
    const env = "\\fi\n\\begin{tabular}{l}\n\\ifx\\a\\b\nx\n\\fi\n\\end{tabular}";
    expect(splitAtConditionals(env).conds).toEqual(["\\fi"]);
    expect(splitAtConditionals("\\fi\n$a\n\\iff\nb$").conds).toEqual(["\\fi"]);
    expect(splitAtConditionals("\\fi\n\\[\na\n\\iff\\quad\nb\n\\]")).toEqual({
      runs: ["", "\\[\na\n\\iff\\quad\nb\n\\]"],
      conds: ["\\fi"],
    });
  });

  it("段落の中で閉じない環境（節をまたぐ credits）の中の条件分岐の行は割り、後続の段落の \\else / \\fi と揃える", () => {
    expect(splitAtConditionals("\\begin{credits}\n\n\\ifpeerreview")).toEqual({
      runs: ["\\begin{credits}", ""],
      conds: ["\\ifpeerreview"],
    });
    const tail = "\\begin{tabular}{l}\n\\ifx\\a\\b\nx\n\\fi\n\\end{tabular}";
    expect(splitAtConditionals(tail).conds).toEqual([]);
    const { blocks } = renderPairs(
      [
        { segmentId: "a", left: "\\begin{credits}\n\n\\ifpeerreview", right: "\\begin{credits}\n\n\\ifpeerreview" },
        { segmentId: "b", left: "Withheld.", right: "非公開。" },
        { segmentId: "b", left: "\\else", right: "\\else" },
        { segmentId: "b", left: "Funding.", right: "資金。" },
        { segmentId: "b", left: "\\fi\n\\end{credits}", right: "\\fi\n\\end{credits}" },
        { segmentId: "b", left: "After.", right: "後。" },
      ],
      { left: "\\newif\\ifpeerreview", right: "" },
      detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}"),
    );
    const run = runColumns(blocks.join("\n\n"));
    expect(run.filter((x) => x.line === "Funding." || x.line === "資金。")).toEqual([
      { col: 0, line: "Funding." },
      { col: 1, line: "資金。" },
    ]);
    expect(run.some((x) => x.line === "Withheld.")).toBe(false);
    expect(run).toContainEqual({ col: 0, line: "After." });
    expect(run).toContainEqual({ col: 1, line: "後。" });
  });

  it("左右で条件分岐の行の並びが違えば、従来どおり段落ごと左右に置く", () => {
    expect(pairAcrossConditionals("\\fi\nA", "和")).toBe("\\fi\nA\n\\switchcolumn\n和\n\\switchcolumn*");
    expect(pairAcrossConditionals("A", "和")).toBe("A\n\\switchcolumn\n和\n\\switchcolumn*");
  });

  it("条件分岐の釣り合いを strict で確かめるときは、{ が続く \\if… も開きとして数える", () => {
    expect(conditionalsBalanced("\\ifdraft{\\bf N}\n\\fi")).toBe(false);
    expect(conditionalsBalanced("\\ifdraft{\\bf N}\n\\fi", true)).toBe(true);
    expect(conditionalsBalanced("\\ifbool{x}{a}{b}", true)).toBe(false);
  });

  it("{ が続く \\if… で開いて \\fi だけの行で閉じる段落は割らず、従来どおり段落ごと左右に置く（2 回目のレビュー）", () => {
    const l = "A\n\\ifdraft{\\bf N}\n\\fi";
    const r = "甲\n\\ifdraft{\\bf 注}\n\\fi";
    expect(splitAtConditionals(l)).toEqual({ runs: [l], conds: [] });
    expect(pairAcrossConditionals(l, r)).toBe(`${l}\n\\switchcolumn\n${r}\n\\switchcolumn*`);
  });

  it("前の行が命令か行をつなぐコメントで終わる条件分岐の行では割らない（\\unless・\\expandafter が次の行の \\if… を取る）", () => {
    expect(splitAtConditionals("Intro\n\\unless\n\\ifdraft\nA").conds).toEqual([]);
    expect(splitAtConditionals("Intro\n\\expandafter\n\\ifdraft\nA").conds).toEqual([]);
    expect(splitAtConditionals("Intro %\n\\ifdraft\nA").conds).toEqual([]);
    expect(splitAtConditionals("Intro\n\\ifdraft\nA").conds).toEqual(["\\ifdraft"]);
    expect(splitAtConditionals("\\author{X}\n\\fi").conds).toEqual(["\\fi"]);
  });

  it("割った後の部分で条件分岐が閉じない段落は割らない（\\fi が本文と同じ行・\\unless\\if…・\\ifbool{…}）", () => {
    expect(splitAtConditionals("\\else\nFinalL\\fi").conds).toEqual([]);
    expect(splitAtConditionals("\\unless\\ifdraft\nA").conds).toEqual([]);
    expect(splitAtConditionals("\\ifbool{x}{a}{b}\n\\fi").conds).toEqual([]);
    expect(splitAtConditionals("\\fi\n\\begin{verbatim}\n\\fi\n\\end{verbatim}").conds).toEqual([]);
  });

  it("1 行で閉じた \\ifx … \\else … \\fi の行と \\ifbool{…} の行は、条件分岐の行として割らない", () => {
    expect(splitAtConditionals("\\ifx\\a\\b X\\else Y\\fi.\n\\fi")).toEqual({
      runs: ["\\ifx\\a\\b X\\else Y\\fi.", ""],
      conds: ["\\fi"],
    });
    expect(isConditionalLine("\\ifx\\a\\b X\\else Y\\fi")).toBe(false);
    expect(isConditionalLine("\\ifbool{x}{a}{b}")).toBe(false);
  });

  it("条件分岐の行は、比較の対象を取らない \\if… だけの行と \\else・\\fi だけの行（比較の対象を取る条件分岐は割らない）", () => {
    expect(isConditionalLine("\\ifdraft")).toBe(true);
    expect(isConditionalLine("\\if@twocolumn")).toBe(true);
    expect(isConditionalLine("\\iftrue")).toBe(true);
    expect(isConditionalLine("\\else")).toBe(true);
    expect(isConditionalLine("\\fi")).toBe(true);
    expect(isConditionalLine("\\or")).toBe(false);
    expect(isConditionalLine("\\ifnum\\value{page}>1")).toBe(false);
    expect(isConditionalLine("\\ifdim\\linewidth>3in")).toBe(false);
    expect(isConditionalLine("\\ifx\\nodef")).toBe(false);
    expect(isConditionalLine("\\ifnum")).toBe(false);
    expect(isConditionalLine("\\ifcase\\x")).toBe(false);
    expect(isConditionalLine("\\ifx\\relax\\relax\\mk{Shared}")).toBe(false);
    expect(isConditionalLine("\\ifdraft\\relax")).toBe(false);
    expect(isConditionalLine("\\ifdraft{")).toBe(false);
    expect(isConditionalLine("\\ifnum\\x>0 Positive")).toBe(false);
    expect(isConditionalLine("\\ifnum\\x>0 \\relax")).toBe(false);
    expect(isConditionalLine("\\ifx\\a\\b \\foo")).toBe(false);
    expect(isConditionalLine("\\ifnum\\value{page}>1 \\newpage")).toBe(false);
    expect(isConditionalLine("\\ifnum \\x>0")).toBe(false);
    expect(isConditionalLine("\\ifx\\a\\b{")).toBe(false);
    expect(isConditionalLine("\\ifx\\a\\b\\begin{x}")).toBe(false);
    expect(isConditionalLine("\\iff")).toBe(false);
  });

  it("割った条件分岐の行の並びは、\\else が 1 つの条件分岐に 1 回のときに入れ子として閉じる", () => {
    expect(conditionalLinesNest(["\\ifdraft", "\\else", "\\fi"])).toBe(true);
    expect(conditionalLinesNest(["\\ifdraft", "\\ifpeerreview", "\\fi", "\\else", "\\fi"])).toBe(true);
    expect(conditionalLinesNest(["\\ifdraft", "\\else", "\\else", "\\fi"])).toBe(false);
    expect(conditionalLinesNest(["\\fi"])).toBe(false);
    expect(conditionalLinesNest(["\\else"])).toBe(false);
    expect(conditionalLinesNest(["\\ifdraft"])).toBe(false);
  });

  it("割る \\if… の名前が文書の中で \\newif で宣言されていないか、宣言とそれだけの行の外に現れれば割らない", () => {
    const open = { left: "\\ifdraft\nA", right: "\\ifdraft\n甲" };
    const close = { left: "\\fi", right: "\\fi" };
    expect(conditionalsSplittable([open, close])).toBe(false);
    expect(conditionalsSplittable([{ left: "\\newif\\ifdraft", right: "\\newif\\ifdraft" }, open, close])).toBe(true);
    expect(conditionalsSplittable([open, close], "\\newif\\ifdraft\n\\def\\begindraft{\\ifdraft}")).toBe(false);
    expect(conditionalsSplittable([open, close], "\\newif\\ifdraft \\drafttrue")).toBe(false);
    expect(conditionalsSplittable([open, close], "% \\def\\x{\\ifdraft}\n\\newif\\ifdraft")).toBe(true);
    expect(conditionalsSplittable([{ left: "\\ifhmode\nA", right: "\\ifhmode\n甲" }, close])).toBe(false);
    expect(conditionalNamesDeclared(["\\ifdraft", "\\else", "\\fi"], "\\newif\\ifdraft\n\\ifdraft")).toBe(true);
  });

  it("文書のどこかに割れない段落があるか、割った行の並びが閉じなければ、文書のどの段落も割らない", () => {
    const open = { left: "\\ifdraft\nA", right: "\\ifdraft\n甲" };
    const close = { left: "\\fi", right: "\\fi" };
    const plain = { left: "B", right: "乙" };
    const decl = "\\newif\\ifdraft";
    expect(conditionalsSplittable([open, plain, close], decl)).toBe(true);
    expect(conditionalsSplittable([open, plain], decl)).toBe(false);
    expect(conditionalsSplittable([open, { left: "\\else\nF\\fi", right: "\\else\n丙\\fi" }], decl)).toBe(false);
    expect(
      conditionalsSplittable([{ left: "X\n\\ifdraft{N}\n\\fi", right: "X\n\\ifdraft{N}\n\\fi" }, open, close], decl),
    ).toBe(false);
    expect(conditionalsSplittable([{ left: "\\ifdraft\nA", right: "\\ifdraft 甲" }, close], decl)).toBe(false);
    const pairs = [open, { left: "\\else\nF\\fi", right: "\\else\n丙\\fi" }, plain].map((p) => ({ segmentId: "s", ...p }));
    const iopart = detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}");
    expect(renderPairs(pairs, { left: "", right: "" }, iopart).blocks).toEqual(
      pairs.map((p) => `${p.left}\n\\switchcolumn\n${p.right}\n\\switchcolumn*`),
    );
  });
});

describe("略語（acronym パッケージ）を左右の段で分ける（issue #381）", () => {
  const keys = (...texs: string[]) => acronymKeysOf(texs);

  it("右の段の本文で定義する略語のキーだけに接頭辞を付け、定義で略称を省いていれば元のキーを略称として書く", () => {
    const k = keys("\\acro{MF}[MF]{有糸分裂像}\\acro{FM}{基盤モデル}\\acrodef{OOD}[OOD]{ドメイン外}\\acro{ViT}[ViT]{x}");
    expect(separateAcronyms("\\ac{MF} と \\acp{FM}、\\Acf*{OOD}、\\acused{ViT}、\\ac[2]{MF}、\\Acfip{FM}、\\ac{PRE}", k)).toBe(
      "\\ac{jpRMF} と \\acp{jpRFM}、\\Acf*{jpROOD}、\\acused{jpRViT}、\\ac[2]{jpRMF}、\\Acfip{jpRFM}、\\ac{PRE}",
    );
    // キーを取らない命令・似た名前の命令は変えない。
    expect(separateAcronyms("\\acresetall \\acute{e} \\acroextra{MF} \\acc{MF}", k)).toBe("\\acresetall \\acute{e} \\acroextra{MF} \\acc{MF}");
  });

  it("定義の直後に正式名のままの複数形を足す（\\acro には \\acroplural、\\acrodef には \\acrodefplural。作者が複数形を定めたキーは除く）", () => {
    const tex = "\\acro{MF}[MF]{有糸分裂像}\n\\acro{WSI}{全スライド画像}\n\\acrodef{BD}[BD]{本文}\n\\acro{ROI}[RoI]{関心領域}\\acroplural{ROI}{関心領域群}";
    expect(separateAcronyms(tex, keys(tex))).toBe(
      "\\acro{jpRMF}[MF]{有糸分裂像}\\acroplural{jpRMF}[MFs]{有糸分裂像}\n" +
        "\\acro{jpRWSI}[WSI]{全スライド画像}\\acroplural{jpRWSI}[WSIs]{全スライド画像}\n" +
        "\\acrodef{jpRBD}[BD]{本文}\\acrodefplural{jpRBD}[BDs]{本文}\n" +
        "\\acro{jpRROI}[RoI]{関心領域}\\acroplural{jpRROI}{関心領域群}",
    );
    // 正式名の中の波括弧・\\& と脚注もそのまま複数形に写す。
    const he = "\\acro{HE}[H\\&E]{ヘマトキシリン\\&エオジン\\footnote{訳注: {x}}}";
    expect(separateAcronyms(he, keys(he))).toBe(
      "\\acro{jpRHE}[H\\&E]{ヘマトキシリン\\&エオジン\\footnote{訳注: {x}}}\\acroplural{jpRHE}[H\\&Es]{ヘマトキシリン\\&エオジン\\footnote{訳注: {x}}}",
    );
  });

  it("acronym パッケージを読む文書だけ（コメントは見ない）、右の段の略語を分ける（左の段はそのまま）", () => {
    expect(usesAcronymPackage("\\usepackage[nolist]{acronym}")).toBe(true);
    expect(usesAcronymPackage("\\usepackage{amsmath,acronym}")).toBe(true);
    expect(usesAcronymPackage("\\usepackage{acro}")).toBe(false);
    expect(usesAcronymPackage("%\\usepackage{acronym}\n\\usepackage{acro}")).toBe(false);
    const pairs = [
      { segmentId: "s", left: "a \\ac{MF}", right: "甲 \\ac{MF}" },
      { segmentId: "s", left: "\\begin{acronym}\\acro{MF}[MF]{mitotic}\\end{acronym}", right: "\\begin{acronym}\\acro{MF}[MF]{有糸}\\end{acronym}" },
    ];
    const on = renderPairs(pairs, { left: "\\usepackage{acronym}", right: "\\usepackage{acronym}" }).blocks.join("\n");
    expect(on).toContain("a \\ac{MF}\n\\switchcolumn\n甲 \\ac{jpRMF}");
    const off = renderPairs(pairs, { left: "", right: "" }).blocks.join("\n");
    expect(off).toContain("甲 \\ac{MF}");
  });
});
