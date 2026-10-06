import { describe, it, expect } from "vitest";
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
    const started = Date.now();
    collectCandidates(tex);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("定義句パターンのコスト", () => {
  it("we refer to + 空白の反復で上限サイズでも秒オーダーに収まる", () => {
    const body = "we refer to".concat(" ".repeat(21)).repeat(30_000);
    const t = Date.now();
    collectCandidates(body, []);
    const ms = Date.now() - t;
    // 修正前は 1MiB で 2,539ms（8MiB で 20,354ms）。中間を同一文に限り、
    // as の前の \s の曖昧さを畳んで 13 倍以上速くした。
    expect(ms).toBeLessThan(1_500);
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
