import { describe, it, expect } from "vitest";
import { fastestMs } from "../testing/timing.js";
import { paperDigest, MAX_DIGEST_CHARS } from "./paper-digest.js";

const PAPER = [
  "\\documentclass{elsarticle}",
  "\\begin{abstract}",
  "We propose \\textbf{ROOD-MRI}, a platform for benchmarking robustness to $\\mathcal{D}$-shifts.",
  "\\end{abstract}",
  "\\begin{document}",
  "\\section{Introduction}\\label{sec:intro}",
  "Deep networks are susceptible to distribution shifts \\citep{a}.",
  "\\subsection{Transforms}",
  "We simulate shifts by applying transforms.",
  "\\section{Results}",
  "The models degrade under blur.",
  "\\end{document}",
].join("\n");

describe("paperDigest", () => {
  it("abstract の地の文を取り出す（制御綴り・数式は落とす）", () => {
    const d = paperDigest(PAPER);
    expect(d).toContain("### abstract");
    expect(d).toContain("We propose ROOD-MRI, a platform for benchmarking robustness");
    expect(d).not.toContain("\\textbf");
    expect(d).not.toContain("mathcal");
  });

  it("見出しを階層つきで原文の順に並べる", () => {
    const heads = paperDigest(PAPER)
      .split("\n")
      .filter((l) => l.startsWith("### "));
    expect(heads).toEqual([
      "### abstract",
      "### section: Introduction",
      "### subsection: Transforms",
      "### section: Results",
    ]);
  });

  it("各節の書き出しを添える（論旨は節の入口に出る）", () => {
    const d = paperDigest(PAPER);
    expect(d).toContain("Deep networks are susceptible to distribution shifts");
    expect(d).toContain("The models degrade under blur");
    // \label は不可視なので地の文に混ぜない。
    expect(d).not.toContain("sec:intro");
  });

  it("\\section[短縮]{本見出し} は本見出しを採る", () => {
    const d = paperDigest("\\section[Intro]{Introduction and background}\n本文");
    expect(d).toContain("### section: Introduction and background");
    expect(d).not.toContain("### section: Intro\n");
  });

  it("入れ子の波括弧を含む見出しも平衡して読む", () => {
    const d = paperDigest("\\section{The \\textit{ROOD} platform}\n本文");
    expect(d).toContain("### section: The ROOD platform");
  });

  it("コメントアウトされた見出しは拾わない", () => {
    const d = paperDigest("% \\section{Deleted}\n\\section{Kept}\n本文");
    expect(d).toContain("Kept");
    expect(d).not.toContain("Deleted");
  });

  it("abstract が無い論文でも見出しだけで成立する", () => {
    const d = paperDigest("\\section{Only}\n本文");
    expect(d).not.toContain("### abstract");
    expect(d).toContain("### section: Only");
  });

  it("上限を超えたら末尾から捨て、節の並び順は保つ", () => {
    const many = Array.from({ length: 400 }, (_, i) => `\\section{S${String(i)}}\n${"x".repeat(300)}`).join("\n");
    const d = paperDigest(many);
    expect(d.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(d).toContain("### section: S0");
    expect(d).not.toContain("### section: S399");
  });

  it("閉じない波括弧の見出しは飛ばし、健全な見出しは拾う", () => {
    const d = paperDigest("\\section{壊れた\n\\subsection{健全}\n本文");
    expect(d).not.toContain("### section:");
    expect(d).toContain("### subsection: 健全");
    expect(() => paperDigest("\\section{".repeat(1000))).not.toThrow();
  });

  it("閉じない波括弧の羅列でも走査は線形（プロンプト生成で固まらせない）", () => {
    const malformed = "\\section{".repeat(50_000);
    expect(fastestMs(2, () => void paperDigest(malformed))).toBeLessThan(2000);
  });

  it("同じ入力からは同じ抜粋（決定的＝checkpoint の無効化キーが揺れない）", () => {
    expect(paperDigest(PAPER)).toBe(paperDigest(PAPER));
  });
});
