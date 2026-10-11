import { describe, it, expect } from "vitest";
import { DEFAULT_PROFILE, detectProfile, frozenSpansOf, keptSpans } from "./frontmatter.js";
import { extractTitle, findBodyTitle, placeBodyTitle, replaceTitle } from "./paper-title.js";
import { fastestMs } from "../testing/timing.js";

const doc = (preamble: string, body: string): string =>
  `${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const pick = (tex: string, spans: [number, number][]): string[] => spans.map(([s, e]) => tex.slice(s, e));
const seg = (latex: string) => [{ id: "seg-0000", latex }];

describe("detectProfile（前付けの型。契約付録 §8）", () => {
  it.each([
    ["ICML", "\\documentclass{article}\n\\usepackage[accepted]{icml2023}", "icml"],
    ["ICML の改名した派生（\\icmltitle だけで決める）", "\\documentclass{article}\n\\usepackage{mystyle}\n\\twocolumn[\\icmltitle{X}]", "icml"],
    ["AISTATS", "\\documentclass[twoside]{article}\n\\usepackage{aistats2025}", "aistats"],
    ["elsarticle", "\\documentclass[preprint,12pt]{elsarticle}", "elsarticle"],
    ["iopart", "\\documentclass[12pt]{iopart}", "iopart"],
    ["MDPI", "\\documentclass[journal,article]{Definitions/mdpi}", "mdpi"],
    ["NeurIPS（既定）", "\\documentclass{article}\n\\usepackage[final]{neurips_2022}", "default"],
    ["コメントの中の \\usepackage は数えない", "\\documentclass{article}\n% \\usepackage{icml2023}", "default"],
    ["カンマ区切りの複数パッケージ", "\\documentclass{article}\n\\usepackage{amsmath, icml2025}", "icml"],
  ])("%s", (_label, preamble, id) => {
    expect(detectProfile(doc(preamble, "Body")).id).toBe(id);
  });

  it.each([
    ["\\documentclass[", "\\documentclass["],
    ["\\usepackage[", "\\usepackage["],
    ["\\\\ の連なり", "\\\\"],
    ["% の連なり", "%"],
  ])("走査は入力長に対して線形（%s の羅列 1MiB）", (_label, unit) => {
    const body = unit.repeat(Math.ceil((1 << 20) / unit.length));
    expect(fastestMs(2, () => void detectProfile(body))).toBeLessThan(2000);
  });
});

describe("keptSpans（原文のまま残す著者・所属・注記。契約付録 §3）", () => {
  it("ICML の著者一覧の環境と 2 引数の命令を引数ごと残す", () => {
    const tex = [
      "\\begin{icmlauthorlist}\n\\icmlauthor{Ann Lee}{tor}\n\\end{icmlauthorlist}",
      "\\icmlaffiliation{tor}{University of Toronto}",
      "\\icmlcorrespondingauthor{Ann Lee}{ann@x.org}",
      "\\icmlkeywords{Machine Learning}",
    ].join("\n");
    expect(pick(tex, keptSpans(tex))).toEqual([
      "\\begin{icmlauthorlist}\n\\icmlauthor{Ann Lee}{tor}\n\\end{icmlauthorlist}",
      "\\icmlaffiliation{tor}{University of Toronto}",
      "\\icmlcorrespondingauthor{Ann Lee}{ann@x.org}",
    ]);
  });

  it("elsarticle の著者・所属・注記を残し、キーワードは残さない", () => {
    const tex = [
      "\\author[a]{Ann Lee\\corref{cor1}}",
      "\\affiliation[a]{organization={Univ}, city={Kyoto}}",
      "\\cortext[cor1]{Corresponding author}",
      "\\fntext[fn1]{Equal contribution}",
      "\\begin{keyword} deep learning \\sep ensembles \\end{keyword}",
    ].join("\n");
    expect(pick(tex, keptSpans(tex))).toEqual([
      "\\author[a]{Ann Lee\\corref{cor1}}",
      "\\affiliation[a]{organization={Univ}, city={Kyoto}}",
      "\\cortext[cor1]{Corresponding author}",
      "\\fntext[fn1]{Equal contribution}",
    ]);
  });

  it("入れ子は外側だけを開始位置の順に返す。走行用の綴りと \\keywords は残さない", () => {
    const tex = "\\institute{Univ \\email{a@x}}\n\\author{A\\inst{1} \\thanks{T}}\n\\authorrunning{A}\n\\keywords{x}";
    expect(pick(tex, keptSpans(tex))).toEqual(["\\institute{Univ \\email{a@x}}", "\\author{A\\inst{1} \\thanks{T}}"]);
  });

  it("分割で決めていない節は既定の型で決め、keep の中は除く", () => {
    const latex = "\\title{T\\thanks{x}}\n\\author{A}";
    expect(pick(latex, frozenSpansOf({ latex, keep: { start: 0, end: 19 } }))).toEqual(["\\author{A}"]);
    expect(frozenSpansOf({ latex, frozen: [] })).toEqual([]);
  });
});

describe("タイトルの検出が型の表を引く（契約付録 §8）", () => {
  it("ICML: \\twocolumn[ の中の \\icmltitle をタイトルとし、走行タイトルは数えない", () => {
    const body = "\\twocolumn[\n\\icmltitle{Efficient Approximations}\n\\begin{icmlauthorlist}\\end{icmlauthorlist}\n]";
    const profile = detectProfile(doc("\\documentclass{article}\n\\usepackage{icml2023}\n\\icmltitlerunning{Short}", body));
    const found = findBodyTitle(seg(body), profile);
    expect(found?.title?.text).toBe("Efficient Approximations");
    expect(body.slice(found!.start, found!.end)).toBe("\\icmltitle{Efficient Approximations}");
    expect(placeBodyTitle(body, { latex: body, start: found!.start, end: found!.end }, "効率的な近似")).toContain(
      "\\icmltitle{効率的な近似}",
    );
  });

  it("AISTATS: 補遺の 2 回目の \\aistatstitle は最初の組む位置の後ろなので数えない", () => {
    const body = "\\twocolumn[\\aistatstitle{Main Title}]\nText\n\\onecolumn\\aistatstitle{Main Title: Supplementary Materials}";
    const profile = detectProfile(doc("\\documentclass{article}\n\\usepackage{aistats2025}", body));
    expect(findBodyTitle(seg(body), profile)?.title?.text).toBe("Main Title");
  });

  it("iopart: \\title がその場で組み、\\maketitle は組む位置にならない", () => {
    const body = "\\title{Quantum Things}\n\\author{A}\n\\maketitle";
    const profile = detectProfile(doc("\\documentclass{iopart}", body));
    expect(profile.maketitle).toBe(false);
    expect(findBodyTitle(seg(body), profile)?.title?.text).toBe("Quantum Things");
    expect(findBodyTitle(seg("\\maketitle\n\\title{Late}"), profile)?.title?.text).toBe("Late");
  });

  it("MDPI: 前文の \\Title を取り出し・差し替える", () => {
    const preamble = "\\documentclass[journal]{Definitions/mdpi}\n\\Title{Deep Ensembles}\n\\TitleCitation{Deep Ensembles}";
    const profile = detectProfile(doc(preamble, "x"));
    expect(extractTitle(preamble, profile)?.text).toBe("Deep Ensembles");
    expect(replaceTitle(preamble, "深層アンサンブル", profile)).toBe(
      "\\documentclass[journal]{Definitions/mdpi}\n\\Title{深層アンサンブル}\n\\TitleCitation{Deep Ensembles}",
    );
    expect(extractTitle(preamble)).toBeUndefined();
  });

  it("elsarticle: \\title が 2 つ以上あると連結されるので、訳すタイトルは見つからない扱いにする", () => {
    const profile = detectProfile(doc("\\documentclass{elsarticle}", "x"));
    const one = "\\begin{frontmatter}\n\\title{A Study}\n\\end{frontmatter}";
    const two = "\\begin{frontmatter}\n\\title{A Study}\n\\title{of Things}\n\\end{frontmatter}";
    expect(findBodyTitle(seg(one), profile)?.title?.text).toBe("A Study");
    expect(findBodyTitle(seg(two), profile)?.title).toBeUndefined();
    expect(findBodyTitle(seg(two), DEFAULT_PROFILE)?.title?.text).toBe("of Things");
  });

  it("AAAI: \\iffalse の中のダミーの \\title は数えない", () => {
    const preamble = "\\documentclass{article}\n\\usepackage{aaai2026}\n\\title{Real Title}\n\\iffalse\n\\title{My Publication Title}\n\\fi";
    expect(extractTitle(preamble, detectProfile(doc(preamble, "x")))?.text).toBe("Real Title");
  });
});
