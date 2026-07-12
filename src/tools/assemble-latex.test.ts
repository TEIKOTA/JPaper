import { describe, it, expect } from "vitest";
import {
  assembleLatex,
  extractPreamble,
  neutralizePreamble,
  injectShared,
  extractCommand,
  sanitizeMath,
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
  });
});

describe("extractCommand", () => {
  it("入れ子の波括弧を含む \\author を丸ごと取り出す", () => {
    const pre = extractPreamble(CLEAN);
    expect(extractCommand(pre, "author")).toBe(
      "\\author{Ashish Vaswani\\thanks{x} \\And Noam Shazeer}",
    );
    expect(extractCommand(pre, "title")).toBe("\\title{Attention Is All You Need}");
  });
  it("無ければ undefined", () => {
    expect(extractCommand("\\documentclass{article}", "title")).toBeUndefined();
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
