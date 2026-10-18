// 契約付録 §9（Web アプリ）。翻訳フォームの初期値・並行数・model と effort の履歴を JPAPER_HOME/web-settings.json に置く。
// フォームの初期値はコードに持たない（未設定なら空）。空の model・effort は translatePaper の既定（契約付録 §5）で埋まる。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Provider } from "../../../src/types/contract.js";
import { JpaperError } from "../../../src/types/errors.js";
import { parseProvider, parseTranslateOptions } from "./translate-options.js";

export const SETTINGS_FILE = "web-settings.json";
export const MAX_JOB_CONCURRENCY = 4;
export const DEFAULT_JOB_CONCURRENCY = 1;
export const MAX_HISTORY = 10;

export interface ProviderDefaults {
  model?: string;
  effort?: string;
}

// 翻訳を始めた model・effort（新しい順、MAX_HISTORY 件まで）。
export interface ProviderHistory {
  models: string[];
  efforts: string[];
}

export interface WebSettings {
  provider?: Provider;
  providers: Partial<Record<Provider, ProviderDefaults>>;
  concurrency: number;
  // 用語を Web 検索で確かめる（claude・GPT）。既定 true。契約付録 §4・§9
  verifyTerms: boolean;
  // 訳注を PDF の各ページの脚注・最後の一覧に載せる。既定 true。契約付録 §8・§9
  pageNotes: boolean;
  endNotes: boolean;
  history: Partial<Record<Provider, ProviderHistory>>;
}

export function emptySettings(): WebSettings {
  return { providers: {}, concurrency: DEFAULT_JOB_CONCURRENCY, verifyTerms: true, pageNotes: true, endNotes: true, history: {} };
}

function isConcurrency(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_JOB_CONCURRENCY;
}

// ファイルの JSON オブジェクト。ファイルが無ければ {}。読めない・JSON のオブジェクトでなければ undefined。
export function readSettingsObject(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? {} : undefined;
  }
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// 検査に通らない項目は捨てて読む。
export function settingsFrom(raw: Record<string, unknown>): WebSettings {
  try {
    return { ...parseSettings(raw, true), history: parseHistory(raw.history) };
  } catch {
    return emptySettings();
  }
}

// ファイルが無い・壊れているときは空。
export function readSettings(file: string): WebSettings {
  const raw = readSettingsObject(file);
  return raw === undefined ? emptySettings() : settingsFrom(raw);
}

// 真偽値の設定（POST /api/settings で送らなければ保存済みの値を残す）。
export const BOOLEAN_SETTINGS = ["verifyTerms", "pageNotes", "endNotes"] as const;

// 止めた訳注の描画だけを false で返す（ジョブの引数・用語集の組み直しに渡す）。
export function notesOf(s: WebSettings): { pageNotes?: false; endNotes?: false } {
  return { ...(s.pageNotes ? {} : { pageNotes: false }), ...(s.endNotes ? {} : { endNotes: false }) };
}

// 履歴は読むときだけ検査する。検査に通らない値・重複は捨て、MAX_HISTORY 件で切る。
export function parseHistory(raw: unknown): WebSettings["history"] {
  const out: WebSettings["history"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    let provider: Provider;
    try {
      provider = parseProvider(name);
    } catch {
      continue;
    }
    const v = (typeof value === "object" && value !== null ? value : {}) as { models?: unknown; efforts?: unknown };
    const pick = (list: unknown, key: "model" | "effort"): string[] => {
      const kept: string[] = [];
      for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
        try {
          const opts = parseTranslateOptions({ provider, [key]: item });
          const s = opts[key];
          if (s !== undefined && !kept.includes(s)) kept.push(s);
        } catch {
          // 捨てる
        }
        if (kept.length === MAX_HISTORY) break;
      }
      return kept;
    };
    const h = { models: pick(v.models, "model"), efforts: pick(v.efforts, "effort") };
    if (h.models.length > 0 || h.efforts.length > 0) out[provider] = h;
  }
  return out;
}

// 指定された model・effort を provider の履歴の先頭に置く（重複は前から除き、MAX_HISTORY 件で切る）。どちらも無ければそのまま。
export function recordHistory(
  settings: WebSettings,
  opts: { provider: Provider; model?: string; effort?: string },
): WebSettings {
  if (opts.model === undefined && opts.effort === undefined) return settings;
  const prev = settings.history[opts.provider] ?? { models: [], efforts: [] };
  const front = (list: string[], v: string | undefined): string[] =>
    v === undefined ? list : [v, ...list.filter((x) => x !== v)].slice(0, MAX_HISTORY);
  return {
    ...settings,
    history: {
      ...settings.history,
      [opts.provider]: { models: front(prev.models, opts.model), efforts: front(prev.efforts, opts.effort) },
    },
  };
}

// lenient: 検査に通らない項目を捨てる（読み込み）。false なら入力の誤りとして投げる（保存）。
export function parseSettings(body: unknown, lenient = false): WebSettings {
  if (typeof body !== "object" || body === null) throw new JpaperError(2, "input", "設定を JSON で送ってください");
  const b = body as { provider?: unknown; providers?: unknown; concurrency?: unknown } & Partial<
    Record<(typeof BOOLEAN_SETTINGS)[number], unknown>
  >;
  const attempt = <T>(fn: () => T): T | undefined => {
    if (!lenient) return fn();
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const out = emptySettings();
  if (b.provider !== undefined && b.provider !== null && b.provider !== "") {
    const p = attempt(() => parseProvider(b.provider));
    if (p !== undefined) out.provider = p;
  }
  if (b.concurrency !== undefined) {
    if (isConcurrency(b.concurrency)) out.concurrency = b.concurrency;
    else if (!lenient) {
      throw new JpaperError(2, "input", `並行数は 1〜${String(MAX_JOB_CONCURRENCY)} で指定してください`);
    }
  }
  for (const key of BOOLEAN_SETTINGS) {
    const v = b[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[key] = v;
    else if (!lenient) throw new JpaperError(2, "input", `${key} は true か false で指定してください`);
  }
  if (b.providers !== undefined && b.providers !== null) {
    if (typeof b.providers !== "object") {
      if (!lenient) throw new JpaperError(2, "input", "providers の形が不正です");
    } else {
      for (const [name, value] of Object.entries(b.providers as Record<string, unknown>)) {
        const d = attempt(() => providerDefaults(name, value));
        if (d !== undefined && (d.defaults.model !== undefined || d.defaults.effort !== undefined)) {
          out.providers[d.provider] = d.defaults;
        }
      }
    }
  }
  return out;
}

function providerDefaults(name: string, value: unknown): { provider: Provider; defaults: ProviderDefaults } {
  const provider = parseProvider(name);
  const v = (typeof value === "object" && value !== null ? value : {}) as { model?: unknown; effort?: unknown };
  const opts = parseTranslateOptions({ provider, model: v.model, effort: v.effort });
  return {
    provider,
    defaults: {
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.effort === undefined ? {} : { effort: opts.effort }),
    },
  };
}

// value を一時ファイルへ書いてから rename する。失敗したら一時ファイルを消して投げる。
export function writeSettings(file: string, value: object): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
