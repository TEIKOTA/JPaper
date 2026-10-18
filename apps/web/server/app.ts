// 契約付録 §9（Web アプリ）。core を直接呼ぶ API と、翻訳ジョブ（CLI の子プロセス）・arXiv 検索の API。
// 127.0.0.1 だけで待ち受け、認証は持たない。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { UploadWords } from "./redact-preview.js";
import { checkRedactTerms } from "../../../src/ingest/redact.js";
import { popplerTools } from "../../../src/ingest/pdf/poppler.js";
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
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, localOrigins, uploadDirOf, type WebConfig } from "./config.js";
import { ArxivClient, ArxivError, ArxivQueryError } from "./arxiv.js";
import { JobQueue } from "./jobs.js";
import {
  BOOLEAN_SETTINGS,
  emptySettings,
  notesOf,
  MAX_HISTORY,
  MAX_JOB_CONCURRENCY,
  parseSettings,
  readSettings,
  readSettingsObject,
  recordHistory,
  settingsFrom,
  writeSettings,
} from "./settings.js";
import { optionalText, parseArxivId, parseTranslateOptions, providerInfo } from "./translate-options.js";
import { displayName, MAX_UPLOAD_BYTES, readCappedBody, saveUpload, uploadFile } from "./uploads.js";
import {
  ESTIMATED_SECONDS_PER_PAGE,
  ESTIMATED_USD_PER_PAGE,
  estimatePdfRead,
  LARGE_PDF_PAGES,
  pdfPagesToRead,
} from "../../../src/ingest/pdf/index.js";
import { IMAGE_PROVIDERS } from "../../../src/providers/index.js";
import { defaultConcurrencyFor } from "../../../src/config.js";

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
  // PDF の全ページ数と、範囲を当てた後に読むページ（テスト用に差し替える）。
  pdfPages?: (file: string, spec: string | undefined) => Promise<{ total: number; pages: number[] }>;
  // アップロードした PDF の語の位置（伏せ字の範囲選択）。
  words?: UploadWords;
  // ページ画像を描く（テスト用に差し替える）。
  renderPage?: (file: string, page: number, outPrefix: string) => Promise<string>;
}

export function createServices(config: WebConfig, env: NodeJS.ProcessEnv = process.env): Services {
  const home = env.JPAPER_HOME?.trim();
  return {
    jobs: new JobQueue({
      articleDir: config.articleDir,
      repoRoot: config.repoRoot,
      redactDir: path.join(uploadDirOf(config), ".redact"),
      concurrency: () => readSettings(config.settingsPath).concurrency,
      env: { ...env, ...(home === undefined || home === "" ? {} : { JPAPER_HOME: path.resolve(home) }) },
    }),
    arxiv: new ArxivClient(),
  };
}

const TITLE_MAX = 500;

