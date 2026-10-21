import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { ArxivClient } from "./arxiv.js";
import { configFromEnv, uploadDirOf } from "./config.js";
import { JobQueue, type JobRunner, type ProcessExit } from "./jobs.js";
import { readSettings } from "./settings.js";
import { parsePageRange } from "../../../src/ingest/pdf/text-layer.js";
import { JpaperError } from "../../../src/types/errors.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-web-upload-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOST = { host: "127.0.0.1:5174" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
const PDF = (text: string): Buffer => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`);

function setup(opts: { totalPages?: number; maxUploadBytes?: number; unreadable?: boolean } = {}) {
  const root = tmp();
  const articleDir = path.join(root, "article");
  const settingsPath = path.join(root, "home", "web-settings.json");
  const specs: string[][] = [];
  const exits: ((e: ProcessExit) => void)[] = [];
  const runner: JobRunner = (spec) => {
    specs.push(spec.args);
    return { done: new Promise<ProcessExit>((r) => exits.push(r)), kill: () => {} };
  };
  const config = {
    articleDir,
    dbPath: path.join(root, "glossary.db"),
    settingsPath,
    repoRoot: root,
    ...(opts.maxUploadBytes === undefined ? {} : { maxUploadBytes: opts.maxUploadBytes }),
  };
  const jobs = new JobQueue({ articleDir, repoRoot: root, concurrency: () => readSettings(settingsPath).concurrency, runner });
  const total = opts.totalPages ?? 3;
  const app = createApp(config, {
    jobs,
    arxiv: new ArxivClient({ sleep: async () => {}, fetchImpl: (() => Promise.reject(new Error("no"))) as unknown as typeof fetch }),
    pdfPages: (_file, spec) =>
      opts.unreadable === true
        ? Promise.reject(new JpaperError(2, "input", "pdfinfo が PDF を読めません"))
        : Promise.resolve({
        total,
        pages: spec === undefined ? Array.from({ length: total }, (_, i) => i + 1) : parsePageRange(spec, total),
      }),
  });
  const upload = async (body: Buffer, headers: Record<string, string> = {}) => {
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { ...HOST, "content-type": "application/pdf", ...headers },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = async (url: string, body: unknown) => {
    const res = await app.request(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const uploadDir = path.join(root, "home", "web-uploads");
  return { upload, post, specs, exits, jobs, uploadDir, articleDir };
}

describe("PDF のアップロード（契約付録 §9）", () => {
  it("内容のハッシュの名前で作業フォルダに置き、元のファイル名とページ数を返す", async () => {
    const t = setup({ totalPages: 7 });
    const r = await t.upload(PDF("a"), { "x-jpaper-filename": encodeURIComponent("論文 (1).pdf") });
    expect(r.status).toBe(201);
    expect(r.body.upload).toMatchObject({ name: "論文 (1).pdf", pages: 7 });
    expect(r.body.upload.id).toMatch(/^[0-9a-f]{16}$/);
    expect(readdirSync(t.uploadDir)).toEqual([`${r.body.upload.id as string}.pdf`]);
    // 同じ内容は同じ ID。
    expect((await t.upload(PDF("a"))).body.upload.id).toBe(r.body.upload.id);
  });

  it("上限を超える・先頭が %PDF- でない入力は、保存せずに弾く", async () => {
    const t = setup({ maxUploadBytes: 64 });
    const big = await t.upload(Buffer.concat([PDF("x"), Buffer.alloc(100)]));
    expect(big.status).toBe(400);
    expect(big.body.error).toContain("上限");
    const notPdf = await t.upload(Buffer.from("<html>not a pdf</html>"));
    expect(notPdf.status).toBe(400);
    expect(notPdf.body.error).toContain("%PDF-");
    expect(existsSync(t.uploadDir) ? readdirSync(t.uploadDir) : []).toEqual([]);
  });

  it("pdfinfo で読めない PDF は 400 で、作業フォルダに残さない", async () => {
    const t = setup({ unreadable: true });
    const r = await t.upload(PDF("broken"));
    expect(r.status).toBe(400);
    expect(existsSync(t.uploadDir) ? readdirSync(t.uploadDir) : []).toEqual([]);
  });

  it("content-type が application/pdf でなければ 415", async () => {
    const t = setup();
    const r = await t.upload(PDF("a"), { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });
});

describe("PDF の翻訳ジョブ（契約付録 §9）", () => {
  it("出力先にコピーした PDF を CLI に渡し、範囲は --pages に載せる", async () => {
    const t = setup({ totalPages: 10 });
    const id = (await t.upload(PDF("b"))).body.upload.id as string;
    const r = await t.post("/api/jobs", { upload: id, name: "book.pdf", pages: "2-4", provider: "claude" });
    expect(r.status).toBe(201);
    expect(r.body.job).toMatchObject({ label: "book.pdf", paperId: id, pdf: { name: "book.pdf", pages: "2-4" } });
    const copied = path.join(t.articleDir, `${id}-ja`, "source", `${id}.pdf`);
    expect(readFileSync(copied)).toEqual(PDF("b"));
    const args = t.specs[0]!;
    expect(args[2]).toBe(copied);
    expect(args).toContain("--pages");
    expect(args[args.indexOf("--pages") + 1]).toBe("2-4");
    expect(args).not.toContain("--yes");
  });

  it("100 ページを超えると、同意が無ければジョブを始めずに 409 で目安を返し、同意があれば --yes を付ける", async () => {
    const t = setup({ totalPages: 250 });
    const id = (await t.upload(PDF("c"))).body.upload.id as string;
    const ask = await t.post("/api/jobs", { upload: id, provider: "claude" });
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ kind: "confirm-large", total: 250, pages: 250 });
    expect(ask.body.estimate.usd).toBeGreaterThan(0);
    expect(t.specs).toHaveLength(0);
    expect(t.jobs.list()).toHaveLength(0);
    // 範囲で 100 ページ以下に絞れば同意は要らない。
    const narrow = await t.post("/api/jobs", { upload: id, provider: "claude", pages: "1-100" });
    expect(narrow.status).toBe(201);
    t.exits[0]!({ code: 0, signal: null });
    await t.jobs.idle();
    const ok = await t.post("/api/jobs", { upload: id, provider: "claude", confirmLarge: true });
    expect(ok.status).toBe(201);
    expect(t.specs[1]).toContain("--yes");
  });

  it("画像を渡せない provider・不正な ID・範囲は 400 でジョブを始めない", async () => {
    const t = setup({ totalPages: 5 });
    const id = (await t.upload(PDF("d"))).body.upload.id as string;
    for (const bad of [
      { upload: id, provider: "ollama" },
      { upload: "../../etc/passwd", provider: "claude" },
      { upload: "0123456789abcdef", provider: "claude" },
      { upload: id, provider: "claude", pages: "3-9" },
      { upload: id, provider: "claude", pages: "--out" },
    ]) {
      expect((await t.post("/api/jobs", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(t.specs).toHaveLength(0);
  });

  it("起動のときに PDF をコピーできなければ、CLI を起動せずに failed にする", async () => {
    const t = setup();
    const a = (await t.upload(PDF("e"))).body.upload.id as string;
    const b = (await t.upload(PDF("f"))).body.upload.id as string;
    expect((await t.post("/api/jobs", { upload: a, provider: "claude" })).status).toBe(201);
    // 並行数 1 なので b は待機中。起動の前に作業フォルダの PDF が消える。
    expect((await t.post("/api/jobs", { upload: b, provider: "claude" })).body.job.state).toBe("queued");
    rmSync(path.join(t.uploadDir, `${b}.pdf`));
    t.exits[0]!({ code: 0, signal: null });
    await t.jobs.idle();
    const job = t.jobs.list().find((j) => j.paperId === b)!;
    expect(job.state).toBe("failed");
    expect(job.error).toContain("コピーできませんでした");
    expect(t.specs).toHaveLength(1);
  });

  it("作業フォルダの既定は設定ファイルと同じフォルダの web-uploads/", () => {
    const h = path.resolve("/h");
    expect(uploadDirOf(configFromEnv({ JPAPER_HOME: h }, path.resolve("/w")))).toBe(path.join(h, "web-uploads"));
  });
});
