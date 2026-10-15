import { describe, expect, it } from "vitest";
import { hyphenated as cliHyphenated, joinWords, spaceBetween as cliSpaceBetween, JOIN_GAP as CLI_JOIN_GAP } from "../../../../src/ingest/pdf/redact-pdf.js";
import { hyphenated, JOIN_GAP, spaceBetween, termFromWords, validTerm, wordsInRect } from "./RedactPanel.js";
import { formReady, parseTermLines } from "./TranslatePage.js";

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

  it("上付きの番号のように隙間なく続く語は、空白なしでつなぐ（テキスト層と同じ）", () => {
    const name = [
      { text: "Hanako", x0: 148.712, y0: 127.851, x1: 181.642, y1: 136.698 },
      { text: "Yamada", x0: 184.97, y0: 127.851, x1: 220.386, y1: 136.698 },
      { text: "1", x0: 220.388, y0: 126.31, x1: 224.36, y1: 132.503 },
    ];
    expect(termFromWords(name)).toBe("Hanako Yamada1");
  });

  it("語のつなぎ方は CLI（redact-pdf.ts）と同じ", () => {
    expect(JOIN_GAP).toBe(CLI_JOIN_GAP);
    const a = { x0: 100, y0: 100, x1: 130, y1: 110 };
    const cases = [
      { x0: 130.001, y0: 98, x1: 134, y1: 105 },
      { x0: 130.3, y0: 100, x1: 150, y1: 110 },
      { x0: 129.9, y0: 100, x1: 150, y1: 110 },
      { x0: 90, y0: 100, x1: 99, y1: 110 },
      { x0: 130.1, y0: 111, x1: 150, y1: 120 },
      { x0: 130.24, y0: 109, x1: 150, y1: 119 },
    ];
    for (const b of cases) expect(spaceBetween(a, b), JSON.stringify(b)).toBe(cliSpaceBetween(a, b));
    for (const w of [{ text: "neu-", eol: true }, { text: "neu-" }, { text: "neu", eol: true }, { text: "-", eol: true }]) {
      expect(hyphenated(w), JSON.stringify(w)).toBe(cliHyphenated(w));
    }
  });

  it("行末で分綴した語は、- を落としてつなぐ（CLI の joinWords と同じ文字列）", () => {
    const words = [
      { text: "deep", x0: 385.7, y0: 641.8, x1: 407.7, y1: 652.8 },
      { text: "neu-", x0: 410.2, y0: 641.8, x1: 431.3, y1: 652.8, eol: true },
      { text: "ral", x0: 72.7, y0: 655.3, x1: 85.0, y1: 666.2 },
      { text: "network", x0: 87.4, y0: 655.3, x1: 126.1, y1: 666.2 },
    ];
    expect(termFromWords(words)).toBe("deep neural network");
    expect(termFromWords(words)).toBe(joinWords(words).joined);
  });

  it("伏せ字の語のファイルを読んでいる間・形が誤りの間、テキスト層と合わない間は、翻訳を始めない", () => {
    const base = { source: "arxiv" as const, arxivId: "2601.20627", termsFile: { loading: false }, uploaded: false, redact: [], redactReady: true };
    expect(formReady(base)).toBe(true);
    expect(formReady({ ...base, termsFile: { loading: true } })).toBe(false);
    expect(formReady({ ...base, termsFile: { loading: false, error: "x" } })).toBe(false);
    const pdf = { ...base, source: "pdf" as const, uploaded: true, redact: [{ term: "Yamada", on: true }] };
    expect(formReady(pdf)).toBe(true);
    expect(formReady({ ...pdf, redactReady: false })).toBe(false);
    expect(formReady({ ...pdf, redactReady: false, redact: [{ term: "Yamada", on: false }] })).toBe(true);
  });
});
