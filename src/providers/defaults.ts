// 契約付録 §5（claude・codex の既定の model・effort）。ADR 20261013。
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeConfig, CodexConfig } from "../config.js";
import type { Provider } from "../types/contract.js";

// claude CLI の別名。最新の Sonnet に解決される。
export const DEFAULT_CLAUDE_MODEL = "sonnet";
export const DEFAULT_EFFORT = "medium";

const SOL = /^gpt-(\d+(?:\.\d+)*)-sol$/;

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// codex のモデル一覧（models_cache.json の中身）から、一覧に出す（visibility が list の）Sol 系のうち版が最も新しいもの。
export function latestSolModel(cacheJson: string): string | undefined {
  let models: unknown;
  try {
    models = (JSON.parse(cacheJson) as { models?: unknown }).models;
  } catch {
    return undefined;
  }
  if (!Array.isArray(models)) return undefined;
  let best: { slug: string; version: string } | undefined;
  for (const m of models as unknown[]) {
    if (typeof m !== "object" || m === null) continue;
    const { slug, visibility } = m as { slug?: unknown; visibility?: unknown };
    if (typeof slug !== "string" || visibility !== "list") continue;
    const hit = SOL.exec(slug);
    if (hit === null) continue;
    if (best === undefined || compareVersions(hit[1]!, best.version) > 0) best = { slug, version: hit[1]! };
  }
  return best?.slug;
}

const MAX_MODEL_CACHE_BYTES = 8 * 1024 * 1024;

// codex が保存しているモデル一覧。CODEX_HOME が相対パス・普通のファイルでない・上限を超える・読めないなら undefined。
export function readCodexModelCache(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = os.homedir,
): string | undefined {
  try {
    const given = env.CODEX_HOME;
    if (given !== undefined && given !== "" && !path.isAbsolute(given)) return undefined;
    const dir = given !== undefined && given !== "" ? given : path.join(home(), ".codex");
    const file = path.join(dir, "models_cache.json");
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_MODEL_CACHE_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export interface ResolvedCliConfig {
  claude?: ClaudeConfig;
  codex?: CodexConfig;
  warning?: string;
}

// 未指定の model・effort を既定で埋める。明示した値はそのまま使う。
export function withCliDefaults(
  provider: Provider,
  cfg: { claude?: ClaudeConfig; codex?: CodexConfig },
  readCodexModels: () => string | undefined = readCodexModelCache,
): ResolvedCliConfig {
  if (provider === "claude") {
    return {
      claude: {
        model: cfg.claude?.model ?? DEFAULT_CLAUDE_MODEL,
        effort: cfg.claude?.effort ?? DEFAULT_EFFORT,
      },
    };
  }
  if (provider === "codex") {
    const given = cfg.codex?.model;
    const cache = given === undefined ? readCodexModels() : undefined;
    const model = given ?? (cache === undefined ? undefined : latestSolModel(cache));
    return {
      codex: { ...(model === undefined ? {} : { model }), effort: cfg.codex?.effort ?? DEFAULT_EFFORT },
      ...(model === undefined
        ? { warning: "codex のモデル一覧から最新の Sol 系を見つけられなかったため、codex の既定のモデルで訳します" }
        : {}),
    };
  }
  return {};
}
