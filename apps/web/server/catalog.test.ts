import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeStep } from "../../../src/durable/checkpoint.js";
import { GlossaryDb } from "../../../src/terminology/db.js";
import { renderGlossaryMd, type ResolvedRow } from "../../../src/terminology/glossary-io.js";
import { TITLE_SEGMENT_ID } from "../../../src/tools/paper-title.js";
import { globalTerms, listPapers } from "./catalog.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const KEY = Buffer.alloc(32, 7);

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ROWS: ResolvedRow[] = [
  { src: "Rashomon set", form: "ラショモン集合(Rashomon set)", class: "established", rendering: "bilingual" },
  { src: "empirical risk", form: "経験リスク", class: "established", rendering: "translate" },
  { src: "loss landscape", form: "損失地形", class: "established", rendering: "translate" },
];

function writePaper(articleDir: string, id: string, title: string): string {
  const dir = path.join(articleDir, `${id}-ja`);
  const runDir = path.join(dir, ".run");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "glossary.md"), renderGlossaryMd(ROWS));
  writeStep(
    runDir,
    TITLE_SEGMENT_ID,
    { segmentId: TITLE_SEGMENT_ID, ja: `\\title{${title}の研究}`, passed: true, usedRevisions: 0, maxRevisions: 2, warnIssues: [] },
    { invalidation: "a1", key: KEY },
  );
  writeStep(
    runDir,
    "ingest",
    {
      cleanLatex: `\\documentclass{article}\n\\title{A Study of ${id}}\n\\begin{document}\n\\maketitle\n\\section{Intro}\nText.\n\\end{document}\n`,
      figures: [],
      paperId: id,
      sourceDir: dir,
      mainDir: dir,
    },
    { invalidation: "b2", key: KEY },
  );
  return dir;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jpaper-catalog-"));
  dirs.push(root);
  const articleDir = path.join(root, "article");
  const paperDirs = [writePaper(articleDir, "2601.00001", "第一"), writePaper(articleDir, "2601.00002", "第二")];
  const db = new GlossaryDb(path.join(root, "glossary.db"));
  const confirmed = [
    { src: "Rashomon set", ja: "羅生門集合(Rashomon set)", class: "established", rendering: "bilingual" },
    { src: "empirical risk", ja: "実験リスク", class: "established", rendering: "translate" },
    { src: "loss landscape", ja: "損失景観", class: "established", rendering: "translate" },
  ];
  db.writeBackProposed(confirmed);
  for (const e of confirmed) db.promote(e.src, e.ja, null);
  return { articleDir, paperDirs, db };
}

function readsUnder(dir: string): number {
  return vi
    .mocked(fs.readFileSync)
    .mock.calls.filter(([p]) => typeof p === "string" && p.startsWith(path.join(dir, ".run", "steps") + path.sep)).length;
}

describe("用語集の一覧（契約付録 §9）", () => {
  it("1 回の一覧で、論文ごとにタイトル・取り込みの checkpoint を 1 回だけ読む", () => {
    const { articleDir, paperDirs, db } = setup();
    try {
      vi.mocked(fs.readFileSync).mockClear();
      const terms = globalTerms(db, articleDir, KEY);

      expect(terms.map((t) => t.affected)).toEqual(
        [
          ["経験リスク"],
          ["損失地形"],
          ["ラショモン集合"],
        ].map(([currentJa]) => [
          { id: "2601.00001", titleJa: "第一の研究", currentJa },
          { id: "2601.00002", titleJa: "第二の研究", currentJa },
        ]),
      );
      for (const dir of paperDirs) expect(readsUnder(dir)).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("論文の一覧の作成日と更新日（契約付録 §9）", () => {
  it("更新日は glossary.md などと成果物 PDF の最も新しい更新日時、作成日より古ければ作成日", () => {
    const { articleDir, paperDirs, db } = setup();
    db.close();
    const [first, second] = paperDirs as [string, string];
    const created = fs.statSync(first).birthtimeMs;
    // ⚠ landmines.md
    const later = new Date(Math.ceil((Math.max(created, Date.now()) + 60_000) / 1000) * 1000);
    const pdf = path.join(first, "2601.00001_a-study-ja.pdf");
    fs.writeFileSync(pdf, "%PDF");
    fs.utimesSync(pdf, later, later);
    const old = new Date(0);
    fs.utimesSync(path.join(second, "glossary.md"), old, old);
    const papers = listPapers(articleDir, KEY);
    const p1 = papers.find((p) => p.id === "2601.00001")!;
    const p2 = papers.find((p) => p.id === "2601.00002")!;
    expect(p1.updatedAt).toBe(later.toISOString());
    expect(Date.parse(p2.updatedAt)).toBeGreaterThan(0);
    expect(p2.updatedAt).toBe(p2.createdAt);
  });
});
