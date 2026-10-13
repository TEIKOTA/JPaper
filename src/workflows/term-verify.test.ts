import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmRequest, Provider } from "../types/contract.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-term-verify-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function paper(): Promise<string> {
  const { makeTar } = await import("../ingest/archive.fixtures.js");
  const tar = path.join(tmp(), "p.tar");
  writeFileSync(
    tar,
    makeTar([
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\\begin{document}\\begin{abstract}We study the Widget set and the Gizmo ratio.\\end{abstract}" +
          "\\section{Intro}The Widget set is central. The Gizmo ratio is defined here.\\end{document}",
      },
    ]),
  );
  return tar;
}

const GLOSSARY = JSON.stringify({
  resolved: [
    { src: "Widget set", form: "ウィジェット集合", class: "established", rendering: "translate" },
    { src: "Gizmo ratio", form: "ギズモ比(Gizmo ratio)", class: "paper-defined", rendering: "bilingual" },
  ],
  brief: { thesis: "ウィジェット集合を調べる", sectionRoles: [], notationConventions: [] },
  style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
});

const FOUND = JSON.stringify({
  terms: [
    {
      src: "Widget set",
      candidates: [
        {
          form: "部品集合",
          sources: [
            { url: "https://example.jp/widget", quote: "部品集合とは何か" },
            { url: "https://another.org/w", quote: "この部品集合は" },
          ],
        },
      ],
    },
    { src: "Gizmo ratio", candidates: [] },
  ],
});

async function fake(verifier: (req: LlmRequest) => string | Promise<string> = () => FOUND) {
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  const translatorUsers: string[] = [];
  const client = new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) return GLOSSARY;
    if (req.system.includes("調査者")) return verifier(req);
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    translatorUsers.push(req.user);
    const forms = [...req.user.matchAll(/「([^」]+)」(?:（[^）]*）)?を使う/g)].map((m) => m[1]);
    return `\`\`\`tex\nこれは訳文である。${forms.join("、")}\n\`\`\``;
  });
  return { client, translatorUsers };
}

