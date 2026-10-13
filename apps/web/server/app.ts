// 契約付録 §9（Web アプリ）。core を直接呼ぶ API と、翻訳ジョブ（CLI の子プロセス）・arXiv 検索の API。
// 127.0.0.1 だけで待ち受け、認証は持たない。
import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { JpaperError } from "../../../src/types/errors.js";
import { derivePaperId } from "../../../src/ingest/index.js";
import { GlossaryDb } from "../../../src/terminology/db.js";
import {
  applyTermEdit,
  loadPaperState,
  planTermEdit,
  readBackupInfo,
  undoTermEdit,
} from "../../../src/workflows/glossary-edit.js";
import {
  affectedPapers,
  globalTerms,
  glossaryRows,
  listPapers,
  paperDirs,
  paperTitles,
  pdfPath,
  type PdfKind,
} from "./catalog.js";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, localOrigins, type WebConfig } from "./config.js";
import { ArxivClient, ArxivError, ArxivQueryError } from "./arxiv.js";
import { JobQueue } from "./jobs.js";
import { MAX_JOB_CONCURRENCY, parseSettings, readSettings, recordHistory, writeSettings } from "./settings.js";
import { parseArxivId, parseTranslateOptions, providerInfo } from "./translate-options.js";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const EditBody = z.object({ src: z.string().min(1), ja: z.string() });
const ApplyBody = EditBody.extend({ registerGlobal: z.boolean().optional() });

function hostnameOf(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof JpaperError) {
    const status = e.kind === "conflict" ? 409 : e.code === 2 ? 400 : 500;
    return c.json({ error: e.message, kind: e.kind }, status);
  }
  return c.json({ error: e instanceof Error ? e.message : String(e), kind: "internal" }, 500);
}

export interface Services {
  jobs: JobQueue;
  arxiv: ArxivClient;
}

export function createServices(config: WebConfig, env: NodeJS.ProcessEnv = process.env): Services {
  const home = env.JPAPER_HOME?.trim();
  return {
    jobs: new JobQueue({
      articleDir: config.articleDir,
      repoRoot: config.repoRoot,
      concurrency: () => readSettings(config.settingsPath).concurrency,
      env: { ...env, ...(home === undefined || home === "" ? {} : { JPAPER_HOME: path.resolve(home) }) },
    }),
    arxiv: new ArxivClient(),
  };
}

const TITLE_MAX = 500;

