import { describe, it, expect } from "vitest";
import { budgetMs, fastestMs } from "../testing/timing.js";
import {
  assembleLatex,
  joinFrontBlankLines,
  assembleWithMap,
  segmentAtLine,
  extractPreamble,
  neutralizePreamble,
  injectShared,
  prependLuatexCompat,
  stripDocumentClass,
  sanitizeMath,
  fuseCaptionParagraphs,
  releaseLuatexjaNames,
  releaseCounterAnchorNames,
  separateCjkAfterControlWords,
  classPackages,
} from "./assemble-latex.js";

const CLEAN = [
  "\\documentclass{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage[T1]{fontenc}",
  "\\usepackage{amsmath}",
  "\\newcommand{\\dmodel}{d_{\\text{model}}}",
  "\\title{Attention Is All You Need}",
  "\\author{Ashish Vaswani\\thanks{x} \\And Noam Shazeer}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{Introduction} 本文",
  "\\end{document}",
].join("\n");

describe("extractPreamble", () => {
  it("\\begin{document} 直前までを前文として返す", () => {
    const pre = extractPreamble(CLEAN);
    expect(pre).toContain("\\documentclass{article}");
    expect(pre).toContain("\\title{Attention Is All You Need}");
    expect(pre).not.toContain("\\begin{document}");
    expect(pre).not.toContain("\\maketitle");
  });
  it("\\begin{document} 無しは空", () => {
    expect(extractPreamble("no document here")).toBe("");
  });
});

describe("neutralizePreamble", () => {
  it("inputenc / fontenc の usepackage を除去し他は温存", () => {
    const out = neutralizePreamble(extractPreamble(CLEAN));
    expect(out).not.toContain("inputenc");
    expect(out).not.toContain("fontenc");
    expect(out).toContain("\\usepackage{amsmath}");
    expect(out).toContain("\\newcommand{\\dmodel}");
  });
});

describe("injectShared", () => {
  it("luatexja と引用フォールバックを注入する", () => {
    const out = injectShared(neutralizePreamble(extractPreamble(CLEAN)));
    expect(out).toContain("luatexja-preset");
    expect(out).toContain("\\providecommand{\\citep}{\\cite}");
  });
  it("graphicx が無ければ補い、有れば重複注入しない", () => {
    expect(injectShared("\\documentclass{article}")).toContain("\\usepackage{graphicx}");
    const withGx = injectShared("\\documentclass{article}\n\\usepackage{graphicx}");
    expect(withGx.match(/\\usepackage\{graphicx\}/g)!.length).toBe(1);
  });  it("luatexja は \\documentclass の直後、ほかのパッケージより前に読む", () => {
    const out = injectShared("\\documentclass[twocolumn]{article} \n\\usepackage{preprint}\n");
    expect(out.indexOf("luatexja-preset")).toBeGreaterThan(out.indexOf("\\documentclass"));
    expect(out.indexOf("luatexja-preset")).toBeLessThan(out.indexOf("\\usepackage{preprint}"));
  });
  it("\\documentclass が無ければ末尾に読む", () => {
    expect(injectShared("\\usepackage{x}")).toMatch(/\\usepackage\{x\}\n\\usepackage\[ipaex\]\{luatexja-preset\}/);
  });
  it("acmart の所属の国名の検査を、\\@ACM@resetaffil があるときだけ外し、@ の catcode を戻す（issue #497）", () => {
    const out = injectShared("\\documentclass[sigconf]{acmart}");
    expect(out).toContain("\\g@addto@macro\\@ACM@resetaffil{\\global\\@ACM@countrypresenttrue}");
    expect(out).not.toContain("\\makeatother");
    expect(out).toContain("\\catcode`\\@=\\jpaperAtCatcode\\relax");
  });
});

describe("fuseCaptionParagraphs", () => {
  it("\\caption の中の空行だけをコメント行にし、行数を保つ", () => {
    const src = "a\n\n\\caption{x {y}\n\nz}\n\nb";
    const out = fuseCaptionParagraphs(src);
    expect(out).toBe("a\n\n\\caption{x {y}\n%\nz}\n\nb");
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });
  it("短い見出し付き・閉じない引数", () => {
    expect(fuseCaptionParagraphs("\\caption[s]{p\n  \nq}")).toBe("\\caption[s]{p\n%\nq}");
    expect(fuseCaptionParagraphs("\\caption{p\n\nq")).toBe("\\caption{p\n\nq");
  });
});

