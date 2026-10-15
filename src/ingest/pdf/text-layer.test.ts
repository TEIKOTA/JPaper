import { describe, expect, it } from "vitest";
import { hasTextLayer, normalizePageText, parsePageRange, stripRepeatedLines } from "./text-layer.js";

const FOOTER = [
  "Purchased from Example Society for the exclusive use of Somebody (ABCDEF)",
  "Copyright 2025 Example Society. Duplication prohibited.",
];

function page(head: string, body: string, footer = FOOTER): string {
  return [head, "", body, "", ...footer].join("\n");
}

describe("繰り返す行の削除", () => {
  const pages = [
    page("18.3. Convergence Results for SGD\n\n299", "Some comments are in order."),
    page("300\n\n18. Convergence Analysis of Stochastic Gradient Descent", "Lemma 18.5 shows that"),
    page("18.3. Convergence Results for SGD\n\n301", "see Remark 18.1. We will"),
    page("302\n\n18. Convergence Analysis of Stochastic Gradient Descent", "The next step is"),
  ];

  it("柱・ノンブル・購入者表示を落とし、本文は残す", () => {
    const out = stripRepeatedLines(pages);
    expect(out[0]).toBe("Some comments are in order.");
    expect(out[1]).toBe("Lemma 18.5 shows that");
    expect(out.join("\n")).not.toContain("Purchased");
    expect(out.join("\n")).not.toContain("Convergence Analysis");
  });

  it("読むページが 3 枚未満なら判定しない", () => {
    expect(stripRepeatedLines(pages.slice(0, 2))).toEqual(pages.slice(0, 2));
  });

  it("ページごとに違う本文の先頭行・末尾行は落とさない", () => {
    const out = stripRepeatedLines(pages);
    expect(out[2]).toBe("see Remark 18.1. We will");
  });

  it("本文の語がローマ数字の綴りに見えても、数字だけの行でなければ落とさない", () => {
    const ps = pages.map((p, i) => (i === 0 ? p.replace("Some comments are in order.", "Some comments.\nmix") : p));
    expect(stripRepeatedLines(ps)[0]).toContain("mix");
  });
});

describe("テキスト層の有無", () => {
  it("非空白が 20 文字未満ならテキスト層なし", () => {
    expect(hasTextLayer("  12 \n\n ")).toBe(false);
    expect(hasTextLayer("This page has enough text.")).toBe(true);
  });

  it("改ページ文字と制御文字を落とす", () => {
    expect(normalizePageText("\nabc\u0007  \n\f")).toBe("abc");
  });
});

describe("ページ範囲", () => {
  it("N・N-M・カンマ区切りを昇順で返し、重複を除く", () => {
    expect(parsePageRange("3,1-2, 2", 10)).toEqual([1, 2, 3]);
  });

  it("PDF のページ数を超える・逆順・0・空は入力エラー", () => {
    for (const bad of ["0", "5-3", "1-11", "", "a", "1-"]) {
      expect(() => parsePageRange(bad, 10)).toThrow(/--pages/);
    }
  });
});
