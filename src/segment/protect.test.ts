import { describe, it, expect } from "vitest";
import { protectMath, restoreMath, describeMarkIssues, MARK_OPEN } from "./protect.js";

describe("protectMath", () => {
  it("インライン数式・表示数式・数式環境を印へ差し替える", () => {
    const src =
      "We set $\\alpha = 0.05$ and \\[ L = \\sum_i y_i \\] with \\begin{align}a=b\\end{align} here.";
    const p = protectMath(src);
    expect(p.spans).toHaveLength(3);
    expect(p.text).toBe("We set 〔1〕 and 〔2〕 with 〔3〕 here.");
    expect(p.spans[0]).toBe("$\\alpha = 0.05$");
  });

  it("数式が無ければ何もしない", () => {
    const p = protectMath("Plain prose without math.");
    expect(p.text).toBe("Plain prose without math.");
    expect(p.spans).toEqual([]);
  });

  it("原文が印そのものを含むなら保護しない（復元で原文を上書きしない）", () => {
    const src = `注記〔1〕は $x$ を指す`;
    const p = protectMath(src);
    expect(p.text).toBe(src);
    expect(p.spans).toEqual([]);
  });

  it("verbatim の中の $ は数式として扱わない（走査器の既存の約束）", () => {
    const src = "\\begin{verbatim}price = $5 or $6\\end{verbatim} and $x$ here.";
    const p = protectMath(src);
    expect(p.spans).toEqual(["$x$"]);
    expect(p.text).toContain("price = $5 or $6");
  });
});

describe("restoreMath", () => {
  const src = "We set $\\alpha$ and $\\beta$ here.";

  it("印を元の数式へ戻す（語順が変わっていても戻る）", () => {
    const p = protectMath(src);
    const r = restoreMath("ここでは〔2〕と〔1〕を設定した。", p.spans);
    expect(r.text).toBe("ここでは$\\beta$と$\\alpha$を設定した。");
    expect(r.missing).toEqual([]);
  });

  it("全角数字・空白入りの印も拾う", () => {
    const p = protectMath(src);
    const r = restoreMath("〔１〕と〔 2 〕を設定した。", p.spans);
    expect(r.text).toBe("$\\alpha$と$\\beta$を設定した。");
    expect(r.missing).toEqual([]);
  });

  it("消えた印を番号で報告する", () => {
    const p = protectMath(src);
    const r = restoreMath("〔1〕だけを設定した。", p.spans);
    expect(r.missing).toEqual([2]);
  });

  it("重複した印を報告する（同じ数式が複製される）", () => {
    const p = protectMath(src);
    const r = restoreMath("〔1〕と〔1〕と〔2〕。", p.spans);
    expect(r.duplicated).toEqual([1]);
  });

  it("原文に無い番号は復元せず印のまま残して報告する", () => {
    const p = protectMath(src);
    const r = restoreMath("〔1〕と〔2〕と〔9〕。", p.spans);
    expect(r.unknown).toEqual([9]);
    expect(r.text).toContain("〔9〕");
  });

  it("保護していない訳文はそのまま返す", () => {
    const r = restoreMath("印の無い訳文〔1〕。", []);
    expect(r.text).toBe("印の無い訳文〔1〕。");
  });
});

describe("往復", () => {
  it("印を保った訳なら数式は原文と 1 文字も違わない", () => {
    const src =
      "The score is $0.83 \\pm 0.05$ and the loss \\[ L = \\sum_{i=1}^{N} (y_i - \\hat{y}_i)^2 \\] is minimized.";
    const p = protectMath(src);
    const r = restoreMath(`スコアは〔1〕であり、損失〔2〕を最小化する。`, p.spans);
    expect(r.text).toContain("$0.83 \\pm 0.05$");
    expect(r.text).toContain("\\[ L = \\sum_{i=1}^{N} (y_i - \\hat{y}_i)^2 \\]");
    expect(r.missing).toEqual([]);
  });
});

describe("describeMarkIssues", () => {
  it("欠落・重複・創作をそれぞれ名指しする", () => {
    const msgs = describeMarkIssues({
      text: "",
      missing: [2, 3],
      duplicated: [1],
      unknown: [9],
    });
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toContain(`${MARK_OPEN}2`);
    expect(msgs[0]).toContain(`${MARK_OPEN}3`);
    expect(msgs[1]).toContain("2 回以上");
    expect(msgs[2]).toContain("原文に無い印");
  });

  it("問題が無ければ何も言わない", () => {
    expect(describeMarkIssues({ text: "", missing: [], duplicated: [], unknown: [] })).toEqual([]);
  });
});

