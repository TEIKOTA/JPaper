import { describe, it, expect } from "vitest";
import { latexEscape, injectFootnotes, renderBackmatter } from "./render-notes.js";
import type { TranslatorNote } from "../types/contract.js";

const note = (over: Partial<TranslatorNote>): TranslatorNote => ({
  id: "n",
  trigger: "low-confidence",
  segmentId: "seg-0000",
  firstOccurrence: true,
  text: "説明",
  ...over,
});
const forms = new Map([
  ["attention", "注意"],
  ["Transformer", "Transformer"],
]);

describe("latexEscape", () => {
  it("特殊文字をエスケープする", () => {
    expect(latexEscape("a_b 50% & c")).toBe("a\\_b 50\\% \\& c");
  });
});

describe("injectFootnotes", () => {
  it("form の初出直後に \\footnote を入れる", () => {
    const out = injectFootnotes("注意は重要。注意を再掲。", "seg-0000", [note({ src: "attention", text: "t" })], forms);
    expect(out).toBe("注意\\footnote{訳注: t}は重要。注意を再掲。");
  });
  it("数式内の出現はスキップし、次の非数式出現に付ける", () => {
    const out = injectFootnotes("式 $注意$ のあと 注意 を説明", "seg-0000", [note({ src: "attention" })], forms);
    expect(out).toBe("式 $注意$ のあと 注意\\footnote{訳注: 説明} を説明");
  });
  it("別セグメントの注や form 不在は無視する", () => {
    expect(injectFootnotes("注意", "seg-0000", [note({ src: "attention", segmentId: "seg-0001" })], forms)).toBe("注意");
    expect(injectFootnotes("注意", "seg-0000", [note({ src: "unknown" })], forms)).toBe("注意");
  });
  it("複数注でもインデックスがずれない", () => {
    const notes = [note({ id: "a", src: "Transformer", text: "T" }), note({ id: "b", src: "attention", text: "A" })];
    const out = injectFootnotes("Transformer と 注意 の話", "seg-0000", notes, forms);
    expect(out).toBe("Transformer\\footnote{訳注: T} と 注意\\footnote{訳注: A} の話");
  });
  it("数式環境の中には入れない（\\begin{align} を壊さない）", () => {
    // $ の個数しか見ていなかった頃は \begin{align\footnote{...}} を生成し、組版が
    // 確実に落ちた。注入は品質ゲートの後なので、全節 pass した翻訳を後段で壊せた。
    const f = new Map([["x", "align"]]);
    const tex = "\\begin{align}a &= b\\end{align}";
    expect(injectFootnotes(tex, "seg-0000", [note({ src: "x" })], f)).toBe(tex);
  });

  it("\\[..\\] の中にも入れない", () => {
    const f = new Map([["x", "E = mc"]]);
    const tex = "\\[E = mc^2\\]";
    expect(injectFootnotes(tex, "seg-0000", [note({ src: "x" })], f)).toBe(tex);
  });

  it("語の途中の部分一致には付けない", () => {
    const f = new Map([["x", "tion"]]);
    const tex = "translation の話";
    expect(injectFootnotes(tex, "seg-0000", [note({ src: "x" })], f)).toBe(tex);
  });

  it("制御綴りの綴りには付けず、地の文の出現に付ける", () => {
    const f = new Map([["x", "section"]]);
    const out = injectFootnotes("\\section{見出し} この section を説明", "seg-0000", [note({ src: "x" })], f);
    expect(out).toBe("\\section{見出し} この section\\footnote{訳注: 説明} を説明");
  });
});

describe("renderBackmatter", () => {
  it("全注を巻末 itemize に列挙する", () => {
    const out = renderBackmatter(
      [note({ src: "attention", text: "A" }), note({ trigger: "evaluator-warn", text: "W" })],
      forms,
    );
    expect(out).toContain("\\section*{訳注一覧}");
    expect(out).toContain("\\textbf{注意}（attention）: A");
    expect(out).toContain("\\textbf{訳注}: W");
  });
  it("注が無ければ空", () => {
    expect(renderBackmatter([], forms)).toBe("");
  });
});

