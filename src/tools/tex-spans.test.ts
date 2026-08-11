import { describe, it, expect } from "vitest";
import { dollarSpans, mathSpans, spansOf, verbatimSpans } from "./tex-spans.js";

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