// #260: エスケープした特殊文字も書き写させない。
describe("protectMath: エスケープした特殊文字", () => {
  it("\\% を伏せて復元する（backslash 落ちで本文がコメント化する事故を構造的に防ぐ）", () => {
    const src = "253 patients (61\\% male) from CAIN.";
    const g = protectMath(src);
    expect(g.text).toBe("253 patients (61〔1〕 male) from CAIN.");
    expect(restoreMath(g.text.replace("253 patients", "患者 253 名"), g.spans).text).toBe(
      "患者 253 名 (61\\% male) from CAIN.",
    );
  });

  it("\\& \\# \\$ \\_ \\{ \\} も対象にする", () => {
    const g = protectMath("a \\& b \\# c \\$ d \\_ e \\{ f \\}");
    expect(g.spans).toEqual(["\\&", "\\#", "\\$", "\\_", "\\{", "\\}"]);
    expect(restoreMath(g.text, g.spans).text).toBe("a \\& b \\# c \\$ d \\_ e \\{ f \\}");
  });

  it("行終端 \\\\ は伏せない（位置が意味を持ち、セル本文は翻訳対象）", () => {
    const g = protectMath("左 \\\\ 右 \\\\ 末尾");
    expect(g.spans).toEqual([]);
    expect(g.text).toBe("左 \\\\ 右 \\\\ 末尾");
  });

  it("\\\\ の直後の % を綴りと誤認しない（\\\\ は改行、% はコメント開始）", () => {
    const g = protectMath("行末 \\\\% コメント");
    expect(g.spans).toEqual([]);
  });

  it("数式の中の \\% は数式ごと伏せる（二重に伏せない）", () => {
    const g = protectMath("$61\\%$ である");
    expect(g.spans).toEqual(["$61\\%$"]);
    expect(g.text).toBe("〔1〕 である");
  });

  it("verbatim の中は伏せない（ADR で保護対象外）", () => {
    const src = "\\begin{verbatim}printf(\"100\\%\")\\end{verbatim} と 50\\%";
    const g = protectMath(src);
    expect(g.spans).toEqual(["\\%"]);
    expect(restoreMath(g.text, g.spans).text).toBe(src);
  });

  it("数式と特殊文字が混ざっても、印の番号は原文の出現順になる", () => {
    const g = protectMath("50\\% の $x$ と 60\\% の $y$");
    expect(g.spans).toEqual(["\\%", "$x$", "\\%", "$y$"]);
    expect(g.text).toBe("50〔1〕 の 〔2〕 と 60〔3〕 の 〔4〕");
  });

  it("印が落ちたら番号で名指しできる（個数不一致より具体的）", () => {
    const g = protectMath("50\\% の患者");
    const r = restoreMath("患者の 50 パーセント", g.spans);
    expect(r.missing).toEqual([1]);
  });

  it("原文が印そのものを含むなら保護しない（復元で原文を上書きしない）", () => {
    const src = "〔注〕 50\\% である";
    expect(protectMath(src)).toEqual({ text: src, spans: [] });
  });
});

describe("protectMath: keep（本文中の \\title。契約付録 §8）", () => {
  const src = "\\title{A $x$ Study}\n\nWe set $y$ here.";
  const keep: [number, number] = [0, "\\title{A $x$ Study}".length];

  it("keep を丸ごと 1 つの印で伏せ、中の数式は二重に伏せない", () => {
    const p = protectMath(src, { keep });
    expect(p.text).toBe("〔1〕\n\nWe set 〔2〕 here.");
    expect(p.spans).toEqual(["\\title{A $x$ Study}", "$y$"]);
    expect(p.keepMark).toBe(1);
    expect(restoreMath(p.text, p.spans).text).toBe(src);
  });

  it("保護を切っても keep は伏せる", () => {
    const p = protectMath(src, { keep, off: true });
    expect(p.text).toBe("〔1〕\n\nWe set $y$ here.");
    expect(p.keepMark).toBe(1);
  });

  it("原文が印を含むなら keep も伏せない（keepMark なし）", () => {
    const p = protectMath(`${src} ${MARK_OPEN}`, { keep });
    expect(p.spans).toEqual([]);
    expect(p.keepMark).toBeUndefined();
  });
});
