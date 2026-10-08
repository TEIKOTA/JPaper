import { describe, it, expect } from "vitest";
import { fastestMs } from "../testing/timing.js";
import { commandSpans, dollarSpans, mathSpans, spansOf, verbatimSpans } from "./tex-spans.js";

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
    expect(fastestMs(2, () => void mathSpans(body, ["equation"]))).toBeLessThan(1_000);
    expect(fastestMs(2, () => void verbatimSpans(body))).toBeLessThan(1_000);
  });

  it("倍化しても 4 倍にならない（二次でない）", () => {
    const small = rep("\\lstinline{", 512 * 1024);
    const large = rep("\\lstinline{", 1024 * 1024);
    // 二次なら 4 倍。線形なら 2 倍。閾値は測定ノイズを見込んで 3 倍に置く。
    // 1 回きりの測定だと、基準側が 1ms 未満に丸まったところへ負荷が乗った測定側だけが
    // 伸びて落ちる（実測 152ms vs 基準 146ms）。両側とも最小値を採って比べる。
    const t1 = Math.max(1, fastestMs(3, () => void mathSpans(small)));
    const t2 = fastestMs(3, () => void mathSpans(large));
    expect(t2).toBeLessThan(t1 * 3 + 50);
  });
});
