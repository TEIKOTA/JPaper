import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProfile } from "./frontmatter.js";
import { renderPairs } from "./bilingual-latex.js";

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
    split: true,
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
    split: true,
    expected: { false: ["ZeroL:0", "ZeroR:1", ...after], true: ["OneL:0", "OneR:1", ...after] },
  },
  {
    name: "段落をまたぐ条件分岐の中の、1 行で閉じた \\ifx … \\else … \\fi の行",
    pairs: mirror(["\\ifdraft\n\\mk{AL}", "\\ifx\\relax\\relax \\mk{XL}\\else \\mk{YL}\\fi\n\\fi", "\\mk{AfterL}"]),
    split: true,
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
    { left: "", right: "" },
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
