import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { ArxivClient } from "./arxiv.js";
import { JobQueue, type JobRunner, type ProcessExit } from "./jobs.js";
import { UploadWords } from "./redact-preview.js";
import { readSettings } from "./settings.js";
import { parsePageRange } from "../../../src/ingest/pdf/text-layer.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-web-redact-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOST = { host: "127.0.0.1:5174" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
const PDF = (text: string): Buffer => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`);

// ページごとの語（左から 40pt おき、幅 35pt）。
const TEXTS = ["Work by Hanako Yamada on alpha", "Nothing here", "Thanks to Hanako Yamada again and Yamada"];
const pageXml = (text: string): string =>
  `<page width="504" height="720"><flow><block><line>${text
    .split(" ")
    .map((w, i) => `<word xMin="${String(72 + i * 40)}" yMin="100" xMax="${String(107 + i * 40)}" yMax="110">${w}</word>`)
    .join("")}</line></block></flow></page>`;

function setup(plain: readonly string[] = TEXTS) {
  const root = tmp();
  const articleDir = path.join(root, "article");
  const settingsPath = path.join(root, "home", "web-settings.json");
  const redactDir = path.join(root, "home", "web-uploads", ".redact");
  const specs: string[][] = [];
  const seen: { file: string; text: string; mode: number }[] = [];
  const exits: ((e: ProcessExit) => void)[] = [];
  const runner: JobRunner = (spec) => {
    specs.push(spec.args);
    const i = spec.args.indexOf("--redact-file");
    if (i >= 0) {
      const file = spec.args[i + 1]!;
      seen.push({ file, text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 });
    }
    return { done: new Promise<ProcessExit>((r) => exits.push(r)), kill: () => {} };
  };
  const jobs = new JobQueue({ articleDir, repoRoot: root, redactDir, concurrency: () => readSettings(settingsPath).concurrency, runner });
  const layoutCalls: [number, number][] = [];
  const words = new UploadWords(
    (_pdf, first, last) => {
      layoutCalls.push([first, last]);
      return Promise.resolve(`<doc>${TEXTS.slice(first - 1, last).map(pageXml).join("")}</doc>`);
    },
    (_pdf, first, last) => Promise.resolve(plain.slice(first - 1, last).map((t) => `${t}\n\f`).join("")),
  );
  const renders: number[] = [];
  const app = createApp(
    { articleDir, dbPath: path.join(root, "glossary.db"), settingsPath, repoRoot: root },
    {
      jobs,
      arxiv: new ArxivClient({ sleep: async () => {}, fetchImpl: (() => Promise.reject(new Error("no"))) as unknown as typeof fetch }),
      pdfPages: (_file, spec) =>
        Promise.resolve({
          total: TEXTS.length,
          pages: spec === undefined ? TEXTS.map((_, i) => i + 1) : parsePageRange(spec, TEXTS.length),
        }),
      words,
      renderPage: (_file, page, prefix) => {
        renders.push(page);
        writeFileSync(`${prefix}.png`, `png-${String(page)}`);
        return Promise.resolve(`${prefix}.png`);
      },
    },
  );
  const req = async (url: string, init: RequestInit = {}) => {
    const res = await app.request(url, { headers: HOST, ...init });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, body: type.includes("json") ? ((await res.json()) as Record<string, any>) : await res.text() };
  };
  const post = (url: string, body: unknown) => req(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const upload = async (): Promise<string> => {
    const r = await req("/api/uploads", { method: "POST", headers: { ...HOST, "content-type": "application/pdf" }, body: PDF("x") });
    return (r.body as Record<string, any>).upload.id as string;
  };
  return { req, post, upload, specs, seen, exits, jobs, articleDir, redactDir, renders, layoutCalls };
}

describe("伏せ字の範囲選択の API（契約付録 §9）", () => {
  it("ページの寸法と語の矩形を返し、語は 20 ページずつまとめて読む", async () => {
    const t = setup();
    const id = await t.upload();
    const r = await t.req(`/api/uploads/${id}/pages/3/words`);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, any>;
    expect(body).toMatchObject({ width: 504, height: 720 });
    expect(body.words[2]).toEqual({ x0: 152, y0: 100, x1: 187, y1: 110, text: "Hanako" });
    await t.req(`/api/uploads/${id}/pages/1/words`);
    expect(t.layoutCalls).toEqual([[1, 3]]);
    expect((await t.req(`/api/uploads/${id}/pages/4/words`)).status).toBe(400);
    expect((await t.req(`/api/uploads/${id}/pages/0x1/words`)).status).toBe(400);
  });

  it("語ごとの当たりの数と当たったページ、指定したページで白く塗る矩形を返す", async () => {
    const t = setup();
    const id = await t.upload();
    const r = await t.post(`/api/uploads/${id}/matches`, { terms: ["Hanako Yamada", "Yamada"], page: 3 });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, any>;
    expect(body.terms).toEqual([
      { term: "Hanako Yamada", count: 2, pages: [1, 3] },
      { term: "Yamada", count: 3, pages: [1, 3] },
    ]);
    // まとめて当てると "Hanako Yamada" が 2、残りの "Yamada" が 1。
    expect(body).toMatchObject({ totalHits: 3, mismatchPages: [] });
    // 3 ページ目は "Hanako Yamada" と最後の "Yamada"（長い語から当てる）。
    expect(body.boxes.map((b: { x0: number }) => b.x0)).toEqual([72 + 2 * 40 - 1, 72 + 3 * 40 - 1, 72 + 6 * 40 - 1]);
    expect((await t.post(`/api/uploads/${id}/matches`, { terms: ["Y"] })).status).toBe(400);
    expect((await t.post(`/api/uploads/${id}/matches`, { terms: [] })).body).toMatchObject({ terms: [] });
  });

  it("テキスト層とページ上の位置で当たりの数が違うページを返す（CLI はそこで止まる）", async () => {
    const t = setup(["Work by HanakoYamada on alpha", TEXTS[1]!, TEXTS[2]!]);
    const id = await t.upload();
    const r = await t.post(`/api/uploads/${id}/matches`, { terms: ["Hanako Yamada"] });
    expect(r.body).toMatchObject({ totalHits: 2, mismatchPages: [1] });
  });

  it("当たりの数が同じでも、テキスト層とページ上の位置で当たった場所が違うページを返す", async () => {
    const t = setup(["Work by HanakoYamada on alpha Hanako Yamada", TEXTS[1]!, TEXTS[2]!]);
    const id = await t.upload();
    const r = await t.post(`/api/uploads/${id}/matches`, { terms: ["Hanako Yamada"] });
    expect(r.body).toMatchObject({ mismatchPages: [1] });
  });

  it("同じまとまりを同時に求めても、語は 1 回だけ読む。同じ語を 2 回送っても 1 語として数える", async () => {
    const t = setup();
    const id = await t.upload();
    await Promise.all([t.req(`/api/uploads/${id}/pages/1/words`), t.req(`/api/uploads/${id}/pages/2/words`)]);
    expect(t.layoutCalls).toEqual([[1, 3]]);
    const r = await t.post(`/api/uploads/${id}/matches`, { terms: ["Yamada", " Yamada "] });
    expect((r.body as Record<string, any>).terms).toHaveLength(1);
  });

  it("ページ画像を描いて置き、2 回目は描き直さない", async () => {
    const t = setup();
    const id = await t.upload();
    const a = await t.req(`/api/uploads/${id}/pages/2/image`);
    expect(a.status).toBe(200);
    expect(a.type).toBe("image/png");
    await t.req(`/api/uploads/${id}/pages/2/image`);
    expect(t.renders).toEqual([2]);
  });
});

describe("伏せ字つきの翻訳ジョブ（契約付録 §9）", () => {
  it("語は本人だけが読めるファイルで --redact-file に渡し、終わったら消す。元の PDF を出力先にコピーしない", async () => {
    const t = setup();
    const id = await t.upload();
    const r = await t.post("/api/jobs", { upload: id, name: "book.pdf", provider: "claude", redact: ["Hanako Yamada", " Yamada "] });
    expect(r.status).toBe(201);
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]!.text).toBe("Hanako Yamada\nYamada\n");
    expect(t.seen[0]!.mode).toBe(0o600);
    expect(path.dirname(t.seen[0]!.file)).toBe(t.redactDir);
    // 入力は作業フォルダの PDF そのもの（source/ へコピーしない）。
    expect(t.specs[0]![2]).toMatch(new RegExp(`web-uploads/${id}\\.pdf$`));
    expect(existsSync(path.join(t.articleDir, `${id}-ja`, "source"))).toBe(false);
    // ジョブの一覧には語の数だけを載せる。
    expect(JSON.stringify(t.jobs.list())).not.toContain("Yamada");
    expect(t.jobs.list()[0]!.redactTerms).toBe(2);
    t.exits[0]!({ code: 0, signal: null });
    await t.jobs.idle();
    expect(existsSync(t.seen[0]!.file)).toBe(false);
  });

  it("arXiv のジョブにも語を付けられ、不正な語は 400 でジョブを始めない", async () => {
    const t = setup();
    const ok = await t.post("/api/jobs", { arxivId: "2601.20627", provider: "claude", redact: ["Taro Yamada"] });
    expect(ok.status).toBe(201);
    expect(t.specs[0]).toContain("--redact-file");
    // # で始まる語は --redact-file でコメントの行になり、黙って伏せられなくなる。
    for (const bad of [["Y"], "Taro", ["a\nb"], ["Taro Yamada", "#ProjectX"]]) {
      expect((await t.post("/api/jobs", { arxivId: "2601.20628", provider: "claude", redact: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(t.specs).toHaveLength(1);
  });

  it("前のプロセスが残した語のファイルは、起動のときに消す", () => {
    const root = tmp();
    const dir = path.join(root, ".redact");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "job-1-x.txt"), "Taro Yamada\n");
    new JobQueue({ articleDir: root, repoRoot: root, redactDir: dir, concurrency: () => 1, runner: () => ({ done: new Promise(() => {}), kill: () => {} }) });
    expect(existsSync(dir)).toBe(false);
  });
});