describe("保護領域の走査コスト", () => {
  it("閉じない \\[ の羅列でも線形", () => {
    // 遅延正規表現で区間を拾っていた頃は開始位置ごとに末尾まで走査して二次だった
    // （実測 128KiB で 1,079ms）。入力は訳文なので上限は MAX_RESPONSE_CHARS。
    const tex = "\\[".repeat(Math.floor((8 * 1024 * 1024) / 2));
    const notes = [
      { segmentId: "s", src: "x", text: "t", trigger: "evaluator-warn", firstOccurrence: true },
    ] as never;
    const started = Date.now();
    injectFootnotes(tex, "s", notes, new Map([["x", "x"]]));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("参照・パス系の引数を壊さない", () => {
  const note = (src: string) =>
    [
      {
        segmentId: "s",
        src,
        text: "説明",
        trigger: "evaluator-warn" as const,
        firstOccurrence: true,
      },
    ] as never;

  it.each([
    ["overview", "図を \\label{fig:overview} で参照する。"],
    ["fig:overview", "図を \\label{fig:overview} で参照する。"],
    ["fig1.png", "\\includegraphics{fig1.png} を参照。"],
    ["sec:method", "詳細は \\ref{sec:method} を見よ。"],
  ])("form=%s がラベル名・図パスと一致しても引数の中へ脚注を入れない", (form, tex) => {
    // 制御綴りそのものしか保護していなかった頃は \label{fig:overview\footnote{…}} を
    // 生成して組版が落ちた。品質ゲートの multiset 検査を通過した後の破壊なので、
    // ゲートでは捕まえられない。
    expect(injectFootnotes(tex, "s", note(form), new Map([[form, form]]))).toBe(tex);
  });

  it("地の文の語には従来どおり脚注が入る", () => {
    const out = injectFootnotes(
      "Transformer を用いる。",
      "s",
      note("Transformer"),
      new Map([["Transformer", "Transformer"]]),
    );
    expect(out).toContain("Transformer\\footnote{訳注: 説明}");
  });
});

describe("verbatim・行送りに釣られた保護のずれ", () => {
  const notes = [note({ src: "attention", text: "注意機構" })];
  const forms = new Map([["attention", "attention"]]);

  it("コード片の生の $ で数式の内側へ脚注を入れない", () => {
    const tex =
      "\\begin{lstlisting}\necho $HOME\n\\end{lstlisting}\n" +
      "The attention mechanism. 数式は $\\mathrm{attention}(Q,K,V)$ で与えられる。";
    const out = injectFootnotes(tex, "seg-0000", notes, forms);
    expect(out).toContain("The attention\\footnote{訳注: 注意機構} mechanism.");
    expect(out).toContain("$\\mathrm{attention}(Q,K,V)$");
  });

  it("\\\\[3pt] があっても脚注が入る（保護域の暴走）", () => {
    const tex =
      "\\begin{tabular}{ll} a & b \\\\[3pt] c & d \\end{tabular}\n" +
      "The attention mechanism. 損失は \\[ L = x \\] とする。";
    const out = injectFootnotes(tex, "seg-0000", notes, forms);
    expect(out).toContain("attention\\footnote{訳注: 注意機構}");
  });
});

describe("壊れた訳文の走査コスト", () => {
  it.each([["\\ref{"], ["\\label{"], ["\\lstinline{"], ["\\includegraphics["]])(
    "未閉じ %s の羅列 1MiB でも秒未満",
    (unit: string) => {
      const body = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const s = Date.now();
      injectFootnotes(body, "seg-0000", [], new Map());
      expect(Date.now() - s).toBeLessThan(1_500);
    },
  );
});
