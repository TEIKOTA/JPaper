import { describe, it, expect } from "vitest";
import { budgetMs, fastestMs } from "../testing/timing.js";
import { commandSpans, dollarSpans, maskChars, MAX_OPTIONAL_ARG, mathSpans, removeSpans, spansOf, verbatimSpans } from "./tex-spans.js";

const slice = (tex: string) => (s: [number, number]) => tex.slice(s[0], s[1]);

describe("spansOf のエスケープ判定", () => {
  it("\\\\[2pt]（行送りの間隔指定）を表示数式の開始と読まない", () => {
    const tex = "a & b \\\\[2pt] c & d \\[ L = x \\] end";
    expect(spansOf(tex, "\\[", "\\]").map(slice(tex))).toEqual(["\\[ L = x \\]"]);
  });

  it("\\\\\\[（\\\\ の後の本物の \\[）は数式として拾う", () => {
    const tex = "a \\\\\\[ x \\] b";
    expect(spansOf(tex, "\\[", "\\]").map(slice(tex))).toEqual(["\\[ x \\]"]);
  });

  it("閉じ側の \\\\] も同じ規則で判定する", () => {
    const tex = "\\[ x \\\\] y \\] z";
    expect(spansOf(tex, "\\[", "\\]").map(slice(tex))).toEqual(["\\[ x \\\\] y \\]"]);
  });
});

describe("dollarSpans の fail-closed", () => {
  it("閉じない $ は末尾までを数式とみなす（以降を素通しにしない）", () => {
    const tex = "text $x$ more $unclosed here";
    const spans = dollarSpans(tex);
    expect(spans.map(slice(tex))).toEqual(["$x$", "$unclosed here"]);
    expect(spans.at(-1)![1]).toBe(tex.length);
  });

  it("\\$ は区切りでない", () => {
    const tex = "価格は \\$5 です。$x$ も。";
    expect(dollarSpans(tex).map(slice(tex))).toEqual(["$x$"]);
  });
});

describe("verbatimSpans", () => {
  it("lstlisting の中を区間として返す", () => {
    const tex = "a\\begin{lstlisting}\necho $HOME\n\\end{lstlisting}b";
    expect(verbatimSpans(tex).map(slice(tex))).toEqual([
      "\\begin{lstlisting}\necho $HOME\n\\end{lstlisting}",
    ]);
  });

  it("\\verb|…| と \\lstinline{…} を区間として返す", () => {
    const tex = "\\verb|$x$| と \\lstinline{$y$}";
    expect(verbatimSpans(tex).map(slice(tex))).toEqual(["\\verb|$x$|", "\\lstinline{$y$}"]);
  });

  it("\\mintinline は言語引数を区切り文字と取り違えない", () => {
    for (const tex of [
      "A \\mintinline{sh}{echo $HOME} B",
      "A \\mintinline{sh}|echo $HOME| B",
      "A \\mintinline[fontsize=\\small]{sh}{echo $HOME} B",
    ]) {
      const [span] = verbatimSpans(tex).map(slice(tex));
      expect(span).toContain("echo $HOME");
    }
  });

  it("\\verbatiminput を \\verb の接頭辞として拾わない", () => {
    expect(verbatimSpans("A \\verbatiminput{data.txt} B")).toEqual([]);
  });
});

describe("maskChars は UTF-16 の単位で伏せる", () => {
  it("4 バイト文字があっても長さと後ろの添字が変わらない", () => {
    const tex = "\\verb|𝑥| $y$";
    const masked = maskChars(tex, verbatimSpans(tex));
    expect(masked.length).toBe(tex.length);
    expect(masked.indexOf("$y$")).toBe(tex.indexOf("$y$"));
    expect(mathSpans(tex).map(slice(tex))).toEqual(["$y$"]);
  });
});

describe("verbatimSpans は verbatim の中身と引数の中の候補を命令と読まない", () => {
  it("\\verb の中の \\lstinline{ で後ろの本文を伏せない", () => {
    const tex = "\\verb|\\lstinline{| $a$ and $b$";
    expect(mathSpans(tex).map(slice(tex))).toEqual(["$a$", "$b$"]);
  });
  it("[..] の中の \\mintinline を読まない", () => {
    const tex = "\\mintinline[\\mintinline{py}{$x$}]{";
    expect(verbatimSpans(tex)).toEqual([]);
  });
});

describe("mathSpans は verbatim の中の $ に釣られない", () => {
  it("コード片の生の $ でペアリングがずれない", () => {
    const tex = "\\begin{lstlisting}\necho $HOME\n\\end{lstlisting}\n本文。数式は $x$ である。";
    expect(mathSpans(tex).map(slice(tex))).toEqual(["$x$"]);
  });

  it("verbatim を挟んでも数式環境を正しく拾う", () => {
    const tex = "\\verb|$| \\begin{equation} E = mc^2 \\end{equation}";
    expect(mathSpans(tex, ["equation"]).map(slice(tex))).toEqual([
      "\\begin{equation} E = mc^2 \\end{equation}",
    ]);
  });
});

