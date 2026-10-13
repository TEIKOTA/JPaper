import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { translatePaper, type TranslateDeps } from "./translate-paper.js";
import {
  applyTermEdit,
  loadPaperState,
  planTermEdit,
  readBackupInfo,
  undoTermEdit,
} from "./glossary-edit.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import { readStep, writeStep } from "../durable/checkpoint.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { JpaperInput, LlmClient } from "../types/contract.js";

const KEY = Buffer.alloc(32, 3);
const ID = "2601.00001";
const INPUT: JpaperInput = { kind: "arxiv", id: ID };

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), `%PDF ${readFileSync(path.join(dir, "main.tex"), "utf8").length}`);
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};
const failRunner: LatexRunner = () => ({ code: 1, log: "! Emergency stop." });

const LATEX = [
  "\\documentclass{article}",
  "\\title{A Study of the Rashomon Set}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{Intro}",
  "The Rashomon set is large. An empirical Rashomon set is finite.",
  "\\section{Body}",
  "We sample the Rashomon set again with CMA-ES.",
  "\\end{document}",
].join("\n");

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-ge-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function arxivDeps(latex = LATEX): TranslateDeps["ingest"] {
  const bytes = gzipSync(makeTar([{ name: "main.tex", content: latex }]));
  return {
    arxiv: {
      fetchImpl: (async () =>
        ({ ok: true, status: 200, arrayBuffer: async () => bytes }) as unknown as Response) as unknown as typeof fetch,
      state: { lastRequestAt: 0 },
      now: () => 0,
      sleep: async () => {},
    },
  };
}

function translator(user: string): string {
  if (user.includes("\\title{")) return "\\title{ラショモン集合の研究}\n% pdf-name: rashomon study";
  if (user.includes("\\section{Intro}")) {
    return "\\section{序論}\nラショモン集合(Rashomon set)は大きい。経験的ラショモン集合は有限である。";
  }
  if (user.includes("\\section{Body}")) return "\\section{本体}\nCMA-ES でラショモン集合を再び標本化する。";
  return "\\maketitle";
}

function paperClient(): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [
          { src: "Rashomon set", form: "ラショモン集合(Rashomon set)", class: "established", rendering: "bilingual", note: "以降は「ラショモン集合」" },
          { src: "empirical Rashomon set", form: "経験的ラショモン集合", class: "paper-defined", rendering: "translate" },
          { src: "CMA-ES", form: "CMA-ES", class: "do-not-translate", rendering: "keep-original" },
        ],
        brief: { thesis: "ラショモン集合を調べる", sectionRoles: [], notationConventions: ["ラショモン集合は初出で併記する"] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return JSON.stringify({ segmentId: req.meta?.segmentId ?? "x", ja: translator(req.user) });
  });
}

// 呼ばれたら失敗するクライアント。
function forbidden(): { client: LlmClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      complete: async (req) => {
        calls.push(req.meta?.segmentId ?? req.meta?.role ?? "?");
        throw new Error("LLM must not be called");
      },
    },
  };
}

async function translated(latex = LATEX): Promise<{ outDir: string; db: GlossaryDb }> {
  const outDir = path.join(tmp(), `${ID}-ja`);
  const db = new GlossaryDb();
  const r = await translatePaper(INPUT, { provider: "claude", outDir }, {
    client: paperClient(),
    db,
    cacheKey: KEY,
    latexRunner: okRunner,
    ingest: arxivDeps(latex),
    trace: () => undefined,
  });
  expect(r.status).toBe("ok");
  return { outDir, db };
}

const chapter = (outDir: string, id: string) =>
  readFileSync(path.join(outDir, "translation", "chapters", `${id}.tex`), "utf8");
const steps = (outDir: string) => readdirSync(path.join(outDir, ".run", "steps")).sort();
const deliverables = (outDir: string) => readdirSync(outDir).filter((n) => n.endsWith(".pdf")).sort();

async function rerun(outDir: string, db: GlossaryDb) {
  const f = forbidden();
  const r = await translatePaper(INPUT, { provider: "claude", outDir }, {
    client: f.client,
    db,
    cacheKey: KEY,
    latexRunner: okRunner,
    trace: () => undefined,
  });
  return { r, calls: f.calls };
}

