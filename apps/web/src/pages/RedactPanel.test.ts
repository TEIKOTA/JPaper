import { describe, expect, it } from "vitest";
import { termFromWords, validTerm, wordsInRect } from "./RedactPanel.js";
import { parseTermLines } from "./TranslatePage.js";

describe("伏せ字の範囲選択（画面）", () => {
  const w = (text: string, x0: number, y0: number) => ({ text, x0, y0, x1: x0 + 30, y1: y0 + 10 });
  const words = [w("Yamada.", 100, 50), w("Hanako", 60, 50), w("next", 60, 70)];

  it("範囲に重なる語を上から・左から順に選び、前後の句読点を落としてつなぐ", () => {
    const picked = wordsInRect(words, { x0: 55, y0: 45, x1: 140, y1: 58 });
    expect(picked.map((x) => x.text)).toEqual(["Hanako", "Yamada."]);
    expect(termFromWords(picked)).toBe("Hanako Yamada");
  });

  it("語の長さと制御文字を検査する", () => {
    expect(validTerm("Yamada")).toBe(true);
    expect(validTerm("Y")).toBe(false);
    expect(validTerm("a\tb")).toBe(false);
  });

  it("伏せ字のファイルは 1 行 1 語。空行と # の行は読まず、形が違えば undefined", () => {
    expect(parseTermLines("# me\n Taro Yamada \n\nTaro Yamada\n")).toEqual(["Taro Yamada"]);
    expect(parseTermLines("X\n")).toBeUndefined();
  });
});
