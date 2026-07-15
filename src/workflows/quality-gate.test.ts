import { describe, it, expect } from "vitest";
import { formalCheck } from "./quality-gate.js";
import type { ResolvedTerm } from "../types/contract.js";

const kinds = (src: string, ja: string, terms: ResolvedTerm[] = []) =>
  formalCheck(src, ja, terms).map((i) => i.kind);

describe("formalCheck: 数式", () => {
  it("個数一致は pass、欠落は math issue", () => {
    expect(formalCheck("$x$ and $y$", "$x$ と $y$", [])).toEqual([]);
    expect(kinds("$x$ and $y$", "$x$ のみ")).toContain("math");
  });
  it("\\[ \\] や align 環境も数える", () => {
    expect(formalCheck("\\[a\\] \\begin{align}b\\end{align}", "\\[a\\] \\begin{align}b\\end{align}", [])).toEqual([]);
    expect(kinds("\\begin{align}b\\end{align}", "訳のみ")).toContain("math");
  });
});

describe("formalCheck: 図(\\includegraphics)", () => {
  const FIG_SRC =
    "\\begin{figure}\\includegraphics[scale=0.6]{Figures/ModalNet-21}\\caption{The Transformer}\\end{figure}";
  it("図を保持すれば pass", () => {
    expect(formalCheck(FIG_SRC, FIG_SRC.replace("The Transformer", "トランスフォーマー"), [])).toEqual([]);
  });
  it("図の脱落（キャプションだけ訳して \\includegraphics を落とす）を検出", () => {
    const dropped = "\\begin{figure}\\caption{トランスフォーマー}\\end{figure}";
    expect(kinds(FIG_SRC, dropped)).toContain("graphics");
  });
  it("複数図の一部脱落も検出（src=2 ja=1）", () => {
    const src = "\\includegraphics{a.png} と \\includegraphics[width=1cm]{b.pdf}";
    const ja = "\\includegraphics{a.png} のみ";
    expect(kinds(src, ja)).toContain("graphics");
  });
  it("オプション無し・\\includegraphics* も数える", () => {
    expect(formalCheck("\\includegraphics{a}", "訳 \\includegraphics{a}", [])).toEqual([]);
    expect(formalCheck("\\includegraphics*[p]{a}", "訳 \\includegraphics*[p]{a}", [])).toEqual([]);
  });
  it("図の水増し（幻覚で増やす）も検出（src=1 ja=2）", () => {
    expect(kinds("\\includegraphics{a}", "\\includegraphics{a}\\includegraphics{b}")).toContain("graphics");
  });
  it("\\includegraphicsbox 等の別コマンドは誤検知しない", () => {
    // 直後が [ か { でなければ拾わない＝別マクロを図と誤認しない。
    expect(formalCheck("\\includegraphicsbox は図ではない", "\\includegraphicsbox は図ではない", [])).toEqual([]);
  });
});

describe("formalCheck: 段落", () => {
  it("水増し（訳>原）を検出", () => {
    expect(kinds("a", "訳a\n\n余分")).toContain("paragraph");
  });
  it("欠落（原の50%未満）を検出", () => {
    expect(kinds("a\n\nb\n\nc\n\nd", "one")).toContain("paragraph");
  });
  it("訳≦原かつ50%以上は pass", () => {
    expect(formalCheck("a\n\nb", "訳ab", [])).toEqual([]);
  });
});

describe("formalCheck: keep-original", () => {
  const t: ResolvedTerm = {
    src: "BLEU",
    form: "BLEU",
    class: "do-not-translate",
    rendering: "keep-original",
    firstOccurrence: true,
  };
  it("原形保持は pass、消失は issue", () => {
    expect(formalCheck("BLEU score", "BLEU スコア", [t])).toEqual([]);
    expect(kinds("BLEU score", "スコア", [t])).toContain("keep-original");
  });
});

describe("formalCheck: bilingual", () => {
  const first: ResolvedTerm = {
    src: "value",
    form: "値(Value)",
    class: "paper-defined",
    rendering: "bilingual",
    firstOccurrence: true,
  };
  const later: ResolvedTerm = { ...first, firstOccurrence: false };

  it("初出は併記形が必要", () => {
    expect(formalCheck("value", "値(Value) を使う", [first])).toEqual([]);
    expect(kinds("value", "値 を使う", [first])).toContain("bilingual");
  });
  it("2回目以降は日本語のみ（併記形はNG）", () => {
    expect(formalCheck("value", "値 を使う", [later])).toEqual([]);
    expect(kinds("value", "値(Value) を使う", [later])).toContain("bilingual");
  });

  it("併記形を持たない form（日本語のみ）は 2回目以降でも誤検知しない", () => {
    const plain: ResolvedTerm = {
      src: "x",
      form: "用語",
      class: "paper-defined",
      rendering: "bilingual",
      firstOccurrence: false,
    };
    expect(formalCheck("x", "用語を繰り返し用語と使う", [plain])).toEqual([]);
  });

  it("原語を含まない日本語括弧注記の form は誤検知しない", () => {
    const jaParen: ResolvedTerm = {
      src: "y",
      form: "用語（仮称）",
      class: "paper-defined",
      rendering: "bilingual",
      firstOccurrence: false,
    };
    expect(formalCheck("y", "用語（仮称）を繰り返し使う", [jaParen])).toEqual([]);
  });
});
