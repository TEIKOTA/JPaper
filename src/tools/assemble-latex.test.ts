import { describe, it, expect } from "vitest";
import {
  assembleLatex,
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
    const started = Date.now();
    expect(sanitizeMath(tex)).toBe(tex);
    expect(Date.now() - started).toBeLessThan(1000);
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

describe("separateCjkAfterControlWords", () => {
  it("命令語の直後の和文字の前に {} を挟む", () => {
    expect(separateCjkAfterControlWords("\\oursの能力、\\LaTeX（注）")).toBe("\\ours{}の能力、\\LaTeX{}（注）");
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
