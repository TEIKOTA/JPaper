import { describe, expect, it } from "vitest";
import { joinWords, pageWords, redactionBoxes, sameMatches } from "./redact-pdf.js";
import { makeRedactor } from "../redact.js";

describe("PDF の語の位置", () => {
  const xml = ["Work", "by", "Taro", "Yamada,", "and", "others"]
    .map((w, i) => `<word xMin="${String(i * 10)}" yMin="5" xMax="${String(i * 10 + 8)}" yMax="9">${w}</word>`)
    .join("");

  it("語をまたぐ一致は当たった語ごとの矩形、句読点が付いた語は語ごと塗る", () => {
    const r = makeRedactor(["Taro Yamada"], Buffer.alloc(32, 1))!;
    expect(redactionBoxes(pageWords(xml), r, 0)).toMatchObject({
      boxes: [
        { x0: 20, y0: 5, x1: 28, y1: 9 },
        { x0: 30, y0: 5, x1: 38, y1: 9 },
      ],
      hits: 1,
    });
  });

  it("当たらなければ空", () => {
    expect(redactionBoxes(pageWords(xml), makeRedactor(["Suzuki"], Buffer.alloc(32, 1))!)).toMatchObject({ boxes: [], hits: 0 });
  });
});

describe("テキスト層と同じつなぎ方", () => {
  // pdflatex で組んだ「Hanako Yamada$^{1}$ and Taro Suzuki\\textsuperscript{2,*}, Yamada Lab.」の語（pdftotext -bbox-layout の実測）。
  const W = (text: string, x0: number, y0: number, x1: number, y1: number) =>
    `<word xMin="${String(x0)}" yMin="${String(y0)}" xMax="${String(x1)}" yMax="${String(y1)}">${text}</word>`;
  const xml = [
    W("Hanako", 148.712, 127.851, 181.642, 136.698),
    W("Yamada", 184.97, 127.851, 220.386, 136.698),
    W("1", 220.388, 126.31, 224.36, 132.503),
    W("and", 228.178, 127.851, 244.23, 136.698),
    W("Taro", 247.547, 127.851, 267.78, 136.698),
    W("Suzuki", 271.098, 127.851, 300.157, 136.698),
    W("2,*", 300.159, 126.31, 310.357, 132.503),
    W(",", 310.855, 127.851, 313.623, 136.698),
    W("Yamada", 316.94, 127.851, 354.024, 136.698),
    W("Lab.", 357.341, 127.851, 376.852, 136.698),
  ].join("");

  it("隙間の無い上付きの番号は空白なしでつなぎ、pdftotext のテキスト層と同じ文字列になる", () => {
    expect(joinWords(pageWords(xml)).joined).toBe("Hanako Yamada1 and Taro Suzuki2,* , Yamada Lab.");
  });

  it("上付きの番号の付いた名前も、テキスト層と同じ数だけ当たる", () => {
    const r = makeRedactor(["Hanako Yamada1"], Buffer.alloc(32, 1))!;
    expect(redactionBoxes(pageWords(xml), r, 0)).toMatchObject({ hits: 1 });
  });

  it("行末で分綴した語は - を落として次の行の語につなぎ、両方の語を塗る", () => {
    const line = (words: string) => `<line>${words}</line>`;
    const hx = [
      line(W("deep", 385.7, 641.8, 407.7, 652.8) + W("neu-", 410.2, 641.8, 431.3, 652.8)),
      line(W("ral", 72.7, 655.3, 85.0, 666.2) + W("network", 87.4, 655.3, 126.1, 666.2) + W("regime", 128.5, 655.3, 160.5, 666.2)),
    ].join("");
    expect(joinWords(pageWords(hx)).joined).toBe("deep neural network regime");
    const r = makeRedactor(["neural network"], Buffer.alloc(32, 1))!;
    const { boxes, hits } = redactionBoxes(pageWords(hx), r, 0);
    expect(hits).toBe(1);
    expect(boxes.map((b) => b.x0)).toEqual([410.2, 72.7, 87.4]);
  });

  it("ページの最後の語の - は落とさない", () => {
    expect(joinWords(pageWords(`<line>${W("pre-", 72, 100, 90, 110)}</line>`)).joined).toBe("pre-");
  });

  it("段の最後の行の - は落とさない（pdftotext は段をまたいで分綴を外さない）", () => {
    const hx = `<flow><block><line>${W("Kobaya-", 300, 700, 330, 710)}</line></block></flow><flow><block><line>${W("shi", 72, 100, 85, 110)}</line></block></flow>`;
    expect(joinWords(pageWords(hx)).joined).toBe("Kobaya- shi");
  });

  it("行末で分綴したハイフン入りの語（Jean- / Pierre）も当て、両方の語を塗る", () => {
    const hx = [
      `<line>${W("by", 300, 100, 310, 110)}${W("Jean-", 312, 100, 340, 110)}</line>`,
      `<line>${W("Pierre", 72, 112, 100, 122)}${W("here", 104, 112, 120, 122)}</line>`,
    ].join("");
    const r = makeRedactor(["Jean-Pierre"], Buffer.alloc(32, 1))!;
    const { boxes, hits } = redactionBoxes(pageWords(hx), r, 0);
    expect(hits).toBe(1);
    expect(boxes.map((b) => b.x0)).toEqual([312, 72]);
  });

  it("当たりの数が同じでも、空白の入り方だけが違って当たらない語がどちらかにあれば、食い違いとみなす", () => {
    const r = makeRedactor(["Hanako Yamada"], Buffer.alloc(32, 1))!;
    // テキスト層は 2 つ目、つないだ語は 1 つ目の場所でだけ当たる（同じ定型文に挟まれていても見分ける）。
    const line = (name: string): string => `Thanks to the reviewers and to ${name} for the comments on this draft.`;
    const text = `${line("HanakoYamada")}\n${line("Hanako Yamada")}`;
    const joined = `${line("Hanako Yamada")} ${line("HanakoYamada")}`;
    expect(sameMatches(text, joined, r)).toBe(false);
    // テキスト層とつないだ語で、空白・改行・書字方向の制御文字の入り方だけが違う同じ当たりは、食い違いとみなさない。
    expect(sameMatches("a Hanako\nYamada1, b \u202bx\u202c", "a Hanako Yamada 1 , b x", r)).toBe(true);
    // 語の中で空白が入り、当たらずに残る語（Yama da）があれば食い違い。
    expect(sameMatches("a Hanako Yamada b", "a Hanako Yama da b", r)).toBe(false);
  });

  it("語の文字はテキスト層と同じにする（&apos; などの実体参照を戻し、制御文字を落とす）", () => {
    const xml = `<line>${W("O&apos;Brien&#8217;s", 72, 100, 120, 110)}${W("in\u0002es", 124, 100, 150, 110)}</line>`;
    expect(pageWords(xml).map((w) => w.text)).toEqual(["O'Brien’s", "ines"]);
  });
});
