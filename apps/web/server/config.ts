// 契約付録 §9（Web アプリ）。データの場所は CLI と同じ既定で、環境変数で変えられる。
import path from "node:path";
import { dbPath } from "../../../src/config.js";
import type { LatexRunner } from "../../../src/tools/build-gate.js";

export const DEFAULT_API_PORT = 5174;
export const DEFAULT_WEB_PORT = 5173;
export const HOST = "127.0.0.1";

export interface WebConfig {
  // 論文ごとの出力（<ID>-ja/）を並べたフォルダ。
  articleDir: string;
  // 全体の用語 DB。
  dbPath: string;
  // checkpoint の署名鍵（テスト用。既定は JPAPER_HOME の鍵）。
  cacheKey?: Buffer;
  latexRunner?: LatexRunner;
  // 要求を受け付ける Origin（scheme・host・port の完全一致）。既定は既定ポートの画面と API。
  origins?: string[];
}

// 画面（Vite）と API のポートについて、127.0.0.1・localhost の Origin を並べる。
export function localOrigins(webPort: number, apiPort: number): string[] {
  return [webPort, apiPort].flatMap((p) => [`http://127.0.0.1:${String(p)}`, `http://localhost:${String(p)}`]);
}

function portFrom(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): WebConfig {
  const article = env.JPAPER_ARTICLE_DIR?.trim();
  const db = env.JPAPER_GLOSSARY_DB?.trim();
  return {
    articleDir: path.resolve(cwd, article === undefined || article === "" ? "article" : article),
    dbPath: db === undefined || db === "" ? dbPath() : path.resolve(cwd, db),
    origins: localOrigins(portFrom(env.JPAPER_WEB_PORT, DEFAULT_WEB_PORT), apiPortFromEnv(env)),
  };
}

export function apiPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return portFrom(env.JPAPER_WEB_API_PORT, DEFAULT_API_PORT);
}
