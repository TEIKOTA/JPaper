import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProfile } from "./frontmatter.js";
import { assembleBilingual, renderPairs } from "./bilingual-latex.js";

// 段落の境目の条件分岐（issue #378・契約付録 §8）を、renderPairs の出力と修正前の組み立て（段落ごと左右に置く）の
// 両方で pdflatex と paracol の最小文書に組み、組めたか・どの行がどの段で実行されたかを比べる。
// pdflatex と paracol.sty が無い環境では飛ばす。

const hasTex =
  spawnSync("pdflatex", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("kpsewhich", ["paracol.sty"], { encoding: "utf8" }).stdout.trim() !== "";

const IOPART = detectProfile("\\documentclass{iopart}\n\\begin{document}\n\\end{document}");

type Pair = { left: string; right: string };

// 左の段落の L を R に置き換えたものを右の段落にする（\mk{…L} の印だけを左右で変える）。
const mirror = (lefts: string[]): Pair[] =>
  lefts.map((left) => ({ segmentId: "s", left, right: left.replace(/L\}/g, "R}") }));

type Case = {
  name: string;
  pairs: Pair[];
  // renderPairs が修正前と違う組み立て（条件分岐の行を段の外に 1 回だけ置く）にするか。
  split: boolean;
  // 正しい組み立てで実行される印（名前:段。段は 0 が左、1 が右）。
  expected: { false: string[]; true: string[] };
};

const after = ["AfterL:0", "AfterR:1"];

