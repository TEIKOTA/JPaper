// 契約付録 §9（Web アプリ）。翻訳フォームの初期値と並行数を JPAPER_HOME/web-settings.json に置く。
// provider・model・effort の既定値はコードに持たない（未設定なら空）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Provider } from "../../../src/types/contract.js";
import { JpaperError } from "../../../src/types/errors.js";
import { parseProvider, parseTranslateOptions } from "./translate-options.js";

export const SETTINGS_FILE = "web-settings.json";
export const MAX_JOB_CONCURRENCY = 4;
export const DEFAULT_JOB_CONCURRENCY = 1;

export interface ProviderDefaults {
  model?: string;
  effort?: string;
}

export interface WebSettings {
  provider?: Provider;
  providers: Partial<Record<Provider, ProviderDefaults>>;
  concurrency: number;
}

export function emptySettings(): WebSettings {
  return { providers: {}, concurrency: DEFAULT_JOB_CONCURRENCY };
}

function isConcurrency(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_JOB_CONCURRENCY;
}

// 検査に通らない項目は捨てて読む（ファイルが無い・壊れているときは空）。
export function readSettings(file: string): WebSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return emptySettings();
  }
  if (typeof raw !== "object" || raw === null) return emptySettings();
  try {
    return parseSettings(raw, true);
  } catch {
    return emptySettings();
  }
}

// lenient: 検査に通らない項目を捨てる（読み込み）。false なら入力の誤りとして投げる（保存）。
export function parseSettings(body: unknown, lenient = false): WebSettings {
  if (typeof body !== "object" || body === null) throw new JpaperError(2, "input", "設定を JSON で送ってください");
  const b = body as { provider?: unknown; providers?: unknown; concurrency?: unknown };
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

export function writeSettings(file: string, settings: WebSettings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}
