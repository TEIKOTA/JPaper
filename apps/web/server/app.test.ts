import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { translatePaper } from "../../../src/workflows/translate-paper.js";
import { GlossaryDb } from "../../../src/terminology/db.js";
import { FakeLlmClient } from "../../../src/testing/fake-llm.js";
import { makeTar } from "../../../src/ingest/archive.fixtures.js";
import type { LatexRunner } from "../../../src/tools/build-gate.js";
import { createApp } from "./app.js";
import { configFromEnv } from "./config.js";

const KEY = Buffer.alloc(32, 5);
const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.4 test");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-web-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LATEX = [
  "\\documentclass{article}",
  "\\title{A Study of the Rashomon Set}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{Intro}",
  "The Rashomon set is large. An empirical Rashomon set is finite.",
  "\\end{document}",
].join("\n");

function client(form: string): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [
          { src: "Rashomon set", form: `${form}(Rashomon set)`, class: "established", rendering: "bilingual" },
          { src: "empirical Rashomon set", form: `経験的${form}`, class: "paper-defined", rendering: "translate" },
          { src: "CMA-ES", form: "CMA-ES", class: "do-not-translate", rendering: "keep-original" },
        ],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    const ja = req.user.includes("\\title{")
      ? `\\title{${form}の研究}\n% pdf-name: rashomon study`
      : req.user.includes("\\section{Intro}")
        ? `\\section{序論}\n${form}(Rashomon set)は大きい。経験的${form}は有限である。`
        : "\\maketitle";
    return JSON.stringify({ segmentId: "x", ja });
  });
}