export function createApp(config: WebConfig, services: Services = createServices(config)): Hono {
  const { jobs, arxiv } = services;
  const app = new Hono();

  // Host が 127.0.0.1・localhost 以外、Origin が画面・API のポート以外の要求は 403。
  // 書き込み（POST）は JSON だけを受け付け、別オリジンからの単純リクエスト（プリフライトなし）を通さない。契約付録 §9
  const origins = new Set(config.origins ?? localOrigins(DEFAULT_WEB_PORT, DEFAULT_API_PORT));
  app.use("/api/*", async (c, next) => {
    const host = hostnameOf(c.req.header("host"));
    if (host !== undefined && !LOCAL_HOSTS.has(host)) return c.json({ error: "許可されていないホストです" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) {
      return c.json({ error: "許可されていないオリジンです" }, 403);
    }
    if (c.req.method === "POST" && !/^application\/json(\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: "content-type: application/json で送ってください" }, 415);
    }
    await next();
  });

  const withDb = <T>(fn: (db: GlossaryDb) => T): T => {
    const db = new GlossaryDb(config.dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const dirOf = (id: string): string => {
    const dir = paperDirs(config.articleDir).get(id);
    if (dir === undefined) throw new JpaperError(2, "input", `論文 ${id} が見つかりません`);
    return dir;
  };

  const editDeps = () => ({
    dbPath: config.dbPath,
    ...(config.cacheKey === undefined ? {} : { cacheKey: config.cacheKey }),
    ...(config.latexRunner === undefined ? {} : { latexRunner: config.latexRunner }),
  });

  app.get("/api/config", (c) => c.json({ articleDir: config.articleDir, dbPath: config.dbPath }));

  app.get("/api/papers", (c) => c.json({ papers: listPapers(config.articleDir, config.cacheKey) }));

  app.get("/api/papers/:id", (c) => {
    try {
      const id = c.req.param("id");
      const dir = dirOf(id);
      return c.json({
        id,
        ...paperTitles(dir, config.cacheKey),
        pdf: { ja: pdfPath(dir, "ja") !== undefined, bilingual: pdfPath(dir, "bilingual") !== undefined },
        terms: withDb((db) => glossaryRows(dir, db)),
        backup: readBackupInfo(dir) ?? null,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/papers/:id/pdf/:kind", (c) => {
    try {
      const kind = c.req.param("kind");
      if (kind !== "ja" && kind !== "bilingual") throw new JpaperError(2, "input", "PDF の種類が不正です");
      const file = pdfPath(dirOf(c.req.param("id")), kind as PdfKind);
      if (file === undefined) return c.json({ error: "PDF がありません" }, 404);
      return c.body(readFileSync(file), 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${path.basename(file)}"`,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/papers/:id/preview", async (c) => {
    try {
      const body = EditBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new JpaperError(2, "input", "src と ja を指定してください");
      const plan = planTermEdit(loadPaperState(dirOf(c.req.param("id")), config.cacheKey), body.data.src, body.data.ja);
      const { writes: _writes, ...view } = plan;
      return c.json(view);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/papers/:id/apply", async (c) => {
    try {
      const id = c.req.param("id");
      const body = ApplyBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new JpaperError(2, "input", "src と ja を指定してください");
      const out = await applyTermEdit(
        dirOf(id),
        body.data.src,
        body.data.ja,
        { registerGlobal: body.data.registerGlobal === true },
        editDeps(),
      );
      const affected = out.registered
        ? affectedPapers(config.articleDir, body.data.src, out.plan.newForm, id, config.cacheKey)
        : [];
      return c.json({
        replaced: out.plan.replaced,
        shielded: out.plan.shielded,
        oldForm: out.plan.oldForm,
        newForm: out.plan.newForm,
        registered: out.registered,
        bilingualStatus: out.bilingualStatus,
        pdf: { ja: out.pdf !== undefined, bilingual: out.bilingualPdf !== undefined },
        notices: out.notices,
        affected,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/papers/:id/undo", (c) => {
    try {
      return c.json({ undone: undoTermEdit(dirOf(c.req.param("id"))) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/settings", (c) =>
    c.json({
      settings: readSettings(config.settingsPath),
      providers: providerInfo(),
      maxConcurrency: MAX_JOB_CONCURRENCY,
    }),
  );

  app.post("/api/settings", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => undefined);
      const settings = { ...parseSettings(body), history: readSettings(config.settingsPath).history };
      writeSettings(config.settingsPath, settings);
      jobs.pump();
      return c.json({ settings });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/settings/history/clear", (c) => {
    try {
      const settings = { ...readSettings(config.settingsPath), history: {} };
      writeSettings(config.settingsPath, settings);
      return c.json({ settings });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/arxiv", async (c) => {
    try {
      const result = await arxiv.search(c.req.query("q") ?? "");
      const local = paperDirs(config.articleDir);
      const active = jobs.activePapers();
      return c.json({
        ...(result.total === undefined ? {} : { total: result.total }),
        entries: result.entries.map((e) => {
          const paperId = derivePaperId({ kind: "arxiv", id: e.id });
          const dir = local.get(paperId);
          return {
            ...e,
            paperId,
            local: dir === undefined ? null : { pdf: pdfPath(dir, "ja") !== undefined },
            job: active.get(paperId) ?? null,
          };
        }),
      });
    } catch (e) {
      if (e instanceof ArxivQueryError) return c.json({ error: e.message, kind: "input" }, 400);
      if (e instanceof ArxivError) return c.json({ error: e.message, kind: "upstream" }, 502);
      return errorResponse(c, e);
    }
  });

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list() }));

  app.post("/api/jobs", async (c) => {
    try {
      const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      if (typeof body !== "object" || body === null) throw new JpaperError(2, "input", "JSON で送ってください");
      const arxivId = parseArxivId(body.arxivId);
      const options = parseTranslateOptions(body);
      const title =
        typeof body.title === "string"
          ? body.title.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, TITLE_MAX) || undefined
          : undefined;
      const job = jobs.enqueue({ arxivId, options, ...(title === undefined ? {} : { title }) });
      try {
        writeSettings(config.settingsPath, recordHistory(readSettings(config.settingsPath), options));
      } catch (e) {
        console.error(`model・effort の履歴を保存できません: ${e instanceof Error ? e.message : String(e)}`);
      }
      return c.json({ job }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/jobs/:id/cancel", (c) => {
    try {
      const job = jobs.cancel(c.req.param("id"));
      if (job === undefined) return c.json({ error: "ジョブが見つかりません" }, 404);
      return c.json({ job });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/glossary", (c) => {
    try {
      return c.json({ terms: withDb((db) => globalTerms(db, config.articleDir, config.cacheKey)) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return app;
}
