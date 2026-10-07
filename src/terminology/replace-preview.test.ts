import { describe, it, expect } from "vitest";
import { plainText, sentencePreviews, sourceSentences } from "./replace-preview.js";
import { findOccurrences } from "./replace.js";

const shields = [{ src: "empirical Rashomon set", ja: "経験的ラショモン集合" }];

describe("確認画面の断片（契約付録 §9）", () => {
  it("出現を文ごとにまとめ、置換前と置換後に印を付け、前後の文を添える", () => {
    const text = "前の文。ラショモン集合と経験的ラショモン集合を比べる。後の文。";
    const occs = findOccurrences(text, "ラショモン集合", shields);
    const [p, ...rest] = sentencePreviews(text, occs, "羅生門集合");
    expect(rest).toEqual([]);
    expect(p!.before).toEqual([
      { text: "ラショモン集合", mark: "old" },
      { text: "と経験的" },
      { text: "ラショモン集合", mark: "shield" },
      { text: "を比べる。" },
    ]);
    expect(p!.after).toEqual([
      { text: "羅生門集合", mark: "new" },
      { text: "と経験的" },
      { text: "ラショモン集合", mark: "shield" },
      { text: "を比べる。" },
    ]);
    expect(p!.prev).toBe("前の文。");
    expect(p!.next).toBe("後の文。");
    expect(p!.replaced).toBe(1);
    expect(p!.shieldedBy).toEqual(["empirical Rashomon set"]);
  });

  it("原文で原語が出る文を大文字小文字を問わず取り出し、原語に印を付ける", () => {
    const latex = "Intro. The \\textbf{Rashomon Set} is large.\n\nWe use the Rashomon set again.";
    const s = sourceSentences(latex, "Rashomon set");
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual([
      { text: "The " },
      { text: "Rashomon Set", mark: "src" },
      { text: " is large." },
    ]);
    expect(s[1]).toEqual([
      { text: "We use the " },
      { text: "Rashomon set", mark: "src" },
      { text: " again." },
    ]);
  });

  it("TeX は読める程度に整え、行内数式は残し、別行立ての数式は［数式］にする", () => {
    expect(plainText("集合 $R_\\epsilon$ は \\cite{a} と \\ref{b}。\\[x=1\\]")).toBe(
      "集合 $R_\\epsilon$ は [引用] と [参照]。 ［数式］",
    );
  });
});
