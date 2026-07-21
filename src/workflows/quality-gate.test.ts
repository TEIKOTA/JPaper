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
  it("個数は同じでも置換（b→a 重複）は検出（multiset 照合）", () => {
    // 個数一致だけの検査ではすり抜ける: src={a},{b} ja={a},{a}。パス multiset で b 脱落を捕捉。
    const src = "\\includegraphics{a.pdf} と \\includegraphics{b.pdf}";
    const ja = "\\includegraphics{a.pdf} と \\includegraphics{a.pdf}";
    expect(kinds(src, ja)).toContain("graphics");
  });
  it("出現順が違ってもパス集合が同じなら pass（multiset）", () => {
    const src = "\\includegraphics{a} 次に \\includegraphics{b}";
    const ja = "\\includegraphics{b} 次に \\includegraphics{a}";
    expect(formalCheck(src, ja, [])).toEqual([]);
  });
  it("コメントアウトした図は数えない（偽陽性を防ぐ）", () => {
    // src の % \includegraphics{old} はコメント＝図ではない。訳がそれを落としても図脱落にしない。
    expect(formalCheck("本文 % \\includegraphics{old}\n続き", "本文 \n続き", [])).toEqual([]);
  });
  it("コメントで分断された \\includegraphics%\\n{a} も1件として拾う（偽陰性を防ぐ）", () => {
    const src = "\\includegraphics% コメント\n{a.pdf}";
    expect(formalCheck(src, "訳 \\includegraphics{a.pdf}", [])).toEqual([]);
    expect(kinds(src, "訳のみ")).toContain("graphics");
  });
  it("エスケープした \\% はコメント扱いしない", () => {
    expect(formalCheck("50\\% と \\includegraphics{a}", "50\\% と \\includegraphics{a}", [])).toEqual([]);
  });
  it("\\includegraphicsbox 等の別コマンドは誤検知しない", () => {
    // 直後に {path} を要求＝別マクロを図と誤認しない。
    expect(formalCheck("\\includegraphicsbox{x} は図ではない", "\\includegraphicsbox{x} は図ではない", [])).toEqual([]);
  });
  it("未閉じ { が多数でも O(n) で打ち切る（壊れた入力の CPU 消費を防ぐ）", () => {
    const malformed = "\\includegraphics{".repeat(20000); // 未閉じ 2万個
    const t0 = Date.now();
    const r = formalCheck("\\includegraphics{a}", malformed, []);
    expect(Date.now() - t0).toBeLessThan(500); // 単一走査で高速
    expect(r.map((i) => i.kind)).toContain("graphics"); // 壊れた ja は不一致で flag
  });
  it("入れ子波括弧のパスも平衡して抽出（{{plot}.pdf}→{{plot}.png} の置換を検出）", () => {
    const src = "\\includegraphics{{plot}.pdf}";
    expect(formalCheck(src, "\\includegraphics{{plot}.pdf}", [])).toEqual([]);
    expect(kinds(src, "\\includegraphics{{plot}.png}")).toContain("graphics");
  });
  it("\\\\%（偶数バックスラッシュ）後の図はコメント＝脱落として検出する", () => {
    // TeX 上 \\ は改行命令で続く % はコメント開始。ja で図を \\% でコメントアウト＝実質脱落なので flag する。
    expect(kinds("\\includegraphics{a}", "\\\\% \\includegraphics{a}")).toContain("graphics");
    // 奇数（\%）はエスケープ＝コメントではないので図は生きている（pass）。
    expect(formalCheck("x \\includegraphics{a}", "x \\% \\includegraphics{a}", [])).toEqual([]);
  });
});

