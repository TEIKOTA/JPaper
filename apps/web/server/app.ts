// 契約付録 §9（Web アプリ）。core を直接呼ぶ API。127.0.0.1 だけで待ち受け、認証は持たない。
import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { JpaperError } from "../../../src/types/errors.js";
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
import type { WebConfig } from "./config.js";

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

export function createApp(config: WebConfig): Hono {
  const app = new Hono();

  // Host・Origin が 127.0.0.1・localhost 以外の要求は 403。契約付録 §9
  app.use("/api/*", async (c, next) => {
    const host = hostnameOf(c.req.header("host"));
    if (host !== undefined && !LOCAL_HOSTS.has(host)) return c.json({ error: "許可されていないホストです" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !LOCAL_HOSTS.has(hostnameOf(origin) ?? "")) {
      return c.json({ error: "許可されていないオリジンです" }, 403);
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

  app.get("/api/glossary", (c) => {
    try {
      return c.json({ terms: withDb((db) => globalTerms(db, config.articleDir, config.cacheKey)) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return app;
}