export function createApp(config: WebConfig, services: Services = createServices(config)): Hono {
  const { jobs, arxiv } = services;
  const pdfPages = services.pdfPages ?? ((file: string, spec: string | undefined) => pdfPagesToRead(file, spec));
  const uploadDir = uploadDirOf(config);
  const words = services.words ?? new UploadWords();
  const renderPage = services.renderPage ?? ((file: string, page: number, prefix: string) => popplerTools.renderPage(file, page, prefix));
  const totalOf = async (file: string): Promise<number> => (await pdfPages(file, undefined)).total;
  const pageNumber = (value: string, total: number): number => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || n < 1 || n > total) throw new JpaperError(2, "input", "ページの番号が不正です");
    return n;
  };
  const termsOf = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new JpaperError(2, "input", "terms は文字列の配列で指定してください");
    return value.length === 0 ? [] : checkRedactTerms(value);
  };
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
    // PDF のアップロードだけは application/pdf（これも単純リクエストにならない）。
    const type = c.req.path === "/api/uploads" ? "application/pdf" : "application/json";
    const sent = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (c.req.method === "POST" && sent !== type) {
      return c.json({ error: `content-type: ${type} で送ってください` }, 415);
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
        { registerGlobal: body.data.registerGlobal === true, ...notesOf(readSettings(config.settingsPath)) },
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
      maxHistory: MAX_HISTORY,
    }),
  );

  // 保存は provider・providers・concurrency・真偽値の設定を置き換え、ファイルの他のキー（history など）は残す。
  app.post("/api/settings", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => undefined);
      const { history: _h, ...parsed } = parseSettings(body);
      const raw = readSettingsObject(config.settingsPath) ?? {};
      const { provider: _p, providers: _ps, concurrency: _c, ...others } = raw;
      const rest = Object.fromEntries(
        Object.entries(others).filter(([k]) => !(BOOLEAN_SETTINGS as readonly string[]).includes(k)),
      );
      // 真偽値の設定を送らない保存（古い画面）は、保存済みの値を残す。
      const saved = settingsFrom(raw);
      for (const key of BOOLEAN_SETTINGS) {
        if (typeof body !== "object" || body === null || !Object.hasOwn(body, key)) parsed[key] = saved[key];
      }
      writeSettings(config.settingsPath, { ...rest, ...parsed });
      jobs.pump();
      return c.json({ settings: { ...parsed, history: settingsFrom(raw).history } });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // history だけを消す。ファイルを読めなければ書かずに 409。
  app.post("/api/settings/history/clear", (c) => {
    try {
      const raw = readSettingsObject(config.settingsPath);
      if (raw === undefined) {
        throw new JpaperError(2, "conflict", "設定ファイル（web-settings.json）を読めないため、候補を消せません");
      }
      const next = { ...raw, history: {} };
      writeSettings(config.settingsPath, next);
      return c.json({ settings: settingsFrom(next) });
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

  // アップロードした PDF のページ画像（作業フォルダに描いて置く）。契約付録 §9（伏せ字の範囲選択）
  app.get("/api/uploads/:id/pages/:page/image", async (c) => {
    try {
      const { id, file } = uploadFile(uploadDir, c.req.param("id"));
      const page = pageNumber(c.req.param("page"), await totalOf(file));
      const dir = path.join(uploadDir, `${id}.pages`);
      const png = path.join(dir, `p-${String(page)}.png`);
      if (!existsSync(png)) {
        mkdirSync(dir, { recursive: true });
        const tmp = await renderPage(file, page, path.join(dir, `.p-${String(page)}-${randomBytes(6).toString("hex")}`));
        renameSync(tmp, png);
      }
      return c.body(readFileSync(png), 200, { "content-type": "image/png", "cache-control": "private, max-age=3600" });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // ページの寸法（pt）と語の矩形。
  app.get("/api/uploads/:id/pages/:page/words", async (c) => {
    try {
      const { id, file } = uploadFile(uploadDir, c.req.param("id"));
      const total = await totalOf(file);
      return c.json(await words.page(id, file, pageNumber(c.req.param("page"), total), total));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // 語ごとの当たりの数と当たったページ。page を付ければ、そのページで白く塗る矩形も返す。
  app.post("/api/uploads/:id/matches", async (c) => {
    try {
      const { id, file } = uploadFile(uploadDir, c.req.param("id"));
      const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      if (typeof body !== "object" || body === null) throw new JpaperError(2, "input", "JSON で送ってください");
      const terms = termsOf(body.terms);
      const total = await totalOf(file);
      const page = body.page === undefined ? undefined : pageNumber(String(body.page), total);
      return c.json({
        total,
        ...(await words.matches(id, file, total, terms)),
        ...(page === undefined ? {} : { page, ...(await words.boxes(id, file, total, page, terms)) }),
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // PDF を受け取り、内容のハッシュの名前で作業フォルダに置く。契約付録 §9（PDF のアップロード）
  app.post("/api/uploads", async (c) => {
    try {
      const body = await readCappedBody(c.req.raw, config.maxUploadBytes ?? MAX_UPLOAD_BYTES);
      const { id, file, created } = saveUpload(uploadDir, body);
      let total: number;
      try {
        ({ total } = await pdfPages(file, undefined));
      } catch (e) {
        // 読めない PDF は、この要求で書いたものなら残さない。
        if (created) rmSync(file, { force: true });
        throw e;
      }
      const name = displayName(c.req.header("x-jpaper-filename")) ?? `${id}.pdf`;
      return c.json({ upload: { id, name, pages: total, bytes: body.length } }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/jobs", async (c) => {
    try {
      const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      if (typeof body !== "object" || body === null) throw new JpaperError(2, "input", "JSON で送ってください");
      const options = parseTranslateOptions(body);
      // 伏せ字の語（arXiv・PDF のどちらのジョブにも付けられる）。契約付録 §9（伏せ字の範囲選択）
      const redact = body.redact === undefined ? undefined : termsOf(body.redact);
      const saved = readSettings(config.settingsPath);
      const jobOptions = {
        ...options,
        ...(saved.verifyTerms ? {} : { verifyTerms: false as const }),
        ...notesOf(saved),
      };
      let job;
      if (body.upload !== undefined) {
        // PDF 入力: 画像を渡せる provider だけ。100 ページ超は同意（confirmLarge）が要る。契約付録 §8・§9
        const { id, file } = uploadFile(uploadDir, body.upload);
        if (!IMAGE_PROVIDERS.includes(options.provider)) {
          throw new JpaperError(2, "input", `PDF の入力は ${IMAGE_PROVIDERS.join("・")} だけで読めます`);
        }
        const pages = optionalText(body.pages, "ページの範囲");
        const selected = await pdfPages(file, pages);
        if (selected.pages.length > LARGE_PDF_PAGES && body.confirmLarge !== true) {
          const concurrency = defaultConcurrencyFor(options.provider);
          return c.json(
            {
              error: `この PDF は ${String(selected.pages.length)} ページ読みます。確かめてから始めてください`,
              kind: "confirm-large",
              total: selected.total,
              pages: selected.pages.length,
              estimate: estimatePdfRead(selected.pages.length, concurrency),
              perPage: { usd: ESTIMATED_USD_PER_PAGE, seconds: ESTIMATED_SECONDS_PER_PAGE, concurrency },
            },
            409,
          );
        }
        const name = typeof body.name === "string" ? (displayName(encodeURIComponent(body.name)) ?? `${id}.pdf`) : `${id}.pdf`;
        job = jobs.enqueue({
          pdf: {
            id,
            file,
            name,
            ...(pages === undefined ? {} : { pages }),
            ...(selected.pages.length > LARGE_PDF_PAGES ? { yes: true } : {}),
          },
          options: jobOptions,
          ...(redact === undefined || redact.length === 0 ? {} : { redact }),
        });
      } else {
        const arxivId = parseArxivId(body.arxivId);
        const title =
          typeof body.title === "string"
            ? body.title.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, TITLE_MAX) || undefined
            : undefined;
        job = jobs.enqueue({
          arxivId,
          options: jobOptions,
          ...(title === undefined ? {} : { title }),
          ...(redact === undefined || redact.length === 0 ? {} : { redact }),
        });
      }
      try {
        const raw = readSettingsObject(config.settingsPath);
        if (raw === undefined) throw new Error("設定ファイル（web-settings.json）を読めません");
        const before = settingsFrom(raw).history;
        const after = recordHistory({ ...emptySettings(), history: before }, options).history;
        if (JSON.stringify(after) !== JSON.stringify(before)) writeSettings(config.settingsPath, { ...raw, history: after });
      } catch (e) {
        console.error(`model・effort の候補を保存できません: ${e instanceof Error ? e.message : String(e)}`);
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
