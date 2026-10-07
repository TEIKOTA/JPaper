import { describe, it, expect } from "vitest";
import {
  extractTitle,
  findBodyTitle,
  locateBodyTitle,
  placeBodyTitle,
  findTitleArg,
  hasProse,
  replaceTitle,
  titleSegment,
  translatedTitle,
  composeTitle,
  stripTexComments,
  TITLE_SEGMENT_ID,
} from "./paper-title.js";
import { assembleWithMap } from "./assemble-latex.js";
import { formalCheck } from "../workflows/quality-gate.js";
import type { ResolvedTerm } from "../types/contract.js";

const pre = (...lines: string[]): string => ["\\documentclass{article}", ...lines, ""].join("\n");

describe("extractTitle", () => {
  it("前文の \\title の中身を返す", () => {
    expect(extractTitle(pre("\\title{Failing Loudly: An Empirical Study}"))).toEqual({
      text: "Failing Loudly: An Empirical Study",
      notes: [],
    });
  });

  it("短縮タイトル [..] を飛ばして本題を取る（[] の中の波括弧・] も読み飛ばす）", () => {
    expect(extractTitle(pre("\\title[Short {A]B}]{Long Title}"))?.text).toBe("Long Title");
    expect(extractTitle(pre("\\title [Short]\n  {Long Title}"))?.text).toBe("Long Title");
  });

  it("入れ子の波括弧・エスケープした波括弧を含む本題を最後まで読む", () => {
    expect(extractTitle(pre("\\title{A {B \\textbf{C}} \\{D\\} E}"))?.text).toBe(
      "A {B \\textbf{C}} \\{D\\} E",
    );
  });

  it("コメント内の \\title と、本題内のコメント（閉じ括弧を含む）を無視する", () => {
    const p = pre(
      "% \\title{Old Title}",
      "\\title{Real % comment with }",
      "   Title 100\\% sure}",
    );
    expect(extractTitle(p)?.text).toBe("Real Title 100\\% sure");
  });

  it("% で改行を食わせた綴りは TeX と同じくつなげる", () => {
    expect(extractTitle(pre("\\title{Data%", "  set Shift}"))?.text).toBe("Dataset Shift");
  });

  it("\\title が無い・空・\\thanks だけなら undefined", () => {
    expect(extractTitle(pre("\\author{A}"))).toBeUndefined();
    expect(extractTitle(pre("\\title{}"))).toBeUndefined();
    expect(extractTitle(pre("\\title{  % none", "}"))).toBeUndefined();
    expect(extractTitle(pre("\\title{\\thanks{Funded by X}}"))).toBeUndefined();
    expect(extractTitle("")).toBeUndefined();
  });

  it("別の綴り（\\titlerunning・\\maketitle・\\\\ に続く語）や定義中の \\title は拾わない", () => {
    expect(extractTitle(pre("\\titlerunning{Short}"))).toBeUndefined();
    expect(extractTitle(pre("\\renewcommand{\\title}[1]{}"))).toBeUndefined();
    expect(extractTitle(pre("a\\\\title{x}"))).toBeUndefined();
  });

  it("定義命令の直後の \\title（波括弧なし・* 付き・\\let の左辺）は拾わない", () => {
    const p = pre(
      "\\title{Real}",
      "\\let\\oldtitle\\title\\renewcommand\\title[1]{\\oldtitle{#1}}",
    );
    expect(extractTitle(p)?.text).toBe("Real");
    expect(replaceTitle(p, "訳題")).toBe(p.replace("{Real}", "{訳題}"));
    expect(extractTitle(pre("\\newcommand*\\title[1]{X}"))).toBeUndefined();
    expect(extractTitle(pre("\\providecommand % c", "  \\title[2][a]{X}"))).toBeUndefined();
    expect(extractTitle(pre("\\DeclareRobustCommand\\title{X}"))).toBeUndefined();
    expect(extractTitle(pre("\\let\\title={X}"))).toBeUndefined();
    // 定義命令の後でも、直後でなければ拾う。
    expect(extractTitle(pre("\\def\\x{y}\\title{Kept}"))?.text).toBe("Kept");
  });

  it("複数あれば最後の \\title を取る", () => {
    expect(extractTitle(pre("\\title{First}", "\\title{Second}"))?.text).toBe("Second");
  });

  it("\\iffalse の偽の枝・comment 環境の中の \\title は拾わない（AAAI 型の例示ブロック）", () => {
    const aaai = pre(
      "\\title{Real Title}",
      "\\iffalse",
      "\\title{My Publication Title --- Single Author}",
      "\\author{Author Name}",
      "\\fi",
      "\\iffalse",
      "\\title{My Publication Title --- Multiple Authors}",
      "\\fi",
    );
    expect(extractTitle(aaai)?.text).toBe("Real Title");
    expect(replaceTitle(aaai, "訳題")).toBe(aaai.replace("{Real Title}", "{訳題}"));
    expect(
      extractTitle(pre("\\title{Real}", "\\begin{comment}", "\\title{Old draft}", "\\end{comment}"))
        ?.text,
    ).toBe("Real");
    // 偽の枝だけなら absent。
    expect(extractTitle(pre("\\iffalse \\title{Old} \\fi"))).toBeUndefined();
    expect(extractTitle(pre("\\begin {comment}\\title{Old}\\end{comment}"))).toBeUndefined();
  });

  it("\\iffalse は入れ子の条件分岐（\\newif の綴りを含む）を数え、\\else 以降は有効として読む", () => {
    expect(
      extractTitle(
        pre(
          "\\newif\\ifanon",
          "\\iffalse \\ifanon \\fi \\ifx\\a\\b \\fi \\title{Old} \\fi",
          "\\title{Real}",
        ),
      )?.text,
    ).toBe("Real");
    expect(extractTitle(pre("\\iffalse \\title{Old} \\else \\title{Real} \\fi"))?.text).toBe(
      "Real",
    );
    expect(extractTitle(pre("\\title{Real}", "\\iffalse % \\fi", "\\title{Old} \\fi"))?.text).toBe(
      "Real",
    );
    // \begin{comment} 以外の環境・\iftrue は読み飛ばさない。
    expect(extractTitle(pre("\\begin{center}\\title{Kept}\\end{center}"))?.text).toBe("Kept");
    expect(extractTitle(pre("\\iftrue \\title{Kept} \\fi"))?.text).toBe("Kept");
  });

  it("閉じない \\iffalse・\\begin{comment} の羅列でも線形時間で終わる", () => {
    const t0 = Date.now();
    expect(extractTitle("\\iffalse".repeat(150_000))).toBeUndefined();
    expect(extractTitle("\\begin{comment}".repeat(150_000))).toBeUndefined();
    expect(
      extractTitle("\\newif\\ifa".repeat(50_000) + "\\iffalse" + "\\ifa".repeat(50_000)),
    ).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("\\thanks・\\footnote は翻訳対象から外し原文の綴りのまま保持する。\\\\ は本文に残す", () => {
    const t = extractTitle(
      pre("\\title{Failing Loudly:\\\\ An Empirical Study\\thanks{Work {done} at X.}\\footnote[2]{Y}}"),
    );
    expect(t).toEqual({
      text: "Failing Loudly:\\\\ An Empirical Study",
      notes: ["\\thanks{Work {done} at X.}", "\\footnote[2]{Y}"],
    });
  });

  it("閉じない \\title[ / \\title{ の羅列でも線形時間で終わる", () => {
    const t0 = Date.now();
    expect(extractTitle("\\title[".repeat(150_000))).toBeUndefined();
    expect(extractTitle("\\title{".repeat(150_000))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("stripTexComments", () => {
  it("\\% はコメントにしない", () => {
    expect(stripTexComments("a \\% b % c\n  d")).toBe("a \\% b d");
  });
});

describe("hasProse", () => {
  it("マクロ参照・記号だけなら false、地の文・数字があれば true", () => {
    expect(hasProse("\\papertitle")).toBe(false);
    expect(hasProse("{\\papertitle}\\\\ \\& \\%")).toBe(false);
    expect(hasProse("\\papertitle: A Study")).toBe(true);
    expect(hasProse("\\textsc{Bert}")).toBe(true);
    expect(hasProse("$\\alpha$-2")).toBe(true);
    expect(hasProse("深層学習")).toBe(true);
  });
});

describe("titleSegment / translatedTitle / composeTitle", () => {
  it("\\title{..} で包んだ 1 節にする", () => {
    const seg = titleSegment({ text: "A Study", notes: [] });
    expect(seg.id).toBe(TITLE_SEGMENT_ID);
    expect(seg.latex).toBe("\\title{A Study}");
    expect(seg.tokens).toBeGreaterThan(0);
    expect(seg.askPdfName).toBe(true);
  });

  it("訳文の \\title の中身を取り出す。無い・空なら undefined", () => {
    expect(translatedTitle("\\title{大声で失敗する：実証研究}")).toBe("大声で失敗する：実証研究");
    expect(translatedTitle("\\title{\n  深い  学習\n}")).toBe("深い 学習");
    expect(translatedTitle("大声で失敗する")).toBeUndefined();
    expect(translatedTitle("\\title{ }")).toBeUndefined();
  });

  it("外した \\thanks / \\footnote を訳の末尾へ戻す", () => {
    expect(composeTitle("訳題", { text: "T", notes: ["\\thanks{X}", "\\footnote{Y}"] })).toBe(
      "訳題\\thanks{X}\\footnote{Y}",
    );
  });
});

describe("replaceTitle", () => {
  it("最後の \\title の本題だけを差し替え、短縮タイトルと他の行は残す", () => {
    const p = pre("\\title[Short]{Long % c\n Title}", "\\author{A}");
    const out = replaceTitle(p, "訳題");
    expect(out).toBe(pre("\\title[Short]{訳題}", "\\author{A}"));
  });

  it("\\title が無ければそのまま", () => {
    const p = pre("\\author{A}");
    expect(replaceTitle(p, "訳題")).toBe(p);
  });
});

describe("assembleWithMap: タイトルの差し替え", () => {
  const CLEAN = [
    "\\documentclass{article}",
    "\\title{Attention Is All You Need\\thanks{x}}",
    "\\author{A}",
    "\\begin{document}",
    "\\maketitle",
    "\\section{Intro} X",
    "\\end{document}",
  ].join("\n");
  const segments = [{ id: "seg-0000", tex: "\\maketitle\n\\section{序論} X" }];

  it("original: 原前文の \\title の中身だけが訳に置き換わる", () => {
    const r = assembleWithMap({ cleanLatex: CLEAN, segments, mode: "original", title: "訳題\\thanks{x}" });
    expect(r.mainTex).toContain("\\title{訳題\\thanks{x}}");
    expect(r.mainTex).not.toContain("Attention Is All You Need");
    expect(r.mainTex).toContain("\\author{A}");
    expect(r.mainTex).toContain("\\documentclass{article}");
  });

  it("template: 引き継いだ原前文の \\title が訳に置き換わる（テンプレ既定の \\title{} より後）", () => {
    const r = assembleWithMap({ cleanLatex: CLEAN, segments, mode: "template", title: "訳題" });
    expect(r.mainTex).not.toContain("Attention Is All You Need");
    expect(r.mainTex.indexOf("\\title{訳題}")).toBeGreaterThan(r.mainTex.indexOf("\\title{}"));
  });

  it("title 未指定なら原題のまま", () => {
    const r = assembleWithMap({ cleanLatex: CLEAN, segments, mode: "original" });
    expect(r.mainTex).toContain("\\title{Attention Is All You Need\\thanks{x}}");
  });

  it("差し替えで前文の行数が変わっても sourceMap は組み上がった main.tex の行を指す", () => {
    const multi = CLEAN.replace("\\title{", "\\title{\n\n");
    const r = assembleWithMap({ cleanLatex: multi, segments, mode: "original", title: "訳題" });
    const lines = r.mainTex.split("\n");
    expect(lines[r.sourceMap[0]!.startLine - 1]).toBe("\\maketitle");
  });
});

// 1 行のタイトルで形式検査が誤発火しないこと（調整不要の確認）。契約付録 §8
describe("formalCheck: タイトル 1 行", () => {
  const check = (src: string, ja: string, terms: ResolvedTerm[] = []) =>
    formalCheck(titleSegment({ text: src, notes: [] }).latex, `\\title{${ja}}`, terms);
  const term = (over: Partial<ResolvedTerm>): ResolvedTerm => ({
    src: "Transformer",
    form: "Transformer",
    class: "proper-noun",
    rendering: "keep-original",
    firstOccurrence: false,
    ...over,
  });

  it("短いタイトル（地の文 12 語未満）", () => {
    expect(
      check(
        "Failing Loudly: An Empirical Study of Methods for Detecting Dataset Shift",
        "大声で失敗する：データセットシフト検出手法の実証研究",
      ),
    ).toEqual([]);
  });

  it("長いタイトル（地の文 12 語以上）で未翻訳検査が誤発火しない", () => {
    expect(
      check(
        "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding and Generation with Very Large Unlabeled Corpora",
        "BERT：大規模なラベルなしコーパスを用いた言語理解と生成のための深層双方向Transformerの事前学習",
      ),
    ).toEqual([]);
  });

  it("\\\\ 改行・数式・keep-original 語を保てば通り、\\\\ を落とすと落ちる", () => {
    const src = "Attention Is All You Need:\\\\ Scaling $O(n^2)$ Transformer Models";
    const ok = "必要なのはアテンションだけ：\\\\ $O(n^2)$ の Transformer モデルの拡張";
    expect(check(src, ok, [term({})])).toEqual([]);
    const kinds = check(src, ok.replace("\\\\", ""), [term({})]).map((i) => i.kind);
    expect(kinds).toContain("symbol-command");
  });

  it("bilingual 語は firstOccurrence=false で渡すので、タイトルでは日本語だけで通る", () => {
    const t = term({ src: "Value", form: "値(Value)", class: "established", rendering: "bilingual" });
    expect(check("Value Estimation", "値の推定", [t])).toEqual([]);
    expect(check("Value Estimation", "値(Value)の推定", [t]).map((i) => i.kind)).toEqual(["bilingual"]);
  });
});

describe("findBodyTitle（本文中の \\title。契約付録 §8）", () => {
  const segs = (...latex: string[]) => latex.map((l, i) => ({ id: `seg-${String(i)}`, latex: l }));

  it("最初の \\maketitle より前の最後の \\title を、命令全体の範囲つきで返す", () => {
    const s0 = "\n\\title{Old}\n\\title{\\textbf{Towards Robust Models}}\n\\author{A}\n";
    const s1 = "\\begin{abstract}x\\end{abstract}\n\\maketitle\n\\title{After}\n";
    const t = findBodyTitle(segs(s0, s1));
    expect(t?.segmentId).toBe("seg-0");
    expect(s0.slice(t!.start, t!.end)).toBe("\\title{\\textbf{Towards Robust Models}}");
    expect(t?.title?.text).toBe("\\textbf{Towards Robust Models}");
  });

  it("\\maketitle と同じ節にある \\title も拾い、後ろの \\title は無視する", () => {
    const s0 = "\\title[S]{Real}\\maketitle\\title{Later}";
    const t = findBodyTitle(segs(s0));
    expect(s0.slice(t!.start, t!.end)).toBe("\\title[S]{Real}");
  });

  it("\\end{frontmatter} もタイトルを組む位置として扱う（elsarticle）", () => {
    const t = findBodyTitle(segs("\\begin{frontmatter}\\title{Els}\\end{frontmatter}\\title{No}"));
    expect(t?.title?.text).toBe("Els");
  });

  it("組む位置が本文に無い・\\title が \\maketitle の後ろだけ・コメント内なら undefined", () => {
    expect(findBodyTitle(segs("\\title{X}\nbody"))).toBeUndefined();
    expect(findBodyTitle(segs("\\maketitle\n\\title{X}"))).toBeUndefined();
    expect(findBodyTitle(segs("% \\title{X}\n\\maketitle"))).toBeUndefined();
    expect(findBodyTitle(segs("\\title{X}\n% \\maketitle\n", "\\maketitle"))?.segmentId).toBe("seg-0");
  });

  it("中身が空なら title は undefined", () => {
    expect(findBodyTitle(segs("\\title{}\\maketitle"))?.title).toBeUndefined();
  });
});

describe("locateBodyTitle / placeBodyTitle", () => {
  const latex = "\\title{\\textbf{Towards X}\\thanks{F}}\n\\author{A}\n\\maketitle";
  const source = { latex, start: 0, end: "\\title{\\textbf{Towards X}\\thanks{F}}".length };

  it("訳文に残った原文どおりの命令の本題だけを差し替える", () => {
    const ja = "\\title{\\textbf{Towards X}\\thanks{F}}\n\\author{A}\n\\maketitle";
    expect(placeBodyTitle(ja, source, "\\textbf{Xに向けて}\\thanks{F}")).toBe(
      "\\title{\\textbf{Xに向けて}\\thanks{F}}\n\\author{A}\n\\maketitle",
    );
    expect(locateBodyTitle(`前置き${ja}`, source)).toEqual({ start: 3, end: 3 + source.end });
  });

  it("命令が訳文に無ければ undefined", () => {
    expect(placeBodyTitle("\\title{Xに向けて}\\maketitle", source, "訳")).toBeUndefined();
  });

  it("同じ綴りが複数あれば原文と同じ順番のものを差し替える", () => {
    const twice = "\\title{A}\n\\title{A}\\maketitle";
    const src = { latex: twice, start: 10, end: 19 };
    expect(placeBodyTitle(twice, src, "訳")).toBe("\\title{A}\n\\title{訳}\\maketitle");
  });
});