describe("sanitizeMath", () => {
  it("align* 環境内の空行を潰す（\\par 化を防ぐ）", () => {
    const src = "\\begin{align*}\na &= b\\\\\n\n c &= d\n\\end{align*}";
    const out = sanitizeMath(src);
    expect(out).not.toMatch(/\n[ \t]*\n/);
    expect(out).toContain("a &= b");
    expect(out).toContain("c &= d");
  });
  it("数式環境外の空行（段落区切り）は保持する", () => {
    const src = "本文A\n\n本文B";
    expect(sanitizeMath(src)).toBe(src);
  });
});

describe("assembleLatex: original モード", () => {
  it("既定は original で本文を順連結する", () => {
    const r = assembleLatex({ cleanLatex: CLEAN, chapters: ["\\maketitle A", "\\section{B} b"] });
    expect(r.layout).toBe("original");
    expect(r.mainTex).toContain("\\documentclass{article}");
    expect(r.mainTex).not.toContain("inputenc");
    expect(r.mainTex).toContain("luatexja-preset");
    expect(r.mainTex.indexOf("\\maketitle A")).toBeLessThan(r.mainTex.indexOf("\\section{B} b"));
    expect(r.mainTex).toMatch(/\\begin\{document\}[\s\S]*\\end\{document\}\s*$/);
  });
  it("空チャプターは連結から除く", () => {
    const r = assembleLatex({ cleanLatex: CLEAN, chapters: ["A", "  ", "B"] });
    expect(r.mainTex).toContain("A\n\nB");
  });
});