describe("formalCheck: \\label（相互参照の定義）", () => {
  it("\\label を保持すれば pass", () => {
    const src = "\\section{注意}\\label{sec:attention} 本文";
    expect(formalCheck(src, "\\section{注意}\\label{sec:attention} 訳文", [])).toEqual([]);
  });
  it("\\label の脱落を検出（\\ref を未解決にする脱落）", () => {
    const src = "\\section{注意}\\label{sec:attention} 本文";
    expect(kinds(src, "\\section{注意} 訳文")).toContain("label");
  });
  it("複数 label の一部脱落・置換も multiset で検出", () => {
    const src = "\\label{a}\\label{b}";
    expect(kinds(src, "\\label{a}\\label{a}")).toContain("label");
    expect(formalCheck(src, "\\label{b}\\label{a}", [])).toEqual([]); // 順序違いは pass
  });
  it("コメントアウトした \\label は数えない", () => {
    expect(formalCheck("本文 % \\label{old}\n続き", "本文 \n続き", [])).toEqual([]);
  });
});

describe("formalCheck: 見出し未訳", () => {
  const keep = (src: string): ResolvedTerm => ({
    src,
    form: src,
    class: "do-not-translate",
    rendering: "keep-original",
    firstOccurrence: false,
  });
  // src を与えて段落数を揃え、heading 判定だけを見る（空 src だと段落水増しが混じるため）。
  const h = (src: string, ja: string, terms: ResolvedTerm[] = []) => kinds(src, ja, terms);
  it("英語のままの見出しを検出（\\section/\\subsection/\\subsubsection）", () => {
    expect(h("\\section{Training}", "\\section{Training}")).toContain("heading");
    expect(h("\\subsection{Hardware and Schedule}", "\\subsection{Hardware and Schedule}")).toContain("heading");
    expect(h("\\subsubsection{Scaled Dot-Product Attention}", "\\subsubsection{Scaled Dot-Product Attention}")).toContain("heading");
  });
  it("訳済み・併記の見出しは heading を出さない（日本語を含む）", () => {
    expect(h("\\section{Training}", "\\section{訓練}")).not.toContain("heading");
    expect(h("\\section{Model Architecture}", "\\section{モデルアーキテクチャ(model architecture)}")).not.toContain("heading");
    expect(h("\\subsection{Attention} \\label{s}", "\\subsection{注意} \\label{s}")).not.toContain("heading");
  });
  it("全大文字の略語・数字のみの見出しは誤検知しない（小文字 Latin 無し）", () => {
    expect(h("\\section{BLEU}", "\\section{BLEU}")).not.toContain("heading");
    expect(h("\\subsection{WMT 2014}", "\\subsection{WMT 2014}")).not.toContain("heading");
    expect(h("\\section{GPU}", "\\section{GPU}")).not.toContain("heading");
  });
  it("keep-original 固有名だけの見出しは除外（Transformer 等）", () => {
    expect(h("\\section{Transformer}", "\\section{Transformer}", [keep("Transformer")])).not.toContain("heading");
    // keep-original を除いても訳すべき語が残れば検出
    expect(h("\\section{Transformer Training}", "\\section{Transformer Training}", [keep("Transformer")])).toContain("heading");
  });
  it("複数見出しの一部だけ未訳でも検出", () => {
    const src = "\\section{Background}\n本文\n\\subsection{Training}";
    const ja = "\\section{背景}\n本文\n\\subsection{Training}";
    expect(h(src, ja)).toContain("heading");
  });
  it("数式・制御綴りだけの見出しは誤検知しない（可視テキストで判定）", () => {
    // 生 LaTeX の $p$ や \textsc/\emph の英小文字を未訳と誤認しない（再訳でも直せず MAX 到達を防ぐ）。
    expect(h("\\section{$p$}", "\\section{$p$}")).not.toContain("heading");
    expect(h("\\section{\\textsc{BLEU}}", "\\section{\\textsc{BLEU}}")).not.toContain("heading");
    expect(h("\\section{\\emph{Transformer}}", "\\section{\\emph{Transformer}}", [keep("Transformer")])).not.toContain("heading");
  });
  it("\\chapter・\\part も対象", () => {
    expect(h("\\chapter{Introduction}", "\\chapter{Introduction}")).toContain("heading");
  });
  it("keep-original は語境界で除去（部分一致で Part→art を消さない）", () => {
    expect(h("\\section{Part}", "\\section{Part}", [keep("art")])).toContain("heading");
  });
  it("半角カタカナも日本語として扱う", () => {
    expect(h("\\section{Model}", "\\section{ﾓﾃﾞﾙ}")).not.toContain("heading");
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
