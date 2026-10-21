import { describe, it, expect } from "vitest";
import { budgetMs, fastestMs } from "../testing/timing.js";
import { collectCandidates } from "./collect.js";

describe("collectCandidates", () => {
  it("固定5パターンで候補を集める", () => {
    const latex =
      "\\newcommand{\\mdl}{X}. We define self-attention as a mechanism. " +
      "The \\emph{multi-head} attention uses Byte Pair Encoding.";
    const srcs = collectCandidates(latex).map((c) => c.src);
    expect(srcs).toContain("\\mdl");
    expect(srcs).toContain("self-attention");
    expect(srcs).toContain("multi-head");
    expect(srcs).toContain("Byte Pair Encoding");
  });

  it("we define X は definedInPaper=true", () => {
    const cands = collectCandidates("We define self-attention as X");
    expect(cands.find((c) => c.src === "self-attention")?.definedInPaper).toBe(true);
  });

  it("複合固有名は definedInPaper=false", () => {
    const cands = collectCandidates("uses Byte Pair Encoding here");
    expect(cands.find((c) => c.src === "Byte Pair Encoding")?.definedInPaper).toBe(false);
  });

  it("DB 既知語も候補に含める", () => {
    const srcs = collectCandidates("we use attention", ["attention"]).map((c) => c.src);
    expect(srcs).toContain("attention");
  });

  it("文書順（初出位置）で返す", () => {
    const cands = collectCandidates("\\emph{alpha} then \\emph{beta}");
    expect(cands.map((c) => c.src)).toEqual(["alpha", "beta"]);
  });
});

describe("候補収集のコスト", () => {
  it.each([
    ["\\emph{", "\\emph{"],
    ["we refer to", "we refer to x "],
  ])("閉じない %s の羅列でも本文全体に対して線形", (_label, unit) => {
    // 終端の無い [^}]+ / .+? は開始位置ごとに末尾まで走査し、二次になっていた
    // （実測 512KiB で 35,510ms、上限 8MiB へ外挿で約 2.5 時間。gzip 14KB の入力で成立）。
    const tex = unit.repeat(Math.floor((4 * 1024 * 1024) / unit.length));
    expect(fastestMs(2, () => void collectCandidates(tex))).toBeLessThan(budgetMs(3000));
  });
});

describe("定義句パターンのコスト", () => {
  it("we refer to + 空白の反復で上限サイズでも秒オーダーに収まる", () => {
    const body = "we refer to".concat(" ".repeat(21)).repeat(30_000);
    const ms = fastestMs(2, () => void collectCandidates(body, []));
    // 修正前は 1MiB で 2,539ms（8MiB で 20,354ms）。中間を同一文に限り、
    // as の前の \s の曖昧さを畳んで 13 倍以上速くした。
    expect(ms).toBeLessThan(budgetMs(1_500));
  });

  it("正規の言い回しは引き続き拾う", () => {
    const got = (s: string) => collectCandidates(s, []).map((c) => c.src);
    expect(got("We refer to this mechanism as the attention head.")).toContain("attention head");
    expect(got("we refer to  the resulting model  as  a sparse transformer.")).toContain(
      "sparse transformer",
    );
    expect(got("We refer to it as self-attention.")).toContain("self-attention");
  });
});

describe("文頭の機能語と参照語", () => {
  it("大文字句の先頭の機能語を外し、図表・節の参照語だけの句は候補にしない", () => {
    const srcs = collectCandidates(
      "The PanNuke dataset is used. While DCAN works, Unlike CNNs it fails. In Figure 3 we show. See Sec 2.",
    ).map((c) => c.src);
    expect(srcs).toContain("PanNuke");
    expect(srcs).toContain("DCAN");
    expect(srcs).toContain("CNNs");
    expect(srcs).not.toContain("The PanNuke");
    expect(srcs).not.toContain("While DCAN");
    expect(srcs).not.toContain("Figure");
    expect(srcs).not.toContain("In Figure");
    expect(srcs).not.toContain("Sec");
  });
});

describe("候補の末尾の句読点（issue #376）", () => {
  it("段落見出しの末尾のピリオド・コロンを落とし、略語のピリオドは残す", () => {
    const srcs = collectCandidates(
      "\\textbf{Rashomon Ratio.} As introduced by \\citet{x}. \\textbf{Effective approach:} we do. " +
        "\\emph{et al.} and \\textit{e.g.} and \\textbf{ID Acc.} here.",
    ).map((c) => c.src);
    expect(srcs).toContain("Rashomon Ratio");
    expect(srcs).not.toContain("Rashomon Ratio.");
    expect(srcs).toContain("Effective approach");
    expect(srcs).not.toContain("Effective approach:");
    expect(srcs).toContain("et al.");
    expect(srcs).toContain("e.g.");
    expect(srcs).toContain("ID Acc.");
  });

  it("末尾の句読点を落とした後の参照語だけの句は候補にしない", () => {
    const srcs = collectCandidates("\\textbf{Figure.} shows it.").map((c) => c.src);
    expect(srcs).not.toContain("Figure");
    expect(srcs).not.toContain("Figure.");
  });
});
