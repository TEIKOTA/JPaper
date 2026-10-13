import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { ArxivClient } from "./arxiv.js";
import { ATOM } from "./arxiv.fixtures.js";
import { configFromEnv } from "./config.js";
import { JobQueue, type JobRunner, type ProcessExit } from "./jobs.js";
import { emptySettings, MAX_HISTORY, readSettings, recordHistory, writeSettings } from "./settings.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-web-translate-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HEADERS = { host: "127.0.0.1:5174", "content-type": "application/json" };

function setup(opts: { fetchImpl?: typeof fetch } = {}) {
  const root = tmp();
  const articleDir = path.join(root, "article");
  const settingsPath = path.join(root, "home", "web-settings.json");
  // 訳済み（和訳 PDF あり）と途中まで（glossary.md だけ）の論文。
  const done = path.join(articleDir, "2601.20627-ja");
  mkdirSync(path.join(done, "translation", "build"), { recursive: true });
  writeFileSync(path.join(done, "glossary.md"), "");
  writeFileSync(path.join(done, "translation", "build", "main.pdf"), "%PDF");
  mkdirSync(path.join(articleDir, "hep-th_9901001-ja"), { recursive: true });

  const kills: string[] = [];
  const exits = new Map<string, (e: ProcessExit) => void>();
  const specs: string[][] = [];
  const runner: JobRunner = (spec) => {
    specs.push(spec.args);
    const id = spec.args[2]!;
    const done = new Promise<ProcessExit>((r) => exits.set(id, r));
    return { done, kill: () => kills.push(id) };
  };
  const config = {
    articleDir,
    dbPath: path.join(root, "glossary.db"),
    settingsPath,
    repoRoot: root,
  };
  const jobs = new JobQueue({
    articleDir,
    repoRoot: root,
    concurrency: () => readSettings(settingsPath).concurrency,
    runner,
  });
  const urls: string[] = [];
  const arxiv = new ArxivClient({
    sleep: async () => {},
    fetchImpl:
      opts.fetchImpl ??
      ((async (url: string) => {
        urls.push(url);
        return new Response(ATOM, { status: 200 });
      }) as unknown as typeof fetch),
  });
  const app = createApp(config, { jobs, arxiv });
  const req = async (url: string, init?: RequestInit) => {
    const res = await app.request(url, { headers: HEADERS, ...init });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = (url: string, body: unknown) => req(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return { app, req, post, settingsPath, kills, exits, urls, specs };
}

describe("設定 API（契約付録 §9）", () => {
  it("未設定なら provider・model・effort は空、並行数は 1。provider の一覧と effort の可否を返す", async () => {
    const { req } = setup();
    const { status, body } = await req("/api/settings");
    expect(status).toBe(200);
    expect(body).toEqual({
      settings: { providers: {}, concurrency: 1, verifyTerms: true, history: {} },
      providers: [
        { name: "ollama", effort: false },
        { name: "claude", effort: true },
        { name: "codex", effort: true },
        { name: "openrouter", effort: false },
      ],
      maxConcurrency: 4,
      maxHistory: MAX_HISTORY,
    });
  });

  it("保存して読み直せる。CLI と同じ検査に通らない値は 400 で保存しない", async () => {
    const { req, post, settingsPath } = setup();
    const saved = await post("/api/settings", {
      provider: "claude",
      concurrency: 2,
      providers: { claude: { model: " sonnet ", effort: "medium" }, ollama: { model: "", effort: "" } },
    });
    expect(saved.status).toBe(200);
    const want = {
      provider: "claude",
      providers: { claude: { model: "sonnet", effort: "medium" } },
      concurrency: 2,
      verifyTerms: true,
      history: {},
    };
    expect(saved.body.settings).toEqual(want);
    const { history: _h, ...stored } = want;
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(stored);
    expect((await req("/api/settings")).body.settings).toEqual(want);

    for (const bad of [
      { concurrency: 5 },
      { provider: "gpt", concurrency: 1 },
      { concurrency: 1, providers: { ollama: { effort: "low" } } },
      { concurrency: 1, providers: { claude: { effort: "Medium" } } },
      { concurrency: 1, providers: { claude: { model: "--out" } } },
    ]) {
      const r = await post("/api/settings", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await req("/api/settings")).body.settings).toEqual(want);
  });

  it("壊れた設定ファイルは空として読み、検査に通らない項目だけ捨てる", () => {
    const root = tmp();
    const file = path.join(root, "web-settings.json");
    writeFileSync(file, "{");
    expect(readSettings(file)).toEqual({ providers: {}, concurrency: 1, verifyTerms: true, history: {} });
    writeFileSync(
      file,
      JSON.stringify({ provider: "nope", concurrency: 9, providers: { ollama: { model: "m", effort: "x" }, claude: { model: "opus" } } }),
    );
    expect(readSettings(file)).toEqual({ providers: { claude: { model: "opus" } }, concurrency: 1, verifyTerms: true, history: {} });
    expect(readSettings(path.join(root, "none.json"))).toEqual({ providers: {}, concurrency: 1, verifyTerms: true, history: {} });
  });

  it("設定ファイルの場所は JPAPER_HOME/web-settings.json", () => {
    expect(configFromEnv({ JPAPER_HOME: "/h" }, "/w").settingsPath).toBe("/h/web-settings.json");
    expect(configFromEnv({ JPAPER_HOME: "rel" }, "/w").settingsPath).toBe("/w/rel/web-settings.json");
    expect(configFromEnv({ HOME: "/x" }, "/w").settingsPath).toMatch(/[\\/]\.jpaper[\\/]web-settings\.json$/);
  });
});

describe("arXiv 検索 API（契約付録 §9）", () => {
  it("手元の論文に印を付ける（和訳 PDF の有無・キューの状態）", async () => {
    const { req, post, urls } = setup();
    await post("/api/jobs", { arxivId: "hep-th/9901001", provider: "ollama" });
    const { status, body } = await req("/api/arxiv?q=rashomon%20set");
    expect(status).toBe(200);
    expect(urls[0]).toContain("search_query=all%3Arashomon+AND+all%3Aset");
    expect(body.total).toBe(42);
    expect(body.entries).toEqual([
      expect.objectContaining({ id: "2601.20627", paperId: "2601.20627", local: { pdf: true }, job: null }),
      expect.objectContaining({ id: "hep-th/9901001", local: null, job: "running" }),
    ]);
  });

  it("検索語が無ければ 400、arXiv の失敗は 502", async () => {
    expect((await setup().req("/api/arxiv?q=%20")).status).toBe(400);
    const failing = setup({ fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    const r = await failing.req("/api/arxiv?q=rashomon");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("HTTP 503");
  });
});

describe("翻訳ジョブ API（契約付録 §9）", () => {
  it("開始・一覧・二重実行の拒否・取り消し", async () => {
    const { req, post, kills, exits } = setup();
    const a = await post("/api/jobs", {
      arxivId: "arXiv:2601.00001v2",
      provider: "claude",
      model: "sonnet",
      effort: "medium",
      title: "A\nTitle",
    });
    expect(a.status).toBe(201);
    expect(a.body.job).toMatchObject({
      arxivId: "2601.00001v2",
      paperId: "2601.00001",
      title: "A Title",
      options: { provider: "claude", model: "sonnet", effort: "medium" },
      state: "running",
    });
    const b = await post("/api/jobs", { arxivId: "2601.00002", provider: "ollama", model: " ", effort: "" });
    expect(b.body.job).toMatchObject({ state: "queued", options: { provider: "ollama" } });
    expect((await post("/api/jobs", { arxivId: "2601.00001", provider: "claude" })).status).toBe(409);

    const list = await req("/api/jobs");
    expect(list.body.jobs.map((j: { state: string }) => j.state)).toEqual(["running", "queued"]);

    const canceled = await post(`/api/jobs/${b.body.job.id as string}/cancel`, {});
    expect(canceled.body.job.state).toBe("canceled");
    await post(`/api/jobs/${a.body.job.id as string}/cancel`, {});
    expect(kills).toEqual(["2601.00001v2"]);
    exits.get("2601.00001v2")!({ code: null, signal: "SIGTERM" });
    await new Promise((r) => setImmediate(r));
    expect((await req("/api/jobs")).body.jobs[0].state).toBe("canceled");
    expect((await post(`/api/jobs/${a.body.job.id as string}/cancel`, {})).status).toBe(409);
    expect((await post("/api/jobs/job-404/cancel", {})).status).toBe(404);
  });

  it("入力の検査: provider は必須、arXiv ID の形、CLI と同じ model・effort の検査", async () => {
    const { post } = setup();
    for (const bad of [
      { arxivId: "2601.00001" },
      { arxivId: "2601.00001", provider: "gpt" },
      { arxivId: "../etc", provider: "claude" },
      { arxivId: "/tmp/paper.tex", provider: "claude" },
      { arxivId: "", provider: "claude" },
      { arxivId: "2601.00001", provider: "ollama", effort: "low" },
      { arxivId: "2601.00001", provider: "claude", effort: "HIGH" },
      { arxivId: "2601.00001", provider: "claude", model: "-x" },
      { arxivId: "2601.00001", provider: "claude", model: 3 },
    ]) {
      const r = await post("/api/jobs", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
  });

  it("並行数の設定を保存すると、待機中のジョブがすぐ始まる", async () => {
    const { req, post } = setup();
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude" });
    const b = await post("/api/jobs", { arxivId: "2601.00002", provider: "claude" });
    expect(b.body.job.state).toBe("queued");
    await post("/api/settings", { concurrency: 2 });
    const { body } = await req("/api/jobs");
    expect(body.jobs.map((j: { state: string }) => j.state)).toEqual(["running", "running"]);
  });

  it("既存の Host・Origin・Content-Type の検査を通る", async () => {
    const { app, settingsPath } = setup();
    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { host: "127.0.0.1:5174", "content-type": "text/plain" },
      body: JSON.stringify({ concurrency: 2 }),
    });
    expect(res.status).toBe(415);
    const evil = await app.request("/api/jobs", {
      method: "POST",
      headers: { ...HEADERS, origin: "https://evil.example" },
      body: JSON.stringify({ arxivId: "2601.00001", provider: "claude" }),
    });
    expect(evil.status).toBe(403);
    expect(existsSync(settingsPath)).toBe(false);
  });
});

describe("model・effort の候補（契約付録 §9・issue #339）", () => {
  it("翻訳を始めた model・effort を provider ごとに新しい順で覚え、重複は先頭へ寄せる", async () => {
    const { req, post } = setup();
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet", effort: "medium" });
    await post("/api/jobs", { arxivId: "2601.00002", provider: "claude", model: "opus", effort: "high" });
    await post("/api/jobs", { arxivId: "2601.00003", provider: "claude", model: " sonnet " });
    await post("/api/jobs", { arxivId: "2601.00004", provider: "ollama", model: "gemma4:12b" });
    await post("/api/jobs", { arxivId: "2601.00005", provider: "codex" });
    const { body } = await req("/api/settings");
    expect(body.settings.history).toEqual({
      claude: { models: ["sonnet", "opus"], efforts: ["high", "medium"] },
      ollama: { models: ["gemma4:12b"], efforts: [] },
    });
  });

  it("provider ごとに MAX_HISTORY 件まで", async () => {
    const { req, post } = setup();
    for (let i = 0; i < MAX_HISTORY + 2; i++) {
      await post("/api/jobs", { arxivId: `2601.${String(10000 + i)}`, provider: "claude", model: `m${String(i)}` });
    }
    const models = (await req("/api/settings")).body.settings.history.claude.models as string[];
    expect(models).toHaveLength(MAX_HISTORY);
    expect(models[0]).toBe(`m${String(MAX_HISTORY + 1)}`);
    expect(models).not.toContain("m0");
  });

  it("recordHistory は先頭に置き、MAX_HISTORY 件で切る。model も effort も無ければ変えない", () => {
    let s = emptySettings();
    for (let i = 0; i < MAX_HISTORY + 2; i++) s = recordHistory(s, { provider: "claude", model: `m${String(i)}`, effort: "low" });
    expect(s.history.claude?.models).toHaveLength(MAX_HISTORY);
    expect(s.history.claude?.models[0]).toBe(`m${String(MAX_HISTORY + 1)}`);
    expect(s.history.claude?.efforts).toEqual(["low"]);
    expect(recordHistory(s, { provider: "codex" })).toBe(s);
  });

  it("始められなかったジョブ（検査の誤り・同じ論文の重複）は覚えない", async () => {
    const { req, post } = setup();
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "-x" });
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "a" });
    const dup = await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "b" });
    expect(dup.status).toBe(409);
    expect((await req("/api/settings")).body.settings.history).toEqual({ claude: { models: ["a"], efforts: [] } });
  });

  it("設定の保存は候補を消さず、送られた history は無視する", async () => {
    const { req, post } = setup();
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" });
    const saved = await post("/api/settings", { concurrency: 2, history: { claude: { models: ["evil"] } } });
    expect(saved.body.settings.history).toEqual({ claude: { models: ["sonnet"], efforts: [] } });
    expect((await req("/api/settings")).body.settings.history).toEqual({ claude: { models: ["sonnet"], efforts: [] } });
  });

  it("候補を消せる。ほかの設定は残る", async () => {
    const { req, post } = setup();
    await post("/api/settings", { provider: "claude", concurrency: 2 });
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" });
    const cleared = await post("/api/settings/history/clear", {});
    expect(cleared.status).toBe(200);
    expect(cleared.body.settings).toEqual({ provider: "claude", providers: {}, concurrency: 2, verifyTerms: true, history: {} });
    expect((await req("/api/settings")).body.settings.history).toEqual({});
  });

  it("読むときは検査に通らない値・重複を捨て、件数で切る", () => {
    const file = path.join(tmp(), "web-settings.json");
    const many = Array.from({ length: MAX_HISTORY + 3 }, (_, i) => `m${String(i)}`);
    writeFileSync(
      file,
      JSON.stringify({
        concurrency: 1,
        history: {
          claude: { models: ["a", "-x", 3, "a", "b"], efforts: ["HIGH", "low"] },
          ollama: { models: many, efforts: ["low"] },
          gpt: { models: ["x"] },
          codex: "nope",
        },
      }),
    );
    expect(readSettings(file).history).toEqual({
      claude: { models: ["a", "b"], efforts: ["low"] },
      ollama: { models: many.slice(0, MAX_HISTORY), efforts: [] },
    });
  });

  it("候補を保存できなくてもジョブは始まる", async () => {
    const { post, settingsPath } = setup();
    mkdirSync(settingsPath, { recursive: true });
    const r = await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" });
    expect(r.status).toBe(201);
  });

  it("writeSettings は rename に失敗したら一時ファイルを消して投げる", () => {
    const dir = tmp();
    const file = path.join(dir, "web-settings.json");
    mkdirSync(path.join(file, "occupied"), { recursive: true });
    expect(() => writeSettings(file, {})).toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("読めない設定ファイルは、ジョブを始めても候補を消しても書き換えない", async () => {
    const { post, settingsPath } = setup();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const broken = '{"provider":"claude","providers":{"claude":{"model":"opus"}},"concurrency":3,}';
    writeFileSync(settingsPath, broken);
    expect((await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" })).status).toBe(201);
    expect(readFileSync(settingsPath, "utf8")).toBe(broken);
    const cleared = await post("/api/settings/history/clear", {});
    expect(cleared.status).toBe(409);
    expect(readFileSync(settingsPath, "utf8")).toBe(broken);
  });

  it("候補の記録・消去・設定の保存は、ファイルの知らないキーを残す", async () => {
    const { post, settingsPath } = setup();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ concurrency: 1, futureKey: { a: 1 } }));
    const keep = () => (JSON.parse(readFileSync(settingsPath, "utf8")) as { futureKey?: unknown }).futureKey;
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" });
    expect(keep()).toEqual({ a: 1 });
    await post("/api/settings", { concurrency: 2 });
    expect(keep()).toEqual({ a: 1 });
    await post("/api/settings/history/clear", {});
    expect(keep()).toEqual({ a: 1 });
  });

  it("候補が変わらなければ設定ファイルを書き直さない", async () => {
    const { post, settingsPath } = setup();
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude", model: "sonnet" });
    const compact = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8")));
    writeFileSync(settingsPath, compact);
    await post("/api/jobs", { arxivId: "2601.00002", provider: "claude", model: "sonnet" });
    expect(readFileSync(settingsPath, "utf8")).toBe(compact);
  });

  it("候補を消す要求も Content-Type・Origin の検査を通る", async () => {
    const { app } = setup();
    const plain = await app.request("/api/settings/history/clear", {
      method: "POST",
      headers: { host: "127.0.0.1:5174", "content-type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
    const evil = await app.request("/api/settings/history/clear", {
      method: "POST",
      headers: { ...HEADERS, origin: "https://evil.example" },
      body: "{}",
    });
    expect(evil.status).toBe(403);
  });
});

describe("用語を Web 検索で確かめる設定（契約付録 §4・§9・issue #309）", () => {
  it("既定は入。切るとジョブの CLI に --no-verify-terms を渡す。真偽値以外は 400", async () => {
    const { req, post, specs } = setup();
    expect((await req("/api/settings")).body.settings.verifyTerms).toBe(true);
    await post("/api/jobs", { arxivId: "2601.00001", provider: "claude" });
    expect(specs[0]).not.toContain("--no-verify-terms");

    expect((await post("/api/settings", { concurrency: 2, verifyTerms: "no" })).status).toBe(400);
    const saved = await post("/api/settings", { concurrency: 2, verifyTerms: false });
    expect(saved.body.settings.verifyTerms).toBe(false);
    await post("/api/jobs", { arxivId: "2601.00002", provider: "claude" });
    expect(specs[1]).toContain("--no-verify-terms");
    expect((await req("/api/settings")).body.settings.verifyTerms).toBe(false);
  });
});