const CASES: Case[] = [
  {
    name: "2607.28007 の前付け（段落をまたぐ \\ifpeerreview / \\else / \\fi）",
    pairs: mirror(["\\ifpeerreview\n\\mk{AnonL}", "\\else", "\\mk{RealL}", "\\fi\n\\mk{TitleL}", "\\mk{AfterL}"]),
    split: true,
    expected: {
      false: ["RealL:0", "RealR:1", "TitleL:0", "TitleR:1", ...after],
      true: ["AnonL:0", "AnonR:1", "TitleL:0", "TitleR:1", ...after],
    },
  },
  {
    name: "2607.28007 の credits（節をまたぐ環境の中の段落をまたぐ条件分岐）",
    pairs: mirror([
      "\\begin{credits}\n\n\\ifpeerreview",
      "\\mk{WithheldL}",
      "\\else",
      "\\mk{FundL}",
      "\\fi\n\\end{credits}",
      "\\mk{AfterL}",
    ]),
    split: true,
    expected: {
      false: ["FundL:0", "FundR:1", ...after],
      true: ["WithheldL:0", "WithheldR:1", ...after],
    },
  },
  {
    name: "段落の中で閉じる \\ifnum\\x>0 の行",
    pairs: mirror(["\\ifnum\\x>0\n\\mk{PosL}\n\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["PosL:0", "PosR:1", ...after] },
  },
  {
    name: "段落をまたぐ \\ifnum\\x>0 の行",
    pairs: mirror(["\\ifnum\\x>0\n\\mk{PosL}", "\\mk{MoreL}\n\\fi\n\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["PosL:0", "PosR:1", "MoreL:0", "MoreR:1", ...after] },
  },
  {
    name: "単独の段落の \\fi",
    pairs: mirror(["\\ifdraft\n\\mk{DraftL}", "\\fi", "\\mk{AfterL}"]),
    split: true,
    expected: { false: after, true: ["DraftL:0", "DraftR:1", ...after] },
  },
  {
    name: "段落をまたぐ \\ifcase と \\or",
    pairs: mirror(["\\ifcase\\x\n\\mk{ZeroL}", "\\or\n\\mk{OneL}", "\\fi\n\\mk{AfterL}"]),
    split: false,
    expected: { false: ["ZeroL:0", "ZeroR:1", ...after], true: ["OneL:0", "OneR:1", ...after] },
  },
  {
    name: "段落をまたぐ条件分岐の中の、1 行で閉じた \\ifx … \\else … \\fi の行",
    pairs: mirror(["\\ifdraft\n\\mk{AL}", "\\ifx\\relax\\relax \\mk{XL}\\else \\mk{YL}\\fi\n\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["AL:0", "AR:1", "XL:0", "XR:1", ...after] },
  },
  {
    name: "{ が続く \\ifdraft{…} の後に \\fi だけの行（2 回目のレビューの blocking）",
    pairs: mirror(["\\mk{IntroL}\n\\ifdraft{\\bfseries\\mk{NoteL}}\n\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: {
      false: ["IntroL:0", "IntroR:1", ...after],
      true: ["IntroL:0", "NoteL:0", "IntroR:1", "NoteR:1", ...after],
    },
  },
  {
    name: "\\ifdraft{…} の段落と段落をまたぐ条件分岐が同じ文書にある",
    pairs: mirror(["\\mk{IntroL}\n\\ifdraft{\\bfseries\\mk{NoteL}}\n\\fi", "\\ifpeerreview\n\\mk{AnonL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: {
      false: ["IntroL:0", "IntroR:1", ...after],
      true: ["IntroL:0", "NoteL:0", "IntroR:1", "NoteR:1", "AnonL:0", "AnonR:1", ...after],
    },
  },
  {
    name: "閉じの \\fi が本文と同じ行にある段落をまたぐ条件分岐",
    pairs: mirror(["\\ifdraft\n\\mk{DraftL}", "\\else\n\\mk{FinalL}\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: ["FinalL:0", "FinalR:1", ...after], true: ["DraftL:0", "DraftR:1", ...after] },
  },
  {
    name: "開きが \\unless\\if… の段落をまたぐ条件分岐",
    pairs: mirror(["\\unless\\ifdraft\n\\mk{AL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: ["AL:0", "AR:1", ...after], true: after },
  },
  {
    name: "段落をまたぐ条件分岐の中の etoolbox の \\ifbool{…}",
    pairs: mirror(["\\ifdraft\n\\mk{AL}", "\\ifbool{flag}{\\mk{BL}}{\\mk{CL}}\n\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["AL:0", "AR:1", "BL:0", "BR:1", ...after] },
  },
  {
    name: "\\if… の行に本文が続く段落をまたぐ条件分岐",
    pairs: mirror(["\\ifdraft \\mk{DraftL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["DraftL:0", "DraftR:1", ...after] },
  },
  {
    name: "比較の対象の後に空白と命令が続く \\ifnum の行（3 回目のレビューの blocking）",
    pairs: mirror(["\\ifnum\\x>0 \\mk{Shared}\n\\mk{PosL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: after, true: ["Shared:0", "PosL:0", "Shared:1", "PosR:1", ...after] },
  },
  {
    name: "比較の対象が次の行に続く \\ifx の行（4 回目のレビューの blocking）",
    pairs: mirror(["\\ifx\\nodef\n\\undefined \\mk{PosL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: ["PosL:0", "PosR:1", ...after], true: ["PosL:0", "PosR:1", ...after] },
  },
  {
    name: "比較の対象の後に空白を挟まず命令が続く \\ifx の行",
    pairs: mirror(["\\ifx\\relax\\relax\\mk{Shared}\n\\mk{PosL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: {
      false: ["Shared:0", "PosL:0", "Shared:1", "PosR:1", ...after],
      true: ["Shared:0", "PosL:0", "Shared:1", "PosR:1", ...after],
    },
  },
  {
    name: "状況で真偽が変わる \\ifhmode の段落をまたぐ条件分岐（5 回目のレビューの blocking）",
    pairs: mirror(["Text\n\\ifhmode\n\\mk{HL}", "\\mk{GL}\n\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: {
      false: ["HL:0", "HR:1", "GL:0", "GR:1", ...after],
      true: ["HL:0", "HR:1", "GL:0", "GR:1", ...after],
    },
  },
  {
    name: "前の行の \\unless が次の行の \\ifdraft を取る（5 回目のレビューの blocking）",
    pairs: mirror(["Intro\n\\unless\n\\ifdraft\n\\mk{XL}", "\\fi", "\\mk{AfterL}"]),
    split: false,
    expected: { false: ["XL:0", "XR:1", ...after], true: after },
  },
  {
    name: "開きがマクロに隠れた条件分岐と、それだけの行の条件分岐が混ざる（5 回目のレビュー）",
    pairs: [
      { left: "\\def\\begindraft{\\ifdraft}\\def\\enddraft{\\fi}", right: "\\def\\begindraft{\\ifdraft}\\def\\enddraft{\\fi}" },
      { left: "\\ifdraft\n\\mk{AL}\n\\enddraft", right: "\\ifdraft\n\\mk{AR}\n\\enddraft" },
      { left: "\\begindraft\n\\mk{BL}\n\\fi", right: "\\begindraft\n\\mk{BR}\n\\fi" },
      { left: "\\mk{AfterL}", right: "\\mk{AfterR}" },
    ],
    split: false,
    expected: { false: after, true: ["AL:0", "AR:1", "BL:0", "BR:1", ...after] },
  },
  {
    name: "左右で条件分岐の行が違う段落",
    pairs: [
      { left: "\\ifdraft\n\\mk{DraftL}", right: "\\ifdraft \\mk{DraftR}" },
      { left: "\\fi", right: "\\fi" },
      { left: "\\mk{AfterL}", right: "\\mk{AfterR}" },
    ],
    split: false,
    expected: { false: after, true: ["DraftL:0", "DraftR:1", ...after] },
  },
];

function documentOf(body: string, truth: boolean): string {
  const t = truth ? "true" : "false";
  return [
    "\\documentclass{article}",
    "\\usepackage{paracol}",
    "\\usepackage{etoolbox}",
    "\\makeatletter",
    "\\newcommand\\mk[1]{\\typeout{JPMARK #1:\\number\\pcol@currcol}}",
    "\\makeatother",
    `\\newif\\ifdraft \\draft${t}`,
    `\\newif\\ifpeerreview \\peerreview${t}`,
    `\\newcount\\x \\x=${truth ? 1 : 0}`,
    `\\newbool{flag} \\setbool{flag}{${t}}`,
    "\\newenvironment{credits}{}{}",
    "\\begin{document}",
    "\\begin{paracol}{2}",
    body,
    "\\end{paracol}",
    "\\end{document}",
    "",
  ].join("\n");
}

type Typeset = { ok: boolean; marks: string[] };

function typeset(dir: string, name: string, tex: string): Promise<Typeset> {
  writeFileSync(path.join(dir, `${name}.tex`), tex);
  return new Promise((resolve) => {
    execFile(
      "pdflatex",
      ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", `${name}.tex`],
      { cwd: dir, timeout: 60_000 },
      (err) => {
        const log = readFileSync(path.join(dir, `${name}.log`), "utf8");
        const marks = [...log.matchAll(/^JPMARK (\S+)$/gm)].map((m) => m[1]!);
        resolve({ ok: err === null, marks });
      },
    );
  });
}

async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  return out;
}

const mainBody = (pairs: Pair[]): string =>
  pairs.map((p) => `${p.left}\n\\switchcolumn\n${p.right}\n\\switchcolumn*`).join("\n\n");
const prBody = (pairs: Pair[]): string =>
  renderPairs(
    pairs.map((p) => ({ segmentId: "s", ...p })),
    { left: "\\newif\\ifdraft\n\\newif\\ifpeerreview", right: "" },
    IOPART,
  ).blocks.join("\n\n");

describe.skipIf(!hasTex)("段落の境目の条件分岐を pdflatex と paracol で組む（issue #378）", () => {
  let dir = "";
  const results = new Map<string, Typeset>();

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "jpaper-cond-"));
    const jobs: (() => Promise<void>)[] = [];
    CASES.forEach((c, i) => {
      for (const truth of [false, true]) {
        for (const [form, body] of [
          ["main", mainBody(c.pairs)],
          ["pr", prBody(c.pairs)],
        ] as const) {
          jobs.push(async () => {
            results.set(`${i}:${truth}:${form}`, await typeset(dir, `c${i}-${truth}-${form}`, documentOf(body, truth)));
          });
        }
      }
    });
    await pool(jobs, 4);
  }, 120_000);

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  CASES.forEach((c, i) => {
    it(c.name, () => {
      expect(prBody(c.pairs) !== mainBody(c.pairs)).toBe(c.split);
      for (const truth of [false, true] as const) {
        const main = results.get(`${i}:${truth}:main`)!;
        const pr = results.get(`${i}:${truth}:pr`)!;
        const expected = c.expected[`${truth}`];
        // 修正前に組めた形は組める。修正前に正しく組めた形は正しく組める。
        if (main.ok) expect(pr.ok, `truth=${truth}`).toBe(true);
        if (main.ok && main.marks.join(" ") === expected.join(" ")) expect(pr.marks, `truth=${truth}`).toEqual(expected);
        // 割る形は、偽・真のどちらの条件でも正しく組める。
        if (c.split) {
          expect(pr.ok, `truth=${truth}`).toBe(true);
          expect(pr.marks, `truth=${truth}`).toEqual(expected);
        }
      }
    });
  });

  it("割る形はどれも、修正前の組み立てでは偽か真のどちらかの条件で正しく組めない", () => {
    CASES.forEach((c, i) => {
      if (!c.split) return;
      const broken = [false, true].some((truth) => {
        const main = results.get(`${i}:${truth}:main`)!;
        return !main.ok || main.marks.join(" ") !== c.expected[`${truth}`].join(" ");
      });
      expect(broken, c.name).toBe(true);
    });
  });
});

// 略語（acronym パッケージ。issue #381）: 右の段の略語を分けた対訳を pdflatex で 3 回組み（略称を省いた \acroplural は 3 回目で定まる）、左右の半分のテキストを比べる。
const hasAcronym = hasTex && spawnSync("kpsewhich", ["acronym.sty"], { encoding: "utf8" }).stdout.trim() !== "";

function runThrice(dir: string, name: string, tex: string): { ok: boolean; log: string } {
  writeFileSync(path.join(dir, `${name}.tex`), tex);
  let ok = true;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", `${name}.tex`], { cwd: dir, timeout: 60_000 });
    ok &&= r.status === 0;
  }
  return { ok, log: readFileSync(path.join(dir, `${name}.log`), "utf8") };
}

const half = (dir: string, name: string, side: "left" | "right"): string =>
  spawnSync("pdftotext", ["-x", side === "left" ? "0" : "306", "-y", "0", "-W", "306", "-H", "792", "-raw", `${name}.pdf`, "-"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.replace(/\s+/g, " ");

describe.skipIf(!hasAcronym)("略語を左右の段で分けて pdflatex で組む（issue #381）", () => {
  it("左の段は原文の定義、右の段は和訳の定義で展開され、前文・本文の \\acrodef と複数形も組める", () => {
    const dir = process.env.JP_ACRO_DIR ?? mkdtempSync(path.join(tmpdir(), "jpaper-acro-"));
    try {
      const preamble = "\\usepackage[nolist]{acronym}\n\\acrodef{PRE}[PRE]{preamble long}";
      const pairs = [
        { segmentId: "s", left: "Left: \\ac{MF}, \\acp{FM}, \\ac[2]{ROI}, \\acp{ROI}, \\ac{PRE}, \\ac{BD}.", right: "Right: \\ac{MF}, \\acp{FM}, \\ac[2]{ROI}, \\acp{ROI}, \\ac{PRE}, \\ac{BD}." },
        { segmentId: "s", left: "\\acrodef{BD}[BD]{body def}", right: "\\acrodef{BD}[BD]{karada}" },
        {
          segmentId: "s",
          left: "\\begin{acronym}\n\\acro{MF}[MF]{mitotic figure}\n\\acro{FM}{foundation model}\n\\acro{ROI}[RoI]{region of interest}\n\\acroplural{ROI}{regions of interest}\n\\end{acronym}",
          right: "\\begin{acronym}\n\\acro{MF}[MF]{yushi}\n\\acro{FM}{kiban}\n\\acro{ROI}[RoI]{kanshin}\n\\acroplural{ROI}{kanshin gun}\n\\end{acronym}",
        },
      ];
      const body = renderPairs(pairs, { left: preamble, right: preamble }, IOPART).blocks.join("\n\n");
      const tex = ["\\documentclass{article}", "\\usepackage[letterpaper]{geometry}", "\\usepackage{paracol}", preamble, "\\begin{document}", "\\begin{paracol}{2}", body, "\\end{paracol}", "\\end{document}", ""].join("\n");
      const r = runThrice(dir, "acro", tex);
      expect(r.ok, r.log.slice(-2000)).toBe(true);
      expect(r.log).not.toMatch(/Undefined control sequence|Acronym .* is not defined/);
      const left = half(dir, "acro", "left");
      const right = half(dir, "acro", "right");
      expect(left).toContain("mitotic figure (MF)");
      expect(left).toContain("foundation models (FMs)");
      expect(left).toContain("region of interest (RoI)");
      expect(left).toContain("body def (BD)");
      expect(left).not.toMatch(/yushi|kiban|kanshin|karada/);
      expect(right).toContain("yushi (MF)");
      expect(right).toContain("kiban (FMs)");
      expect(right).toContain("kanshin (RoI)");
      expect(right).toContain("karada (BD)");
      expect(right).not.toMatch(/mitotic|foundation|region of|body def/);
    } finally {
      if (process.env.JP_ACRO_DIR === undefined) rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// acmart の前付け（issue #499）: acmart の対訳を lualatex で組み、左右の半分（420mm 幅の紙の 595pt ずつ）のテキストを比べる。
const hasAcmart =
  spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("kpsewhich", ["luatexja-preset.sty"], { encoding: "utf8" }).stdout.trim() !== "" &&
  spawnSync("kpsewhich", ["acmart.cls"], { encoding: "utf8" }).stdout.trim() !== "";

const ACM_FRONT = (title: string, inst: string, abs: string, kw: string): string =>
  [
    `\\title{${title}}`,
    "",
    "\\author{Ann Lee}\n\\authornote{Both authors contributed equally.}\n\\affiliation{\\institution{" + inst + "}\\city{Newark}\\state{NJ}\\country{USA}}\n\\email{ann_lee@example.org}",
    "",
    "\\author{Bob Kay}\n\\authornotemark[1]\n\\additionalaffiliation{\\institution{Extra Lab}}\n\\affiliation{\\institution{" + inst + " B}\\city{Austin}\\country{USA}}\n\\email{bob@example.org}",
    "",
    `\\begin{abstract}\n${abs}\n\\end{abstract}`,
    "",
    `\\keywords{${kw}}`,
    "",
    "\\maketitle",
    "",
    "\\section{Intro}",
  ].join("\n");

// 要旨・キーワードを \maketitle の後に書く形。
const ACM_LATE = (title: string, abs: string, kw: string): string =>
  [`\\title{${title}}`, "", "\\author{Ann Lee}", "", "\\maketitle", "", `\\begin{abstract}\n${abs}\n\\end{abstract}`, "", `\\keywords{${kw}}`, "", "\\section{Intro}"].join("\n");

// 左右の前付けで acmart の対訳を組み、1 ページ目の左右の半分のテキストを返す。
function buildAcm(source: string, translated: string): { left: string; right: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-acmbi-"));
  try {
    const pre = "\\documentclass[sigconf]{acmart}\n\\settopmatter{printacmref=false}\n";
    const { mainTex } = assembleBilingual({
      cleanLatex: `${pre}\\begin{document}\n\\end{document}\n`,
      translatedMainTex: `${pre}\\usepackage{luatexja}\n\\begin{document}\n\\end{document}\n`,
      source: [{ id: "seg-0000", tex: source }],
      translated: [{ id: "seg-0000", tex: translated }],
    });
    writeFileSync(path.join(dir, "main.tex"), mainTex);
    const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
    expect(r.status, r.stdout.slice(-3000)).toBe(0);
    const text = (x: string): string =>
      spawnSync("pdftotext", ["-f", "1", "-l", "1", "-x", x, "-y", "0", "-W", "595", "-H", "842", "-raw", "main.pdf", "-"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.replace(/\s+/g, " ");
    return { left: text("0"), right: text("595") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasAcmart)("acmart の論文の対訳を lualatex で組む（issue #499）", () => {
  it("\\maketitle の後に書いた要旨・キーワードは、その段の表題ブロックの後にその場で出る", () => {
    const { left, right } = buildAcm(ACM_LATE("Left Title", "Lateabstract text.", "leftkw"), ACM_LATE("右の表題", "右の遅い要旨。", "右の語"));
    for (const [side, title, head, abs, kw] of [
      [left, "Left Title", "Abstract", "Lateabstract text.", "leftkw"],
      [right, "右の表題", "概要", "右の遅い要旨。", "右の語"],
    ] as const) {
      const at = [title, "Ann Lee", head, abs, kw, "Intro"].map((s) => side.replace(/ /g, "").indexOf(s.replace(/ /g, "")));
      expect(at.every((i) => i >= 0), side).toBe(true);
      expect([...at].sort((a, b) => a - b), side).toEqual(at);
    }
  }, 240_000);

  it("左右の段それぞれの表題ブロックの後に、その段の著者・所属・メールアドレス・要旨・キーワードが出る", () => {
    const { left, right } = buildAcm(
      ACM_FRONT("Left Title", "Left Uni", "Leftabstract text.", "leftkw"),
      ACM_FRONT("右の表題", "Right Uni", "右の要旨の本文。", "右の語"),
    );
    for (const [side, title, inst, abs, kw, head] of [
      [left, "Left Title", "Left Uni", "Leftabstract text.", "leftkw", "Abstract"],
      [right, "右の表題", "Right Uni", "右の要旨の本文。", "右の語", "概要"],
    ] as const) {
      const order = [title, "Ann Lee", inst, "ann_lee@example.org", "Bob Kay", `${inst} B`, "bob@example.org", head, abs, kw, "Intro"];
      const at = order.map((s) => side.replace(/ /g, "").indexOf(s.replace(/ /g, "")));
      expect(at.every((i) => i >= 0), `${side}\n${order.filter((_, k) => at[k]! < 0).join(", ")}`).toBe(true);
      expect([...at].sort((a, b) => a - b), side).toEqual(at);
    }
    // 著者の注は対訳 PDF に出さない（issue #501）。
    expect(`${left} ${right}`).not.toMatch(/contributed equally|Extra Lab/);
    expect(left).not.toMatch(/Right Uni|右の要旨|概要/);
    expect(right).not.toMatch(/Left Uni|Leftabstract|Abstract/);
  }, 240_000);
});

// 著者欄の \and（issue #324・#529）: 対訳のタイトルブロックを lualatex で組み、1 ページ目の左の半分の行を返す。
function buildAuthors(author: string, pre: string = "\\documentclass{article}\n"): { ok: boolean; log: string; lines: string[]; words: { w: string; x0: number; x1: number }[]; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-and-"));
  const body = `\\title{Left Title}\n\n${author}\n\n\\maketitle\n\nIntro text.`;
  const { mainTex } = assembleBilingual({
    cleanLatex: `${pre}\\begin{document}\n\\end{document}\n`,
    translatedMainTex: `${pre}\\usepackage{luatexja}\n\\begin{document}\n\\end{document}\n`,
    source: [{ id: "seg-0000", tex: body }],
    translated: [{ id: "seg-0000", tex: body.replace("Left Title", "右の表題") }],
  });
  writeFileSync(path.join(dir, "main.tex"), mainTex);
  const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
  const text = spawnSync("pdftotext", ["-f", "1", "-l", "1", "-x", "0", "-y", "0", "-W", "595", "-H", "842", "-layout", "main.pdf", "-"], { cwd: dir, encoding: "utf8" }).stdout;
  // 語の左端・右端（左の段の右端と右の段の左端の間の余白に語が掛からないかを見る）。
  const bbox = spawnSync("pdftotext", ["-f", "1", "-l", "1", "-bbox", "main.pdf", "-"], { cwd: dir, encoding: "utf8" }).stdout;
  const words = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g)].map((m) => ({ w: m[3]!, x0: Number(m[1]), x1: Number(m[2]) }));
  return { ok: r.status === 0, log: r.stdout.slice(-3000), lines: text.split("\n"), words, dir };
}

const hasLua = spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0;
const FRONT = readFileSync(new URL("./fixtures/iccv-2107.03315-front.tex", import.meta.url), "utf8");
const ICCV_AUTHOR = FRONT.slice(FRONT.indexOf("\\author"), FRONT.indexOf("\\maketitle")).trim().replace(/\n\s*\n/g, "\n");
// 著者欄の空行は #517 の別の不具合（PR #526）なので、ここでは外して #529 だけを見る。

describe.skipIf(!hasLua)("対訳のタイトルブロックの著者欄の \\and を lualatex で組む（issue #529）", () => {
  it("複数行の著者が \\and で並ぶ著者欄は、著者ごとのまとまりが保たれる（2107.03315）", () => {
    const { ok, log, lines, dir } = buildAuthors(ICCV_AUTHOR);
    try {
      expect(ok, log).toBe(true);
      expect(log).not.toContain("Misplaced");
      // メールの行に次の著者の名前が続かない・名前の行にメールが続かない。
      for (const l of lines.filter((x) => x.includes("@"))) expect(l, l).not.toMatch(/Guillory|Shankar|Ebrahimi|Darrell|Schmidt/);
      for (const l of lines.filter((x) => /Guillory|Shankar|Ebrahimi|Darrell|Schmidt/.test(x))) expect(l, l).not.toContain("@");
      expect(lines.join("\n")).toContain("ludwigschmidt2@gmail.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("1 行の著者が \\and で並ぶ著者欄（issue #324 の形）と、\\and の無い著者欄も組める", () => {
    for (const [author, names, pre] of [
      ["\\author{Ann Lee \\and Bob Kay \\and Cy Poe}", ["Ann Lee", "Bob Kay", "Cy Poe"], undefined],
      ["\\author{Ann Lee, Bob Kay}", ["Ann Lee, Bob Kay"], undefined],
      ["\\author{Ann Lee\\inst{1} \\and Bob Kay\\inst{2}}\\institute{Uni A \\and Uni B}", ["Ann Lee", "Bob Kay"], "\\documentclass{llncs}\n"],
    ] as const) {
      const { ok, log, lines, dir } = buildAuthors(author, pre);
      try {
        expect(ok, log).toBe(true);
        for (const n of names) expect(lines.join("\n").replace(/ +/g, " "), n).toContain(n);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 240_000);

  it("1 行が段の幅より長い著者は、箱の中で折り返して反対の段に重ならない", () => {
    const long = "Department of Computer Science and Engineering, School of Engineering and Applied Sciences, University of Somewhere Far Away, Springfield, Country";
    const { ok, log, lines, words, dir } = buildAuthors(`\\author{Ann Lee\\\\ ${long} \\and Bob Kay\\\\ Y}`);
    try {
      expect(ok, log).toBe(true);
      // 左の段の右端は約 550pt、右の段の左端は約 640pt。この間（段の間）に語が掛かれば、段からはみ出している。
      expect(words.filter((x) => x.x1 > 560 && x.x0 < 630).map((x) => x.w)).toEqual([]);
      expect(words.some((x) => x.w === "Country" && x.x1 < 560)).toBe(true);
      expect(lines.join("\n")).toContain("Bob Kay");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("\\AND は著者欄の段落を改める（\\And は横に並べる）", () => {
    const { ok, log, lines, dir } = buildAuthors("\\author{Ann Lee\\\\ X \\And Bob Kay\\\\ Y \\AND Cy Poe\\\\ Z}");
    try {
      expect(ok, log).toBe(true);
      const row = (n: string): string => lines.find((l) => l.includes(n)) ?? "";
      expect(row("Ann Lee")).toContain("Bob Kay");
      expect(row("Ann Lee")).not.toContain("Cy Poe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

// 古い eso-pic のコードを抱えた class（issue #520）: cvpr.cls の 198-205 行目の形（2007.02915）を写した class で、
// 対訳の前文が eso-pic を読むと `\ESO@isMEMOIR already defined` で止まる。ページ番号と罫線は eso-pic を読まずに描く。
const hasLualatex = spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("kpsewhich", ["luatexja-preset.sty"], { encoding: "utf8" }).stdout.trim() !== "";

const OLD_ESOPIC_CLS = [
  "\\NeedsTeXFormat{LaTeX2e}",
  "\\ProvidesClass{oldeso}[2021/01/01 old eso-pic inside a class]",
  "\\LoadClass{article}",
  "\\makeatletter",
  "\\newcommand\\eg{e.g.}",
  "\\newcommand{\\ESO@HookI}{} \\newcommand{\\ESO@HookII}{}",
  "\\newcommand{\\ESO@HookIII}{}",
  "\\newcommand{\\AddToShipoutPicture}{%",
  "  \\@ifstar{\\g@addto@macro\\ESO@HookII}{\\g@addto@macro\\ESO@HookI}}",
  "\\newcommand{\\ClearShipoutPicture}{\\global\\let\\ESO@HookI\\@empty}",
  "\\newcommand\\ESO@isMEMOIR[1]{}",
  "\\@ifclassloaded{memoir}{\\renewcommand\\ESO@isMEMOIR[1]{#1}}{}",
  "\\makeatother",
  "",
].join("\n");

function buildOldEso(): { ok: boolean; log: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-oldeso-"));
  writeFileSync(path.join(dir, "oldeso.cls"), OLD_ESOPIC_CLS);
  const pre = "\\documentclass{oldeso}\n";
  const body = (t: string): string => `\\begin{document}\n${t}\n\\end{document}\n`;
  const long = (w: string): string => Array.from({ length: 80 }, (_, i) => `${w}${i} lorem ipsum dolor sit amet.`).join(" ");
  const { mainTex } = assembleBilingual({
    cleanLatex: pre + body("A"),
    translatedMainTex: `${pre}\\usepackage{luatexja}\n${body("B")}`,
    source: [{ id: "seg-0000", tex: `Left \\eg ${long("L")}` }, { id: "seg-0001", tex: "Second left." }],
    translated: [{ id: "seg-0000", tex: `右 \\eg ${long("R")}` }, { id: "seg-0001", tex: "二番目の右。" }],
  });
  writeFileSync(path.join(dir, "main.tex"), mainTex);
  const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
  return { ok: r.status === 0, log: r.stdout.slice(-3000), dir };
}

describe.skipIf(!hasLualatex)("class が古い eso-pic のコードを抱えた文書の対訳を lualatex で組む（issue #520）", () => {
  it("原前文のまま組め、ページ番号は左右の下端・罫線は中央に出る", () => {
    const r = buildOldEso();
    try {
      expect(r.ok, r.log).toBe(true);
      expect(r.log).not.toMatch(/ESO@isMEMOIR/);
      const words = spawnSync("pdftotext", ["-f", "1", "-l", "1", "-bbox", "main.pdf", "-"], { cwd: r.dir, encoding: "utf8" }).stdout;
      const at = (w: string): { x: number; y: number } => {
        const m = new RegExp(`xMin="([\\d.]+)" yMin="([\\d.]+)"[^>]*>${w}</word>`).exec(words);
        expect(m, w).not.toBeNull();
        return { x: Number(m![1]), y: Number(m![2]) };
      };
      // 紙は 420mm × 297mm（1190.55pt × 841.89pt）。ページ番号は下端から 10mm の高さの中心、左は 105mm・右は 315mm の中心。
      const l = at("原文");
      const rt = at("和訳");
      expect(Math.abs(l.y - (841.89 - 10 * 2.8346 - 6))).toBeLessThan(8);
      expect(Math.abs(l.x - (105 * 2.8346 - 25))).toBeLessThan(10);
      expect(Math.abs(rt.x - (315 * 2.8346 - 25))).toBeLessThan(10);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 240_000);
});

// \maketitle を 2 回呼ぶ CVPR の型（cvpr.cls は article の二段組を読み込み、\maketitle は定義しない。実例 2007.02915 の cvpr.tex。issue #532）。
// article の \maketitle は 1 回目で自分を \relax にするので原文は 1 回だけ組むが、対訳は 1 回目をタイトルブロックに置き換える。
const CVPR_BODY = (title: string, abs: string): string =>
  `\\title{${title}}\n\\author{Ann Lee}\n\\maketitle\n\n%\\pagestyle{empty}\n\\maketitle\n\n${abs}\n\n\\section{Intro}\nBody paragraph.\n`;

describe.skipIf(!hasLualatex)("\\maketitle を 2 回呼ぶ二段組の class の対訳を lualatex で組む（issue #532）", () => {
  it("表題は左右 1 回ずつ 1 ページ目に出て、本文はその下から始まり、class のページ番号は出ない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-cvpr-"));
    try {
      const pre = "\\documentclass[10pt,twocolumn]{article}\n";
      const { mainTex } = assembleBilingual({
        cleanLatex: `${pre}\\begin{document}\n\\end{document}\n`,
        translatedMainTex: `${pre}\\usepackage{luatexja}\n\\begin{document}\n\\end{document}\n`,
        source: [{ id: "seg-0000", tex: CVPR_BODY("Labels Title", "Abstract text.") }],
        translated: [{ id: "seg-0000", tex: CVPR_BODY("和訳の表題", "要旨の本文。") }],
      });
      writeFileSync(path.join(dir, "main.tex"), mainTex);
      const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
      expect(r.status, r.stdout.slice(-3000)).toBe(0);
      const text = spawnSync("pdftotext", ["-layout", "main.pdf", "-"], { cwd: dir, encoding: "utf8" }).stdout;
      const pages = text.split("\f").filter((p) => p.trim() !== "");
      expect(pages.length).toBe(1);
      expect(text.match(/Labels Title/g)).toHaveLength(1);
      expect(text.match(/和訳の表題/g)).toHaveLength(1);
      expect(pages[0]).toContain("Abstract text.");
      expect(pages[0]).toContain("要旨の本文。");
      // article の \maketitle の \thispagestyle{plain} が組む頁番号は、行に数字だけが単独で出る。
      expect(text).not.toMatch(/^\s*\d+\s*$/m);
      expect(text).toContain("原文 p.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
