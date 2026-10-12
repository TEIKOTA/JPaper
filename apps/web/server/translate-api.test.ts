import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { ArxivClient } from "./arxiv.js";
import { ATOM } from "./arxiv.fixtures.js";
import { configFromEnv } from "./config.js";
import { JobQueue, type JobRunner, type ProcessExit } from "./jobs.js";
import { readSettings } from "./settings.js";

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
  const runner: JobRunner = (spec) => {
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
  return { app, req, post, settingsPath, kills, exits, urls };
}

describe("設定 API（契約付録 §9）", () => {
  it("未設定なら provider・model・effort は空、並行数は 1。provider の一覧と effort の可否を返す", async () => {
    const { req } = setup();
    const { status, body } = await req("/api/settings");
    expect(status).toBe(200);
    expect(body).toEqual({
      settings: { providers: {}, concurrency: 1 },
      providers: [
        { name: "ollama", effort: false },
        { name: "claude", effort: true },
        { name: "codex", effort: true },
        { name: "openrouter", effort: false },
      ],
      maxConcurrency: 4,
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
    const want = { provider: "claude", providers: { claude: { model: "sonnet", effort: "medium" } }, concurrency: 2 };
    expect(saved.body.settings).toEqual(want);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(want);
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
    expect(readSettings(file)).toEqual({ providers: {}, concurrency: 1 });
    writeFileSync(
      file,
      JSON.stringify({ provider: "nope", concurrency: 9, providers: { ollama: { model: "m", effort: "x" }, claude: { model: "opus" } } }),
    );
    expect(readSettings(file)).toEqual({ providers: { claude: { model: "opus" } }, concurrency: 1 });
    expect(readSettings(path.join(root, "none.json"))).toEqual({ providers: {}, concurrency: 1 });
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