describe("assembleWithMap", () => {
  it("mainTex は assembleLatex と一致し、各セグメントの行範囲を返す", () => {
    const segs = [
      { id: "seg-0000", tex: "\\maketitle\nAAA" },
      { id: "seg-0001", tex: "\\section{B}\nBBB\nBBB2" },
    ];
    const plain = assembleLatex({ cleanLatex: CLEAN, chapters: segs.map((s) => s.tex) });
    const mapped = assembleWithMap({ cleanLatex: CLEAN, segments: segs });
    expect(mapped.mainTex).toBe(plain.mainTex);

    const lines = mapped.mainTex.split("\n");
    for (const span of mapped.sourceMap) {
      const seg = segs.find((s) => s.id === span.id)!;
      const firstBodyLine = seg.tex.split("\n")[0]!;
      expect(lines[span.startLine - 1]).toBe(firstBodyLine);
    }
    expect(mapped.sourceMap.map((s) => s.id)).toEqual(["seg-0000", "seg-0001"]);
  });
  it("空セグメントは map から除外する", () => {
    const mapped = assembleWithMap({
      cleanLatex: CLEAN,
      segments: [
        { id: "a", tex: "A" },
        { id: "blank", tex: "   " },
        { id: "b", tex: "B" },
      ],
    });
    expect(mapped.sourceMap.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("segmentAtLine", () => {
  const map = [
    { id: "seg-0000", startLine: 10, endLine: 20 },
    { id: "seg-0001", startLine: 21, endLine: 40 },
  ];
  it("行が含まれるセグメントを返し、範囲外は undefined", () => {
    expect(segmentAtLine(map, 25)).toBe("seg-0001");
    expect(segmentAtLine(map, 10)).toBe("seg-0000");
    expect(segmentAtLine(map, 5)).toBeUndefined();
  });
});

describe("assembleLatex: template フォールバック", () => {
  it("共通 luatexja 前文で組み、原 title/author を引き継ぐ", () => {
    const r = assembleLatex({ cleanLatex: CLEAN, chapters: ["\\maketitle X"], mode: "template" });
    expect(r.layout).toBe("template");
    expect(r.mainTex).toContain("\\documentclass[a4paper]{article}");
    expect(r.mainTex).toContain("luatexja-preset");
    expect(r.mainTex).toContain("\\title{Attention Is All You Need}");
    expect(r.mainTex).toContain("\\author{Ashish Vaswani");
    expect(r.mainTex).toContain("\\maketitle X");
  });

  it("luatexja は \\documentclass の直後、引き継いだ原前文より前に読む", () => {
    const clean = "\\documentclass{article}\n\\usepackage{icml2023}\n\\begin{document}\nX\n\\end{document}";
    const r = assembleLatex({ cleanLatex: clean, chapters: ["X"], mode: "template" });
    const at = r.mainTex.indexOf("luatexja-preset");
    expect(r.mainTex.slice(r.mainTex.indexOf("\\documentclass[a4paper]{article}"), at).split("\n")).toHaveLength(2);
    expect(at).toBeLessThan(r.mainTex.indexOf("\\usepackage{icml2023}"));
    expect(r.mainTex.match(/luatexja-preset/g)).toHaveLength(1);
  });
});

describe("prependLuatexCompat", () => {
  it("luatex85 を \\documentclass より前に置く", () => {
    const out = prependLuatexCompat("\\documentclass{elsarticle}\n\\pdfoutput=1\n");
    expect(out.indexOf("luatex85")).toBeLessThan(out.indexOf("\\documentclass"));
  });
  it("既に luatex85 があれば二重に入れない", () => {
    const src = "\\RequirePackage{luatex85}\n\\documentclass{article}";
    expect(prependLuatexCompat(src)).toBe(src);
  });
});

describe("stripDocumentClass", () => {
  it("オプション付き \\documentclass だけを落とし他は残す", () => {
    const out = stripDocumentClass("\\documentclass[3p]{elsarticle}\n\\usepackage{threeparttable}\n");
    expect(out).not.toContain("documentclass");
    expect(out).toContain("\\usepackage{threeparttable}");
  });
});

describe("assembleLatex: original モードの LuaTeX 互換", () => {
  it("pdfTeX プリミティブを含む前文には luatex85 を先頭に足す", () => {
    const src = "\\documentclass[3p]{elsarticle}\n\\pdfoutput=1\n\\begin{document}\nX\n\\end{document}";
    const r = assembleLatex({ cleanLatex: src, chapters: ["X"] });
    expect(r.layout).toBe("original");
    expect(r.mainTex.indexOf("\\RequirePackage{luatex85}")).toBe(0);
    expect(r.mainTex).toContain("\\pdfoutput=1");
  });
});

describe("assembleLatex: template は原前文を吸収する", () => {
  const ELS = [
    "\\documentclass[3p]{elsarticle}",
    "\\usepackage{threeparttable}",
    "\\newcommand{\\rood}{ROOD-MRI}",
    "\\begin{document}",
    "\\begin{frontmatter}\\title{T}\\end{frontmatter}",
    "\\end{document}",
  ].join("\n");

  it("原 class は article へ差し替え、パッケージとユーザー定義マクロは引き継ぐ", () => {
    const r = assembleLatex({ cleanLatex: ELS, chapters: ["X"], mode: "template" });
    expect(r.mainTex).toContain("\\documentclass[a4paper]{article}");
    expect(r.mainTex).not.toContain("{elsarticle}");
    expect(r.mainTex).toContain("\\usepackage{threeparttable}");
    expect(r.mainTex).toContain("\\newcommand{\\rood}{ROOD-MRI}");
  });

  it("class 固有マークアップ（frontmatter/keyword/\\sep/\\biboptions）の shim を持つ", () => {
    const r = assembleLatex({ cleanLatex: ELS, chapters: ["X"], mode: "template" });
    for (const shim of ["frontmatter", "keyword", "\\sep", "\\biboptions", "IEEEkeywords", "CCSXML"]) {
      expect(r.mainTex).toContain(shim);
    }
  });

  it("keywords を環境で使う論文は \\keywords を前文で定義せず、\\begin{document} の時点で未定義なら環境を補う（issue #440）", () => {
    const jmlr = "\\documentclass{article}\\usepackage{jmlr2e}\\begin{document}\\begin{keywords}x\\end{keywords}\\end{document}";
    const env = assembleLatex({ cleanLatex: jmlr, chapters: ["X"], mode: "template" }).mainTex;
    expect(env).not.toContain("\\providecommand{\\keywords}");
    expect(env).toContain("\\AtBeginDocument{\\jpaper@env{keywords}{");
    const cmd = assembleLatex({ cleanLatex: ELS, chapters: ["X"], mode: "template" }).mainTex;
    expect(cmd).toContain("\\providecommand{\\keywords}[1]");
    expect(cmd).not.toContain("\\jpaper@env{keywords}");
  });

  it("acmart の論文にだけ、前文の書誌メタデータ・著者欄の命令・acks 環境の shim を入れる（issue #495）", () => {
    const acm = "\\documentclass[sigconf]{acmart}\n\\setcopyright{none}\n\\begin{document}\n\\end{document}";
    const shims = [
      "\\providecommand{\\setcopyright}[1]{}",
      "\\providecommand{\\acmConference}[4][]{}",
      "\\providecommand{\\acmDOI}[1]{}",
      "\\providecommand{\\state}[1]{#1}",
      "\\providecommand{\\shortauthors}{}",
      "\\jpaper@env{acks}{",
    ];
    const a = assembleLatex({ cleanLatex: acm, chapters: ["X"], mode: "template" }).mainTex;
    for (const shim of shims) expect(a).toContain(shim);
    expect(a.indexOf("\\jpaper@env{acks}")).toBeLessThan(a.indexOf("\\makeatother"));
    const els = assembleLatex({ cleanLatex: ELS, chapters: ["X"], mode: "template" }).mainTex;
    for (const shim of shims) expect(els).not.toContain(shim);
  });

  it("shim は原前文より前に置き、原前文中の class 固有コマンド呼び出しを成立させる", () => {
    const r = assembleLatex({ cleanLatex: ELS, chapters: ["X"], mode: "template" });
    expect(r.mainTex.indexOf("jpaper@env")).toBeLessThan(r.mainTex.indexOf("threeparttable"));
  });
});

describe("sanitizeMath のコスト", () => {
  it("閉じない数式環境が並んでも二次にならない", () => {
    // 環境ごとに \begin{env}[\s\S]*?\end{env} を掛けていた頃は、開始位置ごとに
    // 末尾まで走査して二次になった（実測 7MB で 11,023ms）。
    const tex = "\\begin{align}x\n\n y".repeat(350_000);
    expect(fastestMs(2, () => expect(sanitizeMath(tex)).toBe(tex))).toBeLessThan(budgetMs(1000));
  });

  it("閉じた環境の空行は従来どおり潰す", () => {
    expect(sanitizeMath("\\begin{align}a\n\nb\\end{align}")).toBe("\\begin{align}a\nb\\end{align}");
    expect(sanitizeMath("\\begin{align*}a\n\nb\\end{align*}")).toBe("\\begin{align*}a\nb\\end{align*}");
  });
});

describe("releaseLuatexjaNames", () => {
  it("\\mc / \\gt の \\newcommand だけを \\DeclareRobustCommand に替える", () => {
    expect(releaseLuatexjaNames("\\newcommand{\\mc}[1]{\\mathcal{#1}}")).toBe("\\DeclareRobustCommand{\\mc}[1]{\\mathcal{#1}}");
    expect(releaseLuatexjaNames("\\newcommand*\\gt{x}")).toBe("\\DeclareRobustCommand*\\gt{x}");
    expect(releaseLuatexjaNames("\\newcommand{\\mcal}{x}\\newcommand\\gtr{y}")).toBe("\\newcommand{\\mcal}{x}\\newcommand\\gtr{y}");
  });
});

describe("releaseCounterAnchorNames", () => {
  it("\\theH<カウンタ名> の \\newcommand だけを \\providecommand に替える", () => {
    expect(releaseCounterAnchorNames("\\newcommand{\\theHalgorithm}{\\arabic{algorithm}}")).toBe(
      "\\providecommand{\\theHalgorithm}{\\arabic{algorithm}}",
    );
    expect(releaseCounterAnchorNames("\\newcommand*\\theHfigure{x}")).toBe("\\providecommand*\\theHfigure{x}");
    expect(releaseCounterAnchorNames("\\newcommand { \\theHtable }{x}")).toBe("\\providecommand{ \\theHtable }{x}");
    const others = "\\newcommand{\\theH}{x}\\newcommand{\\theorem}{y}\\newcommand\\theHx@y{z}\\renewcommand{\\theHalgorithm}{w}";
    expect(releaseCounterAnchorNames(others)).toBe(others);
  });

  it("原プリアンブルでも共通テンプレでも main.tex に \\newcommand{\\theH…} を残さない", () => {
    const clean = [
      "\\documentclass{article}",
      "\\usepackage{algorithm}",
      "\\newcommand{\\theHalgorithm}{\\arabic{algorithm}}",
      "\\begin{document}",
      "x",
      "\\end{document}",
    ].join("\n");
    for (const mode of ["original", "template"] as const) {
      const { mainTex } = assembleWithMap({ cleanLatex: clean, segments: [{ id: "s", tex: "x" } as never], mode });
      expect(mainTex).toContain("\\providecommand{\\theHalgorithm}{\\arabic{algorithm}}");
      expect(mainTex).not.toContain("\\newcommand{\\theHalgorithm}");
    }
  });
});

describe("separateCjkAfterControlWords", () => {
  it("命令語の直後の和文字の前に {} を挟む", () => {
    expect(separateCjkAfterControlWords("\\oursの能力、\\LaTeX（注）")).toBe("\\ours{}の能力、\\LaTeX{}（注）");
  });
  it("バックスラッシュ 1 つ（奇数個の末尾）の直後の和文字は、そのバックスラッシュを {} に替える", () => {
    expect(separateCjkAfterControlWords("\\system\\（実質的には）")).toBe("\\system{}（実質的には）");
    expect(separateCjkAfterControlWords("a\\\\\\（b）")).toBe("a\\\\{}（b）");
  });
  it("\\\\（改行）など偶数個のバックスラッシュの直後の和文字は変えない", () => {
    const s = "行末\\\\改行\\\\\\\\（注）";
    expect(separateCjkAfterControlWords(s)).toBe(s);
  });
  it("和訳の組み立てでも \\foo\\（あ） が命令名として読まれない", () => {
    for (const mode of ["original", "template"] as const) {
      const { mainTex } = assembleWithMap({ cleanLatex: "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n", segments: [{ id: "s", tex: "\\foo\\（あ）" } as never], mode });
      expect(mainTex).toContain("\\foo{}（あ）");
      expect(mainTex).not.toContain("\\（");
    }
  });
  it("英字・空白・波括弧が続く命令と \\\\ は変えない", () => {
    const s = "\\ours は\\textbf{太字}\\\\改行";
    expect(separateCjkAfterControlWords(s)).toBe(s);
  });
});

describe("classPackages", () => {
  it("elsarticle は class と同じ設定で natbib を読み直す", () => {
    expect(classPackages("\\documentclass[preprint,authoryear]{elsarticle}")).toEqual(["\\usepackage[round,authoryear]{natbib}"]);
    expect(classPackages("\\documentclass{elsarticle}\n\\biboptions{sort&compress}")).toEqual(["\\usepackage[numbers,sort&compress]{natbib}"]);
    // 本文末尾の \\biboptions も拾う（実測: 1902.06543 は文献リストの直前）。
    expect(classPackages("\\documentclass{elsarticle}\n\\begin{document}\n\\biboptions{authoryear}\n\\end{document}")).toEqual(["\\usepackage[numbers,authoryear]{natbib}"]);
  });
  it("nonatbib・他の class は何も足さない", () => {
    expect(classPackages("\\documentclass[nonatbib]{elsarticle}")).toEqual([]);
    expect(classPackages("\\documentclass{article}")).toEqual([]);
  });
  it("template レイアウトの前文に入る", () => {
    const tex = "\\documentclass[authoryear]{elsarticle}\n\\begin{document}\nx\n\\end{document}\n";
    expect(assembleWithMap({ cleanLatex: tex, segments: [{ id: "s", tex: "x" } as never], mode: "template" }).mainTex).toContain(
      "\\usepackage[round,authoryear]{natbib}",
    );
  });
});

describe("joinFrontBlankLines（issue #517）", () => {
  const pre = "\\documentclass{article}\n\\author{A\\\\\n\n  B\n \n\nC}\n\\title{T\n\nU}\n\n\\usepackage{x}\n";
  it("\\author・\\title の引数の中の空行を詰め、引数の外の空行は残す", () => {
    expect(joinFrontBlankLines(pre)).toBe(
      "\\documentclass{article}\n\\author{A\\\\\n  B\nC}\n\\title{T\nU}\n\n\\usepackage{x}\n",
    );
  });
  it("両方のレイアウトの前文に効く", () => {
    const tex = `${pre}\\begin{document}\nx\n\\end{document}\n`;
    for (const mode of ["original", "template"] as const) {
      const { mainTex } = assembleWithMap({ cleanLatex: tex, segments: [{ id: "s", tex: "x" } as never], mode });
      expect(mainTex, mode).toContain("\\author{A\\\\\n  B\nC}");
      expect(mainTex, mode).not.toMatch(/\\author\{[^}]*\n[ \t]*\n/);
    }
  });
  it("本文（\\begin{document} の後）の訳文に写された空行も詰める", () => {
    const tex = "\\documentclass{article}\n\\begin{document}\n\\author{A\n\nB}\n\\end{document}\n";
    const body = "\\author{あ\n\nい}\n\n本文。";
    for (const mode of ["original", "template"] as const) {
      expect(assembleWithMap({ cleanLatex: tex, segments: [{ id: "s", tex: body }], mode }).mainTex, mode).toContain("\\author{あ\nい}\n\n本文。");
      expect(assembleLatex({ cleanLatex: tex, chapters: [body], mode }).mainTex, mode).toContain("\\author{あ\nい}\n\n本文。");
    }
  });
  it("コメントの中の波括弧で引数が閉じたと読まず、閉じ括弧までの空行を詰める", () => {
    const pre = "\\author{A\n% omit up to the closing ``}\'\'.\n\nB}\n\n\\x";
    expect(joinFrontBlankLines(pre)).toBe("\\author{A\n% omit up to the closing ``}\'\'.\nB}\n\n\\x");
  });
});
