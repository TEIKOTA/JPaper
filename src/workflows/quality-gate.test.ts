import { describe, it, expect } from "vitest";
import {
  formalCheck,
  untranslatedHeadings,
  introducedUnsafeCommands,
  decodeCarets,
} from "./quality-gate.js";
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

describe("untranslatedHeadings（非ブロッキング lint）", () => {
  // ja と keep-original 語だけを見る決定的検査。結果は訳注へ流れる（formalCheck には載らない）。
  const h = (ja: string, keep: string[] = []) => untranslatedHeadings(ja, keep);
  it("英語のままの見出しを検出（\\section/\\subsection/\\subsubsection）", () => {
    expect(h("\\section{Training}")).not.toEqual([]);
    expect(h("\\subsection{Hardware and Schedule}")).not.toEqual([]);
    expect(h("\\subsubsection{Scaled Dot-Product Attention}")).not.toEqual([]);
  });
  it("訳済み・併記の見出しは検出しない（日本語を含む）", () => {
    expect(h("\\section{訓練}")).toEqual([]);
    expect(h("\\section{モデルアーキテクチャ(model architecture)}")).toEqual([]);
    expect(h("\\subsection{注意} \\label{s}")).toEqual([]);
  });
  it("全大文字の略語・数字のみの見出しは誤検知しない（小文字 Latin 無し）", () => {
    expect(h("\\section{BLEU}")).toEqual([]);
    expect(h("\\subsection{WMT 2014}")).toEqual([]);
    expect(h("\\section{GPU}")).toEqual([]);
  });
  it("keep-original 固有名だけの見出しは除外（Transformer 等）", () => {
    expect(h("\\section{Transformer}", ["Transformer"])).toEqual([]);
    // keep-original を除いても訳すべき語が残れば検出
    expect(h("\\section{Transformer Training}", ["Transformer"])).not.toEqual([]);
  });
  it("複数見出しの一部だけ未訳でも検出", () => {
    const ja = "\\section{背景}\n本文\n\\subsection{Training}";
    expect(h(ja)).toEqual(["Training"]);
  });
  it("数式・制御綴りだけの見出しは誤検知しない（可視テキストで判定）", () => {
    // 生 LaTeX の $p$ や \textsc/\emph の英小文字を未訳と誤認しない。
    expect(h("\\section{$p$}")).toEqual([]);
    expect(h("\\section{\\textsc{BLEU}}")).toEqual([]);
    expect(h("\\section{\\emph{Transformer}}", ["Transformer"])).toEqual([]);
  });
  it("各種数式記法（\\(..\\) / $$..$$ / \\[..\\]）と参照系（\\ref 引数）も誤検知しない", () => {
    expect(h("\\section{\\(p\\)}")).toEqual([]);
    expect(h("\\section{$$p$$}")).toEqual([]);
    // \ref の不可視引数 sec:methods を未訳の地の文と誤認しない
    expect(h("\\subsection{結果 \\ref{sec:methods}}")).toEqual([]);
    expect(h("\\subsection{\\ref{sec:methods}}")).toEqual([]);
  });
  it("中黒（・）は日本語扱いしない＝英語見出しを見逃さない", () => {
    expect(h("\\section{Encoder・Decoder Architecture}")).not.toEqual([]);
  });
  it("\\chapter・\\part も対象", () => {
    expect(h("\\chapter{Introduction}")).not.toEqual([]);
  });
  it("keep-original は語境界で除去（部分一致で Part→art を消さない）", () => {
    expect(h("\\section{Part}", ["art"])).not.toEqual([]);
  });
  it("半角カタカナも日本語として扱う", () => {
    expect(h("\\section{ﾓﾃﾞﾙ}")).toEqual([]);
  });
  it("オプション引数付き見出し（\\section[短縮]{本文}）も本引数で判定", () => {
    expect(h("\\section[Intro]{Introduction}")).toEqual(["Introduction"]);
    expect(h("\\section[概要]{はじめに}")).toEqual([]);
  });
  it("見出し中の \\url / \\includegraphics / \\path は不可視引数扱い（誤検知しない）", () => {
    expect(h("\\section{\\url{https://example.org}}")).toEqual([]);
    expect(h("\\section{\\includegraphics[width=1cm]{logo-file}}")).toEqual([]);
    expect(h("\\section{\\path{src/main.tex}}")).toEqual([]);
    // \href の第2引数（表示テキスト）は訳すべき地の文なので検出は維持
    expect(h("\\section{\\href{https://example.org}{項目}}")).toEqual([]);
    expect(h("\\section{\\href{https://example.org}{items}}")).not.toEqual([]);
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

describe("formalCheck: 未翻訳の検出", () => {
  const PROSE =
    "We evaluate the proposed method on three benchmark datasets and report accuracy, " +
    "precision and recall for every configuration considered in this study.";

  it("原文をそのままコピーした訳文は落とす", () => {
    const issues = formalCheck(PROSE, PROSE, []);
    expect(issues.map((i) => i.kind)).toContain("untranslated");
    expect(issues.find((i) => i.kind === "untranslated")!.message).toContain("原文と同一");
  });

  it("日本語を含まない別文でも落とす", () => {
    const issues = formalCheck(PROSE, `${PROSE} Additionally we discuss limitations.`, []);
    expect(issues.map((i) => i.kind)).toContain("untranslated");
  });

  it("和訳されていれば通す", () => {
    const ja =
      "提案手法を 3 つのベンチマークデータセットで評価し、検討した全ての構成について" +
      "正解率・適合率・再現率を報告する。";
    expect(formalCheck(PROSE, ja, []).filter((i) => i.kind === "untranslated")).toEqual([]);
  });

  it("数式・図だけの節は原文と一致しても未翻訳としない", () => {
    const seg = "\\begin{equation}\n E = mc^2 \\label{eq:e}\n\\end{equation}\n\\includegraphics{a.pdf}";
    expect(formalCheck(seg, seg, []).filter((i) => i.kind === "untranslated")).toEqual([]);
  });
});

describe("formalCheck: 危険コマンドの持ち込み", () => {
  const SRC = "\\section{Intro} The accuracy is $95\\%$.";

  it("訳文が原文に無い \\directlua を持ち込んだら落とす", () => {
    const ja = "\\section{はじめに} 正解率は $95\\%$ である。\\directlua{os.execute(\"touch /tmp/x\")}";
    const issues = formalCheck(SRC, ja, []);
    expect(issues.map((i) => i.kind)).toContain("unsafe-command");
  });

  it("原文にあるコマンドは翻訳者の持ち込みではないので落とさない", () => {
    const src = "\\input{chapter1}\n本文";
    const ja = "\\input{chapter1}\n本文の訳";
    expect(formalCheck(src, ja, []).filter((i) => i.kind === "unsafe-command")).toEqual([]);
  });

  it("introducedUnsafeCommands は持ち込まれた名前だけ返す", () => {
    expect(introducedUnsafeCommands("\\input{a}", "\\input{a}\\write18{x}\\openout1=y")).toEqual([
      "write",
      "openout",
    ]);
  });
});

describe("回避の再検査（ラウンド2）", () => {
  const EN =
    "The Transformer architecture uses attention mechanisms to process sequences " +
    "of tokens in parallel across layers.";

  it("かな1文字を足しただけの英文は未翻訳として落とす", () => {
    const issues = formalCheck(EN, `${EN} の`, []);
    expect(issues.map((i) => i.kind)).toContain("untranslated");
  });

  it("日本語が地の文の語数に見合っていれば通す", () => {
    const ja =
      "Transformer アーキテクチャは、注意機構を用いて系列中のトークンを層をまたいで並列に処理する。";
    expect(formalCheck(EN, ja, []).filter((i) => i.kind === "untranslated")).toEqual([]);
  });

  it("^^ 記法で綴った危険コマンドを検知する", () => {
    const ja = "訳文である。\\^^64irectlua{tex.print(\"x\")}";
    expect(introducedUnsafeCommands(EN, ja)).toContain("directlua");
  });

  it("^^ の1文字記法（XOR 64）も戻して検知する", () => {
    // ^^W は 0x57 ^ 0x40 = 0x17 ではなく、w(0x77)^0x40=0x37。ここは r を ^^2 では表せないので
    // 実在の形として \write を ^^77rite（w=0x77）で綴る。
    expect(introducedUnsafeCommands(EN, "\\^^77rite18{x}")).toContain("write");
  });

  it("decodeCarets は通常の文字列を変えない", () => {
    expect(decodeCarets("\\section{Intro} x^2")).toBe("\\section{Intro} x^2");
  });
});

describe("untranslated の誤検知", () => {
  const bib = Array.from({ length: 30 }, (_, i) =>
    `\\bibitem{r${String(i)}} A. Author and B. Writer, "A fairly long paper title about neural machine translation", Journal of Things, 2020.`,
  ).join("\n");

  it("参考文献を原文のまま残した忠実な訳を落とさない", () => {
    // 参考文献の著者名・論題を地の文と数えていた頃は、忠実な訳ほど日本語比率が
    // 下がって必ず発火し、revision を使い切って run が exit 3 で失敗した。
    const src = `\\section{References}\n\\begin{thebibliography}{99}\n${bib}\n\\end{thebibliography}`;
    const ja = `\\section{参考文献}\n\\begin{thebibliography}{99}\n${bib}\n\\end{thebibliography}`;
    expect(formalCheck(src, ja, []).filter((f) => f.kind === "untranslated")).toEqual([]);
  });

  it("コードリストを原文のまま残した忠実な訳を落とさない", () => {
    const code = Array.from({ length: 20 }, () => "for item in collection: process(item, verbose=True)").join("\n");
    const src = `\\section{Appendix}\n\\begin{lstlisting}\n${code}\n\\end{lstlisting}`;
    const ja = `\\section{付録}\n\\begin{lstlisting}\n${code}\n\\end{lstlisting}`;
    expect(formalCheck(src, ja, []).filter((f) => f.kind === "untranslated")).toEqual([]);
  });

  it("本当に未訳の地の文は従来どおり検出する", () => {
    const body = "This section describes the proposed method and reports experimental results on several benchmarks.";
    const found = formalCheck(`\\section{Method}\n${body}`, `\\section{Method}\n${body}`, []);
    expect(found.some((f) => f.kind === "untranslated")).toBe(true);
  });
});

describe("untranslated 検査そのものを無効化する回避（ラウンド15）", () => {
  const BODY =
    "Deep neural networks have achieved remarkable performance on a wide range of " +
    "benchmark tasks, and we study them here in detail across many different settings.";
  const src = `\\section{Introduction}\n${BODY}`;

  it("% でコメントアウトした非散文環境で英語を囲む訳文を落とす", () => {
    // LaTeX 上はコメント行なので囲まれた英語は PDF に出るのに、生テキストで環境を探していた
    // 頃は地の文が 0 語になり、判定ごとスキップされて全編未訳が exit 0 で通った。
    const ja = `\\section{はじめに}\n%\\begin{verbatim}\n${BODY}\n%\\end{verbatim}`;
    expect(formalCheck(src, ja, []).map((i) => i.kind)).toContain("untranslated");
  });

  it("訳文を 1 文字に切り詰めた「翻訳」を落とす", () => {
    // 訳文側の語数を判定の入口にしていた頃は、日本語 1 文字で全 8 検査が [] になった。
    expect(formalCheck(src, "あ", []).map((i) => i.kind)).toContain("untranslated");
  });

  it("素の非散文環境で英語本文を隠す訳文も落とす", () => {
    const ja = `\\section{はじめに}\n\\begin{verbatim}\n${BODY}\n\\end{verbatim}`;
    expect(formalCheck(src, ja, []).map((i) => i.kind)).toContain("untranslated");
  });
});

describe("文書構造を終わらせる綴りの持ち込み", () => {
  const SRC = "\\section{Method}\nWe propose a new estimator that addresses this gap directly and we evaluate it on several benchmarks.";
  const JA = "\\section{提案手法}\n本節では、この隔たりに直接取り組む新しい推定量を提案し、複数のベンチマークで評価する。";

  it.each(["\\end{document}", "\\begin{document}", "\\endinput", "\\iffalse"])(
    "%s を持ち込んだ訳文を落とす",
    (tok) => {
      // LaTeX は \\end{document} 以降を無視するのでビルドは正常終了する。実測で
      // exit 0 / buildOk true のまま PDF に最初の節しか出なかった。
      const issues = formalCheck(SRC, JA + tok, []);
      expect(issues.map((i) => i.kind)).toContain("structure");
    },
  );

  it("原文にもとからある構造コマンドは翻訳者の持ち込みではない", () => {
    expect(
      formalCheck(`${SRC}\\iffalse`, `${JA}\\iffalse`, []).filter((i) => i.kind === "structure"),
    ).toEqual([]);
  });

  it("コメント内の綴りは持ち込みとみなさない", () => {
    expect(
      formalCheck(SRC, `${JA}\n% \\end{document} と書いた行`, []).filter((i) => i.kind === "structure"),
    ).toEqual([]);
  });
});

describe("見出し走査のコスト", () => {
  it("見出し引数に閉じない \\[ を詰めても線形", () => {
    // 実測 250KiB で 4,157ms（倍化ごとに 4 倍）だった経路。
    const ja = `\\section{${"\\[".repeat(Math.floor((4 * 1024 * 1024) / 2))}}`;
    const started = Date.now();
    untranslatedHeadings(ja, []);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("数式の中身の照合", () => {
  const SRC = "有意差は $\\alpha < 0.05$ である。損失は \\[ L = \\sum_i (y_i)^2 \\] とする。";

  it.each([
    ["不等号の反転", "有意差は $\\alpha > 0.95$ である。損失は \\[ L = \\sum_i (y_i)^2 \\] とする。"],
    ["演算子の置換", "有意差は $\\alpha < 0.05$ である。損失は \\[ L = \\prod_i (y_i)^2 \\] とする。"],
    ["指数の改竄", "有意差は $\\alpha < 0.05$ である。損失は \\[ L = \\sum_i (y_i)^{99} \\] とする。"],
  ])("%s を検出する", (_label, ja) => {
    // 個数だけを数えていた頃はどれも [] だった。学術論文の翻訳では数式は原文の
    // まま持ち越すのが正しいので、決定的に照合できる情報を捨てていた。
    expect(formalCheck(SRC, ja, []).map((i) => i.kind)).toContain("math");
  });

  it("数式をそのまま持ち越した訳は通す", () => {
    expect(formalCheck(SRC, SRC, []).filter((i) => i.kind === "math")).toEqual([]);
  });

  it("空白・間隔マクロの差だけなら通す", () => {
    const ja = "有意差は $\\alpha< 0.05$ である。損失は \\[L = \\sum_i (y_i)^2\\] とする。";
    expect(formalCheck(SRC, ja, []).filter((i) => i.kind === "math")).toEqual([]);
  });

  it("数式内の地の文（\\text）は訳してよい", () => {
    expect(
      formalCheck("$x \\text{ if } y$ です", "$x \\text{ もし } y$ である", []).filter(
        (i) => i.kind === "math",
      ),
    ).toEqual([]);
  });
});

describe("数式区間の切り出しが正規の論文を落とさない", () => {
  const kinds = (src: string, ja: string) => formalCheck(src, ja, []).map((i) => i.kind);

  it("\\\\[2pt]（行送りの間隔指定）を表示数式と誤読しない", () => {
    const body = (br: string) =>
      `\\begin{tabular}{ll} a & b ${br} c & d \\end{tabular}\nLOCALE 損失は \\[ L = \\sum_i x_i \\] とする。`;
    expect(kinds(body("\\\\[2pt]"), body("\\\\[2pt]"))).toEqual([]);
  });

  it("コード片の生の $ で数式のペアリングがずれない", () => {
    const lst = "\\begin{lstlisting}\nexport PYTHONPATH=$HOME/repo\n\\end{lstlisting}\n";
    const src = `${lst}We evaluate the model. 精度は $p$ である。`;
    const ja = `${lst}モデルを評価する。精度は $p$ である。`;
    expect(kinds(src, ja)).toEqual([]);
  });

  it("数式の改竄は引き続き捕まえる", () => {
    const src = "有意差は $\\alpha < 0.05$ である。";
    expect(kinds(src, "有意差は $\\alpha > 0.95$ である。")).toContain("math");
  });
});

describe("untranslated は不可視引数で無効化できない・表で誤発火しない", () => {
  const untr = (s: string, j: string) =>
    formalCheck(s, j, []).filter((i) => i.kind === "untranslated").length;

  const english = Array.from(
    { length: 12 },
    (_, i) => `The proposed method improves accuracy over prior baselines in section ${String(i)}.`,
  ).join(" ");

  it("\\index{ひらがな} で日本語を水増ししても未訳のまま検出する", () => {
    for (const pad of [40, 52, 80, 200]) {
      expect(untr(english, `${english}\\index{${"あ".repeat(pad)}}`)).toBeGreaterThan(0);
    }
  });

  it("\\newcommand / \\hypersetup の中身も地の文と数えない", () => {
    expect(untr(english, `${english}\\newcommand{\\zz}{${"あ".repeat(200)}}`)).toBeGreaterThan(0);
    expect(
      untr(english, `${english}\\hypersetup{pdfkeywords={${"あ".repeat(200)}}}`),
    ).toBeGreaterThan(0);
  });

  it("表が主体の節を落とさない（表の中身は訳さないのが正しい）", () => {
    const table = (rows: number) =>
      [
        "\\begin{table}\\caption{CAP}\\begin{tabular}{lll}",
        "Method & Dataset & Accuracy \\\\",
        ...Array.from({ length: rows }, (_, i) => `BERT-base ${String(i)} & SQuAD & 88.5 \\\\`),
        "\\end{tabular}\\end{table}",
      ].join("\n");
    for (const rows of [3, 8, 20, 40]) {
      const s = `\\section{Results}\nWe compare the proposed method against strong baselines on standard benchmarks and report accuracy.\n${table(rows)}`;
      const j = `\\section{結果}\n提案手法を標準的なベンチマーク上で強力なベースラインと比較し、精度を報告する。\n${table(rows).replace("CAP", "キャプション")}`;
      expect(untr(s, j)).toBe(0);
    }
  });
});