async function setup() {
  const root = tmp();
  const articleDir = path.join(root, "article");
  const dbFile = path.join(root, "glossary.db");
  const db = new GlossaryDb(dbFile);
  for (const [id, form] of [
    ["2601.00001", "ラショモン集合"],
    ["2601.00002", "ラショモンの集合"],
  ] as const) {
    const bytes = gzipSync(makeTar([{ name: "main.tex", content: LATEX }]));
    const r = await translatePaper({ kind: "arxiv", id }, { provider: "claude", outDir: path.join(articleDir, `${id}-ja`) }, {
      client: client(form),
      db,
      cacheKey: KEY,
      latexRunner: okRunner,
      trace: () => undefined,
      ingest: {
        arxiv: {
          fetchImpl: (async () =>
            ({ ok: true, status: 200, arrayBuffer: async () => bytes }) as unknown as Response) as unknown as typeof fetch,
          state: { lastRequestAt: 0 },
          now: () => 0,
          sleep: async () => {},
        },
      },
    });
    expect(r.status).toBe("ok");
  }
  db.close();
  const app = createApp({ articleDir, dbPath: dbFile, cacheKey: KEY, latexRunner: okRunner });
  const json = async (url: string, init?: RequestInit) => {
    const res = await app.request(url, { headers: { host: "127.0.0.1:5174", "content-type": "application/json" }, ...init });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, json, articleDir, dbFile };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { host: "127.0.0.1:5174", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("用語集 Web API（契約付録 §9）", () => {
  it("論文の一覧: 日本語タイトル・原題・ID・用語数・PDF の有無", async () => {
    const { json } = await setup();
    const { status, body } = await json("/api/papers");
    expect(status).toBe(200);
    expect(body.papers).toEqual([
      {
        id: "2601.00001",
        titleJa: "ラショモン集合の研究",
        titleEn: "A Study of the Rashomon Set",
        termCount: 3,
        pdf: { ja: true, bilingual: true },
      },
      expect.objectContaining({ id: "2601.00002", titleJa: "ラショモンの集合の研究" }),
    ]);
  });

  it("論文の用語集: 訳語・表記・出現数・全体 DB の状態・編集の可否", async () => {
    const { json } = await setup();
    const { body } = await json("/api/papers/2601.00001");
    expect(body.backup).toBeNull();
    expect(body.terms).toEqual([
      expect.objectContaining({ src: "Rashomon set", ja: "ラショモン集合", count: 1, editable: true, db: "none" }),
      expect.objectContaining({ src: "empirical Rashomon set", ja: "経験的ラショモン集合", count: 1 }),
      expect.objectContaining({ src: "CMA-ES", editable: false }),
    ]);
    expect((await json("/api/papers/9999.99999")).status).toBe(400);
  });

  it("確認→適用→全体 DB 登録→影響あり→元に戻す", async () => {
    const { app, json, dbFile } = await setup();
    const preview = await json("/api/papers/2601.00001/preview", post({ src: "Rashomon set", ja: "羅生門集合" }));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ replaced: 2, shielded: 1, newForm: "羅生門集合(Rashomon set)" });
    expect(preview.body.writes).toBeUndefined();

    const bad = await json("/api/papers/2601.00001/preview", post({ src: "CMA-ES", ja: "x" }));
    expect(bad.status).toBe(400);

    const applied = await json(
      "/api/papers/2601.00001/apply",
      post({ src: "Rashomon set", ja: "羅生門集合", registerGlobal: true }),
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ replaced: 2, registered: true, pdf: { ja: true, bilingual: true } });
    expect(applied.body.affected).toEqual([
      { id: "2601.00002", titleJa: "ラショモンの集合の研究", currentJa: "ラショモンの集合" },
    ]);

    const paper = await json("/api/papers/2601.00001");
    expect(paper.body.terms).toContainEqual(
      expect.objectContaining({ src: "Rashomon set", ja: "羅生門集合", db: "confirmed" }),
    );
    expect(paper.body.backup).toMatchObject({ src: "Rashomon set", newForm: "羅生門集合(Rashomon set)" });

    const glossary = await json("/api/glossary");
    const confirmed = (glossary.body.terms as { status: string; ja: string; affected: unknown[] }[]).filter(
      (t) => t.status === "confirmed",
    );
    expect(confirmed).toEqual([
      expect.objectContaining({ ja: "羅生門集合(Rashomon set)", affected: [expect.objectContaining({ id: "2601.00002" })] }),
    ]);

    const pdf = await app.request("/api/papers/2601.00001/pdf/ja", { headers: { host: "127.0.0.1" } });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("2601.00001_rashomon-study-ja.pdf");

    const undone = await json("/api/papers/2601.00001/undo", { ...post({}) });
    expect(undone.status).toBe(200);
    expect((await json("/api/papers/2601.00001")).body.terms).toContainEqual(
      expect.objectContaining({ src: "Rashomon set", ja: "ラショモン集合" }),
    );
    expect((await json("/api/papers/2601.00001/undo", post({}))).status).toBe(400);
    // 全体の用語 DB への登録は元に戻さない。
    const db = new GlossaryDb(dbFile);
    expect(db.confirmedFor("Rashomon set")).toHaveLength(1);
    db.close();
  });

  it("手元以外の Host・Origin を拒む", async () => {
    const { app } = await setup();
    expect((await app.request("/api/papers", { headers: { host: "evil.example" } })).status).toBe(403);
    expect(
      (await app.request("/api/papers", { headers: { host: "127.0.0.1:5174", origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (await app.request("/api/papers", { headers: { host: "localhost:5173", origin: "http://localhost:5173" } })).status,
    ).toBe(200);
    // 同じ手元でも、画面・API 以外のポートのページからは受け付けない。
    expect(
      (await app.request("/api/papers", { headers: { host: "127.0.0.1:5174", origin: "http://127.0.0.1:3000" } })).status,
    ).toBe(403);
  });

  it("書き込みは JSON だけを受け付ける（プリフライトの無い単純リクエストを通さない）", async () => {
    const { app } = await setup();
    const res = await app.request("/api/papers/2601.00001/undo", {
      method: "POST",
      headers: { host: "127.0.0.1:5174", origin: "http://127.0.0.1:5173", "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("データの場所は CLI と同じ既定（CWD の article/）で、環境変数で変えられる", () => {
    expect(configFromEnv({}, "/w").articleDir).toBe("/w/article");
    expect(configFromEnv({ JPAPER_ARTICLE_DIR: "x/y", JPAPER_GLOSSARY_DB: "/t/g.db" }, "/w")).toMatchObject({
      articleDir: "/w/x/y",
      dbPath: "/t/g.db",
    });
    expect(configFromEnv({ JPAPER_WEB_PORT: "6000", JPAPER_WEB_API_PORT: "6001" }, "/w").origins).toEqual([
      "http://127.0.0.1:6000",
      "http://localhost:6000",
      "http://127.0.0.1:6001",
      "http://localhost:6001",
    ]);
  });
});
