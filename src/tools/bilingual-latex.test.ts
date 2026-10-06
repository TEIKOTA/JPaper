import { describe, it, expect } from "vitest";
import {
  splitParagraphs,
  balanceParagraphs,
  paragraphsOf,
  pairSegments,
  provideCommands,
  titleOf,
  bilingualPreamble,
  renderPairs,
  paracolBody,
  titleBlock,
  assembleBilingual,
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

describe("\\providecommand 置換", () => {
  it("\\newcommand と \\newcommand* を置き換え、似た名前は残す", () => {
    expect(provideCommands("\\newcommand{\\a}{1}\\newcommand*{\\b}{2}\\newcommandx{\\c}{3}")).toBe(
      "\\providecommand{\\a}{1}\\providecommand*{\\b}{2}\\newcommandx{\\c}{3}",
    );
  });

  it("訳文側（右）だけを置き換える", () => {
    const [block] = renderPairs([{ segmentId: "s", left: "\\newcommand{\\a}{1}", right: "\\newcommand{\\a}{1}" }], {
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

  it("段落が \\maketitle だけのペアをタイトルブロックに置き換える", () => {
    const blocks = renderPairs(
      [
        { segmentId: "s", left: "\\maketitle", right: "\\maketitle" },
        { segmentId: "s", left: "A", right: "和" },
      ],
      { left: "Title", right: "題" },
    );
    expect(blocks).toEqual([titleBlock("Title", "題"), "A\n\\switchcolumn\n和\n\\switchcolumn*"]);
    expect(blocks[0]).toBe("\\jpTitleBlock{Title}\n\\switchcolumn\n\\jpTitleBlock{題}\n\\switchcolumn*");
  });

  it("\\maketitle で始まる段落はタイトルブロックと残りに分ける", () => {
    const blocks = renderPairs([{ segmentId: "s", left: "\\maketitle\nA", right: "\\maketitle\n和" }], {
      left: "T",
      right: "題",
    });
    expect(blocks).toEqual([titleBlock("T", "題"), "A\n\\switchcolumn\n和\n\\switchcolumn*"]);
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
    expect(out.mainTex).toContain(`\\begin{paracol}{2}\n${titleBlock("T", "題")}\n\n`);
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
      "\\geometry{paperwidth=420mm,paperheight=297mm",
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
    expect(body).toContain("\\newgeometry{paperwidth=420mm,paperheight=297mm");
    expect(body).toContain("\\pagestyle{empty}");
    expect(body).toContain("\\AddToShipoutPictureFG{");
    expect(body).not.toContain("\\AddToShipoutPictureFG*");
    expect(body).toContain("原文 p.\\thepage");
    expect(body).toContain("和訳 p.\\thepage");
    expect(body).toContain("\\begin{paracol}{2}\nA\n\\switchcolumn\n和\n\\switchcolumn*\n\\end{paracol}\n\\end{document}\n");
    expect(out.mainTex.match(/\\begin\{document\}/g)).toHaveLength(1);
    expect(out.fallbackSegments).toEqual([]);
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