const ok = (d: string) => {
  writeFileSync(path.join(d, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

async function run(
  outDir: string,
  client: import("../testing/fake-llm.js").FakeLlmClient,
  opts: { provider?: Provider; verifyTerms?: boolean; webSearch?: boolean } = {},
  db?: import("../terminology/db.js").GlossaryDb,
) {
  const { translatePaper } = await import("./translate-paper.js");
  const { GlossaryDb } = await import("../terminology/db.js");
  const warnings: string[] = [];
  const r = await translatePaper(
    { kind: "path", path: await paper() },
    {
      provider: opts.provider ?? "claude",
      outDir,
      concurrency: 1,
      bilingual: false,
      ...(opts.verifyTerms === undefined ? {} : { verifyTerms: opts.verifyTerms }),
    },
    {
      client,
      db: db ?? new GlossaryDb(),
      latexRunner: ok,
      webSearch: opts.webSearch ?? true,
      onError: (m) => warnings.push(m),
    },
  );
  return { r, warnings };
}

const verifierCalls = (c: import("../testing/fake-llm.js").FakeLlmClient) =>
  c.calls.filter((q) => q.meta?.role === "term-verifier");

describe("用語の検証（契約付録 §4・issue #309）", () => {
  it("用例が採れた語は差し替えて訳し、採れない語は未確認として訳注・実行結果・glossary.md に出す", async () => {
    const { GlossaryDb } = await import("../terminology/db.js");
    const db = new GlossaryDb();
    const { client, translatorUsers } = await fake();
    const outDir = path.join(tmp(), "out");
    const { r, warnings } = await run(outDir, client, {}, db);

    expect(r.exitCode).toBe(0);
    const calls = verifierCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.webSearch).toBe(true);
    expect(calls[0]!.user).toContain("Widget set（用語集の訳案: ウィジェット集合）");
    expect(client.calls.filter((q) => q.meta?.role !== "term-verifier").every((q) => q.webSearch !== true)).toBe(true);

    expect(translatorUsers.some((u) => u.includes("部品集合"))).toBe(true);
    // 用語集だけでなく brief からも元の訳が消える（translator の user に載る）。
    expect(translatorUsers.some((u) => u.includes("ウィジェット集合"))).toBe(false);

    const md = readFileSync(path.join(outDir, "glossary.md"), "utf8");
    expect(md).toContain(
      "| Widget set | 部品集合 | established | translate |  | 用例に合わせた（元の訳: ウィジェット集合） 出典: https://example.jp/widget https://another.org/w |",
    );
    expect(readFileSync(path.join(outDir, "brief.md"), "utf8")).toContain("部品集合を調べる");
    expect(warnings.some((w) => w.startsWith("arXiv 以外の入力の論文の用語と abstract の冒頭を Web 検索に出して"))).toBe(true);
    expect(md).toContain("| Gizmo ratio | ギズモ比(Gizmo ratio) | paper-defined | bilingual |  | 未確認（Web 検索で用例を確かめられなかった） |");

    expect(r.summary.terms).toEqual({ checked: 2, confirmed: 0, replaced: 1, unverified: 1 });
    expect(r.summary.notes.byTrigger["unverified-term"]).toBe(1);
    const notes = JSON.parse(readFileSync(path.join(outDir, "notes.json"), "utf8")) as { trigger: string; text: string }[];
    expect(notes.find((n) => n.trigger === "unverified-term")?.text).toContain("Gizmo ratio の訳語「ギズモ比(Gizmo ratio)」");
    expect(warnings.some((w) => w.includes("Widget set「ウィジェット集合」→「部品集合」"))).toBe(true);
    expect(warnings.some((w) => w.includes("未確認") && w.includes("Gizmo ratio"))).toBe(true);

    // 差し替えた訳は承認待ち（proposed）として書き戻し、承認済みにはしない。
    expect(db.allFor("Widget set").map((e) => [e.ja, e.status])).toEqual([["部品集合", "proposed"]]);
    expect(db.confirmedFor("Widget set")).toEqual([]);
  });

  it("既存の glossary.md を使う run は検証しない。用語集を作り直すときは検証の checkpoint を使う", async () => {
    const outDir = path.join(tmp(), "out");
    const first = await fake();
    await run(outDir, first.client);
    expect(verifierCalls(first.client)).toHaveLength(1);

    const second = await fake();
    const again = await run(outDir, second.client);
    expect(verifierCalls(second.client)).toHaveLength(0);
    expect(again.r.summary.terms).toBeNull();

    rmSync(path.join(outDir, "glossary.md"));
    const third = await fake();
    const rebuilt = await run(outDir, third.client);
    expect(verifierCalls(third.client)).toHaveLength(0);
    expect(rebuilt.r.summary.terms).toEqual({ checked: 2, confirmed: 0, replaced: 1, unverified: 1 });
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toContain("| Widget set | 部品集合 |");
  });

  it("止めた・対象外のプロバイダ・検索を扱えない注入 client では検証しない", async () => {
    for (const opts of [
      { verifyTerms: false },
      { provider: "ollama" as const },
      { provider: "openrouter" as const },
      { webSearch: false },
    ]) {
      const { client } = await fake();
      const outDir = path.join(tmp(), "out");
      const { r } = await run(outDir, client, opts);
      expect(verifierCalls(client), JSON.stringify(opts)).toHaveLength(0);
      expect(r.summary.terms).toBeNull();
      expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).not.toContain("| 検証 |");
    }
  });

  it("GPT（codex）でも同じく検証する", async () => {
    const { client } = await fake();
    const { r } = await run(path.join(tmp(), "out"), client, { provider: "codex" });
    expect(verifierCalls(client)).toHaveLength(1);
    expect(r.summary.terms?.replaced).toBe(1);
  });

  it("検証の呼び出しが失敗したら対象語を未確認として進め、失敗は checkpoint に残さない", async () => {
    const outDir = path.join(tmp(), "out");
    const { JpaperError } = await import("../types/errors.js");
    const bad = await fake(() => {
      throw new JpaperError(2, "provider", "検索できませんでした");
    });
    const { r, warnings } = await run(outDir, bad.client);
    expect(r.exitCode).toBe(0);
    expect(r.summary.terms).toEqual({ checked: 2, confirmed: 0, replaced: 0, unverified: 2 });
    expect(warnings.some((w) => w.startsWith("用語の検証に失敗したため、対象の 2 語を未確認として進めます"))).toBe(true);
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toContain("| Widget set | ウィジェット集合 |");

    rmSync(path.join(outDir, "glossary.md"));
    const good = await fake();
    const again = await run(outDir, good.client);
    expect(verifierCalls(good.client)).toHaveLength(1);
    expect(again.r.summary.terms?.replaced).toBe(1);
  });

  it("対象語が無ければ検証を呼ばない", async () => {
    const { GlossaryDb } = await import("../terminology/db.js");
    const db = new GlossaryDb();
    db.writeBackProposed([
      { src: "Widget set", ja: "部品集合", class: "established", rendering: "translate", source: "x" },
      { src: "Gizmo ratio", ja: "機巧比", class: "paper-defined", rendering: "bilingual", source: "x" },
    ]);
    db.promote("Widget set", "部品集合", null);
    db.promote("Gizmo ratio", "機巧比", null);
    const { client } = await fake();
    const { r } = await run(path.join(tmp(), "out"), client, {}, db);
    expect(verifierCalls(client)).toHaveLength(0);
    expect(r.summary.terms).toEqual({ checked: 0, confirmed: 0, replaced: 0, unverified: 0 });
  });

  it("glossary.md を使う run でも、訳が同じままの未確認の語には未確認の訳注を付け続ける", async () => {
    const outDir = path.join(tmp(), "out");
    await run(outDir, (await fake()).client);
    const second = await run(outDir, (await fake()).client);
    expect(second.r.summary.terms).toBeNull();
    expect(second.r.summary.notes.byTrigger["unverified-term"]).toBe(1);

    const md = path.join(outDir, "glossary.md");
    writeFileSync(md, readFileSync(md, "utf8").replace("| ギズモ比(Gizmo ratio) |", "| 機巧比(Gizmo ratio) |"));
    const edited = await run(outDir, (await fake()).client);
    expect(edited.r.summary.notes.byTrigger["unverified-term"] ?? 0).toBe(0);
  });

  it("検証の途中の中断は未確認にせず、中断として返す", async () => {
    const c = new AbortController();
    const { client } = await fake(() => {
      c.abort();
      return FOUND;
    });
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const r = await translatePaper(
      { kind: "path", path: await paper() },
      { provider: "claude", outDir: path.join(tmp(), "out"), concurrency: 1, bilingual: false, signal: c.signal },
      { client, db: new GlossaryDb(), latexRunner: ok, webSearch: true },
    );
    expect(r.exitCode).toBe(6);
  });
});