// このモジュールは「二次を 1 箇所に集約して潰す」ために作った。意味論だけを縛ると、
// 集約したはずの二次が新しい実装で戻ってくる（実測: #196 で入れた \verb 系の区切り
// 探索が閉じない \lstinline{ の羅列で二次になり、2.2MB で 99 秒・exit 0 を返した）。
describe("commandSpans（命令と引数）", () => {
  const pick = (tex: string, name: string) => commandSpans(tex, name).map(([s, e]) => tex.slice(s, e));

  it("任意引数と入れ子の波括弧を含めて 1 区間にする", () => {
    const tex = "x \\author[1]{A \\thanks{B}\\\\ C {\\it D}} y";
    expect(pick(tex, "author")).toEqual(["\\author[1]{A \\thanks{B}\\\\ C {\\it D}}"]);
  });

  it("エスケープした波括弧は数えない。英字が続く別命令とエスケープされた \\\\author は拾わない", () => {
    expect(pick("\\author{A \\} B} z", "author")).toEqual(["\\author{A \\} B}"]);
    expect(pick("\\authorrunning{A} \\\\author{B}", "author")).toEqual([]);
  });

  it("引数が閉じなければ区間にしない。複数あればすべて拾う", () => {
    expect(pick("\\author{A", "author")).toEqual([]);
    expect(pick("\\author{A}\n\\author {B}", "author")).toEqual(["\\author{A}", "\\author {B}"]);
  });

  it("改行の \\\\ の直後の波括弧は数える。任意引数が上限までに閉じなければ区間にしない", () => {
    expect(pick("\\author{A \\\\{x} B} z", "author")).toEqual(["\\author{A \\\\{x} B}"]);
    const long = `\\author[${"a".repeat(MAX_OPTIONAL_ARG)}]{X}`;
    expect(pick(long, "author")).toEqual([]);
    expect(pick(`\\author[${"a".repeat(MAX_OPTIONAL_ARG - 1)}]{X}`, "author")).toEqual([]);
    const fits = `\\author[${"a".repeat(MAX_OPTIONAL_ARG - 2)}]{X}`;
    expect(pick(fits, "author")).toEqual([fits]);
  });
});

describe("removeSpans（区間を取り除く）", () => {
  it("区切りを挟んで前後の語をつなげない。重なる区間は外側だけ使う", () => {
    const tex = "foo\\author{X}bar";
    expect(removeSpans(tex, commandSpans(tex, "author"), " ")).toBe("foo bar");
    expect(removeSpans("abcdef", [[1, 5], [2, 3]])).toBe("af");
  });
});

describe("走査コストは入力長に対して線形", () => {
  const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

  it.each([
    ["未閉じ \\lstinline{", "\\lstinline{"],
    ["未閉じ \\verb|", "\\verb|"],
    ["未閉じ $", "$x "],
    ["未閉じ \\[", "\\[x "],
    ["未閉じ \\begin{verbatim}", "\\begin{verbatim}"],
  ])("%s の羅列 1MiB を秒未満で走る", (_label, unit) => {
    const body = rep(unit, 1024 * 1024);
    expect(fastestMs(2, () => void mathSpans(body, ["equation"]))).toBeLessThan(budgetMs(1_000));
    expect(fastestMs(2, () => void verbatimSpans(body))).toBeLessThan(budgetMs(1_000));
  });

  it.each([
    ["未閉じ \\author{", "\\author{"],
    ["未閉じ \\author[", "\\author["],
    ["閉じた \\author[x] と未閉じの {", "\\author[x]{"],
  ])("commandSpans: %s の羅列 1MiB を 2 秒未満で走る", (_label, unit) => {
    const body = rep(unit, 1024 * 1024);
    expect(fastestMs(2, () => void commandSpans(body, "author"))).toBeLessThan(budgetMs(2_000));
  });

  it.each([
    ["遠くで閉じる \\lstinline{", "\\lstinline{", "}"],
    ["遠くで閉じる \\lstinline[", "\\lstinline[", "]|a|"],
    ["遠くで閉じる \\mintinline{", "\\mintinline{", "}|a|"],
    ["閉じない \\lstinline[ と後ろの \\verb", "\\lstinline[ \\verb|a| ", ""],
    ["遠くで閉じる \\lstinline[ と長い空白", "\\lstinline[", "]" + " ".repeat(512 * 1024)],
    ["遠くで閉じる \\mintinline[ と長い空白・閉じない {", "\\mintinline[", "]" + " ".repeat(512 * 1024) + "{"],
    ["遠くで閉じる \\mintinline{ と長い空白", "\\mintinline{", "}" + " ".repeat(512 * 1024)],
  ])("%s の羅列 1MiB を伏せるまで 2 秒未満で走る", (_label, unit, tail) => {
    const body = rep(unit, 1024 * 1024) + tail;
    expect(fastestMs(2, () => void maskChars(body, verbatimSpans(body)))).toBeLessThan(budgetMs(2_000));
  });

  it("verbatim 環境が多くても呼び出し引数の上限で落ちない", () => {
    const body = "\\begin{verbatim}x\\end{verbatim}".repeat(150_000);
    expect(verbatimSpans(body)).toHaveLength(150_000);
  });

  it("倍化しても 4 倍にならない（二次でない）", () => {
    const small = rep("\\lstinline{", 512 * 1024);
    const large = rep("\\lstinline{", 1024 * 1024);
    // 二次なら 4 倍。線形なら 2 倍。閾値は測定ノイズを見込んで 3 倍に置く。
    // 1 回きりの測定だと、基準側が 1ms 未満に丸まったところへ負荷が乗った測定側だけが
    // 伸びて落ちる（実測 152ms vs 基準 146ms）。両側とも最小値を採って比べる。
    // budget-exempt: 測定どうしの比で、時間の閾値ではない
    const t1 = Math.max(1, fastestMs(3, () => void mathSpans(small)));
    // budget-exempt: 測定どうしの比で、時間の閾値ではない
    const t2 = fastestMs(3, () => void mathSpans(large));
    expect(t2).toBeLessThan(t1 * 3 + 50);
  });
});
