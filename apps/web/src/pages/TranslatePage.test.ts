import { describe, expect, it } from "vitest";
import { countPages } from "./TranslatePage.js";

describe("確認ダイアログの範囲の数え方", () => {
  it("空なら全部、N・N-M・カンマ区切りを重複なしで数える", () => {
    expect(countPages("", 250)).toBe(250);
    expect(countPages("1-72", 250)).toBe(72);
    expect(countPages("3, 5-9, 9", 250)).toBe(6);
  });

  it("形が違う・逆順・0・総ページ数を超える範囲は undefined", () => {
    for (const bad of ["a", "5-3", "0", "1-251", "1-", ","]) expect(countPages(bad, 250), bad).toBeUndefined();
  });
});