describe("用語集の編集（契約付録 §9）", () => {
  it("確認: 併記形と以降の形を数え、ほかの語の一部に印を付け、原文の文を添える", async () => {
    const { outDir, db } = await translated();
    const plan = planTermEdit(loadPaperState(outDir, KEY), "Rashomon set", "羅生門集合");
    expect(plan.migrated).toBe(false);
    expect(plan.newForm).toBe("羅生門集合(Rashomon set)");
    expect(plan.replaced).toBe(3); // タイトル 1・seg-0001 1・seg-0002 1
    expect(plan.shielded).toBe(1);
    const intro = plan.items.filter((i) => i.where === "seg-0001");
    expect(intro).toHaveLength(2);
    expect(intro[0]!.label).toBe("第 1 節");
    expect(intro[0]!.before).toContainEqual({ text: "ラショモン集合", mark: "old" });
    expect(intro[0]!.after).toContainEqual({ text: "羅生門集合", mark: "new" });
    expect(intro[0]!.source).toContainEqual({ text: "Rashomon set", mark: "src" });
    expect(intro[1]!.replaced).toBe(0);
    expect(intro[1]!.shieldedBy).toEqual(["empirical Rashomon set"]);
    expect(intro[1]!.after).toContainEqual({ text: "ラショモン集合", mark: "shield" });
    expect(plan.contextItems.map((i) => i.where)).toEqual(
      expect.arrayContaining(["glossary.md", "brief.md"]),
    );
    db.close();
  });

  it("適用: 訳文・md・PDF を書き換え、その後の translatePaper は LLM を呼ばずに置換を保つ", async () => {
    const { outDir, db } = await translated();
    const before = deliverables(outDir);
    const out = await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, {
      db,
      cacheKey: KEY,
      latexRunner: okRunner,
    });
    expect(out.plan.replaced).toBe(3);
    expect(out.registered).toBe(false);
    expect(out.bilingualStatus).toBe("ok");
    expect(deliverables(outDir)).toEqual(before);
    expect(out.pdf).toBe(path.join(outDir, `${ID}_rashomon-study-ja.pdf`));
    expect(chapter(outDir, "seg-0001")).toBe(
      "\\section{序論}\n羅生門集合(Rashomon set)は大きい。経験的ラショモン集合は有限である。",
    );
    expect(chapter(outDir, "seg-0002")).toContain("羅生門集合を再び");
    const md = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    expect(md).toContain("| Rashomon set | 羅生門集合(Rashomon set) | established | bilingual | 以降は「羅生門集合」 |");
    expect(md).toContain("| empirical Rashomon set | 経験的ラショモン集合 |");
    expect(readFileSync(path.join(outDir, "brief.md"), "utf8")).toContain("羅生門集合を調べる");
    expect(readFileSync(path.join(outDir, "translation", "build", "main.tex"), "utf8")).toContain(
      "\\title{羅生門集合の研究}",
    );
    const glossaryStep = readStep(path.join(outDir, ".run"), "glossary", KEY)!.value as {
      resolved: { src: string; form: string }[];
    };
    expect(glossaryStep.resolved.find((r) => r.src === "Rashomon set")!.form).toBe("羅生門集合(Rashomon set)");
    // 印のままの訳文にも同じ置換をかける（形式検査の版の再検査で古い訳が戻らないように）。契約付録 §8
    const seg1 = readStep(path.join(outDir, ".run"), "seg-0001", KEY)!.value as { marked?: string };
    expect(seg1.marked).toContain("羅生門集合(Rashomon set)は大きい");
    expect(seg1.marked).not.toContain("ラショモン集合(Rashomon set)");

    const { r, calls } = await rerun(outDir, db);
    expect(calls).toEqual([]);
    expect(r.status).toBe("ok");
    expect(r.summary.title).toBe("translated");
    expect(chapter(outDir, "seg-0001")).toContain("羅生門集合(Rashomon set)は大きい");
    db.close();
  });

  it("元に戻す: 適用前の md・訳文・checkpoint・PDF に戻り、バックアップは 1 世代だけ", async () => {
    const { outDir, db } = await translated();
    const md0 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    const ch0 = chapter(outDir, "seg-0001");
    const steps0 = steps(outDir);
    const pdf0 = readFileSync(path.join(outDir, `${ID}_rashomon-study-ja.pdf`), "utf8");
    expect(readBackupInfo(outDir)).toBeUndefined();
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    await applyTermEdit(outDir, "Rashomon set", "羅生門の集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    expect(readBackupInfo(outDir)).toMatchObject({ oldForm: "羅生門集合(Rashomon set)", newForm: "羅生門の集合(Rashomon set)" });
    undoTermEdit(outDir);
    expect(chapter(outDir, "seg-0001")).toContain("羅生門集合(Rashomon set)");
    expect(readBackupInfo(outDir)).toBeUndefined();
    expect(() => undoTermEdit(outDir)).toThrow(/元に戻せる適用がありません/);

    await applyTermEdit(outDir, "Rashomon set", "ラショモン集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    undoTermEdit(outDir);
    expect(chapter(outDir, "seg-0001")).toContain("羅生門集合(Rashomon set)");
    // 最初の状態へは、さらに前の適用の逆を当てて戻る（バックアップは 1 世代）。
    await applyTermEdit(outDir, "Rashomon set", "ラショモン集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md0);
    expect(chapter(outDir, "seg-0001")).toBe(ch0);
    expect(steps(outDir)).toEqual(steps0);
    expect(readFileSync(path.join(outDir, `${ID}_rashomon-study-ja.pdf`), "utf8")).toBe(pdf0);
    const { calls } = await rerun(outDir, db);
    expect(calls).toEqual([]);
    db.close();
  });

  it("全体の用語 DB に登録しないなら、適用しても元に戻しても全体 DB は変わらない", async () => {
    const { outDir, db } = await translated();
    const before = db.allFor("Rashomon set").map((e) => `${e.ja}/${e.status}`);
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    expect(db.allFor("Rashomon set").map((e) => `${e.ja}/${e.status}`)).toEqual(before);
    undoTermEdit(outDir);
    expect(db.allFor("Rashomon set").map((e) => `${e.ja}/${e.status}`)).toEqual(before);
    db.close();
  });

  it("全体の用語 DB に承認済みとして登録する", async () => {
    const { outDir, db } = await translated();
    const out = await applyTermEdit(outDir, "Rashomon set", "羅生門集合", { registerGlobal: true }, {
      db,
      cacheKey: KEY,
      latexRunner: okRunner,
    });
    expect(out.registered).toBe(true);
    expect(db.confirmedFor("Rashomon set").map((e) => e.ja)).toEqual(["羅生門集合(Rashomon set)"]);
    expect(readBackupInfo(outDir)?.registerGlobal).toBe(true);
    db.close();
  });

  it("失敗した適用は、その前に成功した適用の「元に戻す」を消さない", async () => {
    const { outDir, db } = await translated();
    const md0 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    const md1 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    await expect(
      applyTermEdit(outDir, "Rashomon set", "羅生門の集合", {}, { db, cacheKey: KEY, latexRunner: failRunner }),
    ).rejects.toThrow(/元に戻しました/);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md1);
    expect(readBackupInfo(outDir)?.newForm).toBe("羅生門集合(Rashomon set)");
    undoTermEdit(outDir);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md0);
    db.close();
  });

  it("適用のあとに md や訳文が変わっていたら、元に戻すを拒んで今の状態を残す", async () => {
    const { outDir, db } = await translated();
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    const edited = readFileSync(path.join(outDir, "glossary.md"), "utf8").replace("経験的ラショモン集合", "実証的ラショモン集合");
    writeFileSync(path.join(outDir, "glossary.md"), edited);
    expect(() => undoTermEdit(outDir)).toThrow(/元に戻せません/);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(edited);
    expect(readBackupInfo(outDir)).toBeDefined();
    db.close();
  });

  it("適用のあとの CLI 再実行が何も変えなければ、元に戻せる", async () => {
    const { outDir, db } = await translated();
    const md0 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    const { calls } = await rerun(outDir, db);
    expect(calls).toEqual([]);
    undoTermEdit(outDir);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md0);
    db.close();
  });

  it("対訳 PDF があった論文で対訳だけ組めなくなったら、変更を戻して投げる", async () => {
    const { outDir, db } = await translated();
    const md0 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    const pdfs0 = deliverables(outDir);
    expect(pdfs0.some((f) => f.endsWith("-bilingual.pdf"))).toBe(true);
    const bilingualFails: LatexRunner = (dir) =>
      readFileSync(path.join(dir, "main.tex"), "utf8").includes("paracol") ? failRunner(dir) : okRunner(dir);
    await expect(
      applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: bilingualFails }),
    ).rejects.toThrow(/対訳 PDF が組めなくなった/);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md0);
    expect(deliverables(outDir)).toEqual(pdfs0);
    db.close();
  });

  it("組み直しに失敗したら変更を戻して投げる", async () => {
    const { outDir, db } = await translated();
    const md0 = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    const steps0 = steps(outDir);
    await expect(
      applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: failRunner }),
    ).rejects.toThrow(/元に戻しました/);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toBe(md0);
    expect(steps(outDir)).toEqual(steps0);
    expect(chapter(outDir, "seg-0001")).toContain("ラショモン集合(Rashomon set)");
    expect(readBackupInfo(outDir)).toBeUndefined();
    db.close();
  });

  it("同じ論文への適用・元に戻すの同時実行を拒む", async () => {
    const { outDir, db } = await translated();
    const first = applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    await expect(
      applyTermEdit(outDir, "Rashomon set", "羅生門の集合", {}, { db, cacheKey: KEY, latexRunner: okRunner }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(() => undoTermEdit(outDir)).toThrow(expect.objectContaining({ kind: "conflict" }));
    await first;
    expect(chapter(outDir, "seg-0001")).toContain("羅生門集合(Rashomon set)");
    db.close();
  });

  it("入力の検査: 原語のままの語・今と同じ訳語・使えない文字・無い語を拒む", async () => {
    const { outDir, db } = await translated();
    const state = loadPaperState(outDir, KEY);
    expect(() => planTermEdit(state, "CMA-ES", "シーエムエー")).toThrow(/原語のまま/);
    expect(() => planTermEdit(state, "Rashomon set", "ラショモン集合")).toThrow(/今と同じ/);
    expect(() => planTermEdit(state, "Rashomon set", "集合 $x$")).toThrow(/使えない文字/);
    expect(() => planTermEdit(state, "nope", "x")).toThrow(/ありません/);
    db.close();
  });

  it("別の版が作った checkpoint は、md が未編集で原文と対応するときだけ引き継ぐ", async () => {
    const { outDir, db } = await translated();
    const runDir = path.join(outDir, ".run");
    for (const id of ["seg-0001", "seg-0002", "title"]) {
      const s = readStep(runDir, id, KEY)!;
      writeStep(runDir, id, s.value, { invalidation: "0123456789abcdef", key: KEY });
    }
    expect(loadPaperState(outDir, KEY).migrated).toBe(true);
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    expect(loadPaperState(outDir, KEY).migrated).toBe(false);
    const { calls } = await rerun(outDir, db);
    expect(calls).toEqual([]);

    // 手で直して再実行していない md は引き継がない（その語の訳し直しを失わせない）。
    for (const id of ["seg-0001", "seg-0002"]) {
      const s = readStep(runDir, id, KEY)!;
      writeStep(runDir, id, s.value, { invalidation: "fedcba9876543210", key: KEY });
    }
    const md = path.join(outDir, "glossary.md");
    writeFileSync(md, readFileSync(md, "utf8").replace("| 経験的ラショモン集合 |", "| 経験的な集合 |"));
    expect(() => loadPaperState(outDir, KEY)).toThrow(/編集されています/);
    db.close();
  });

  it("マクロ定義だけの節（checkpoint なし）があっても編集でき、その節は原文のまま残る", async () => {
    const withMacros = LATEX.replace("\\maketitle", "\\def\\x{y}\n\\newcommand{\\R}{r}");
    const { outDir, db } = await translated(withMacros);
    expect(steps(outDir).some((f) => f.startsWith("seg-0000."))).toBe(false);
    const plan = planTermEdit(loadPaperState(outDir, KEY), "Rashomon set", "羅生門集合");
    expect(plan.replaced).toBe(3);
    await applyTermEdit(outDir, "Rashomon set", "羅生門集合", {}, { db, cacheKey: KEY, latexRunner: okRunner });
    expect(chapter(outDir, "seg-0000")).toContain("\\def\\x{y}");
    expect(chapter(outDir, "seg-0001")).toContain("羅生門集合(Rashomon set)");
    db.close();
  });

  it("arXiv ID 以外の入力から訳した論文は組み直せないと明示する", async () => {
    const root = tmp();
    const tar = path.join(root, "p.tar");
    writeFileSync(tar, makeTar([{ name: "main.tex", content: LATEX }]));
    const outDir = path.join(root, "out");
    const db = new GlossaryDb();
    const r = await translatePaper({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: paperClient(),
      db,
      cacheKey: KEY,
      latexRunner: okRunner,
      trace: () => undefined,
    });
    expect(r.status).toBe("ok");
    expect(() => loadPaperState(outDir, KEY)).toThrow(/arXiv ID 以外/);
    expect(existsSync(path.join(outDir, ".run", "glossary-edit"))).toBe(false);
    db.close();
  });
});
