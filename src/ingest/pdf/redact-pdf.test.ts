import { describe, expect, it } from "vitest";
import { pageWords, redactionBoxes } from "./redact-pdf.js";
import { makeRedactor } from "../redact.js";

describe("PDF の語の位置", () => {
  const xml = ["Work", "by", "Taro", "Yamada,", "and", "others"]
    .map((w, i) => `<word xMin="${String(i * 10)}" yMin="5" xMax="${String(i * 10 + 8)}" yMax="9">${w}</word>`)
    .join("");

  it("語をまたぐ一致は当たった語ごとの矩形、句読点が付いた語は語ごと塗る", () => {
    const r = makeRedactor(["Taro Yamada"], Buffer.alloc(32, 1))!;
    expect(redactionBoxes(pageWords(xml), r, 0)).toEqual([
      { x0: 20, y0: 5, x1: 28, y1: 9 },
      { x0: 30, y0: 5, x1: 38, y1: 9 },
    ]);
  });

  it("当たらなければ空", () => {
    expect(redactionBoxes(pageWords(xml), makeRedactor(["Suzuki"], Buffer.alloc(32, 1))!)).toEqual([]);
  });
});
