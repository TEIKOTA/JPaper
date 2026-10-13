// 契約付録 §8（.env の読み込み）。issue #273。
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// .env から取り込むキー（.env.example と同じ）。
export const DOTENV_KEYS = [
  "OPENROUTER_API_KEY",
  "JPAPER_HOME",
  "JPAPER_DUMP_RAW",
  "CODEX_HOME",
  "JPAPER_MAX_LLM_CONCURRENCY",
  "JPAPER_MAX_LLM_QUEUE",
] as const;

export interface DotEnvResult {
  loaded: string[];
  ignored: string[];
  error?: string;
}

// .env を読み、DOTENV_KEYS のうち環境変数に無い（undefined の）キーだけを env に載せる。キー名は辞書順で返す。
// ファイルが無ければ何もしない。読めなければ error（中身は含めない）。
export function loadDotEnv(
  file = ".env",
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): DotEnvResult {
  let text: string;
  try {
    text = read(file);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") return { loaded: [], ignored: [] };
    return { loaded: [], ignored: [], error: typeof code === "string" ? code : "読み込みに失敗しました" };
  }
  const parsed = parseEnv(text);
  const allowed = new Set<string>(DOTENV_KEYS);
  const loaded: string[] = [];
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!allowed.has(k)) ignored.push(k);
    else if (env[k] === undefined) {
      env[k] = v;
      loaded.push(k);
    }
  }
  return { loaded: loaded.sort(), ignored: ignored.sort() };
}

// 読んだ・読まなかったキーの名前（値は出さない）。
export function describeDotEnv(r: DotEnvResult): string[] {
  return [
    ...(r.loaded.length === 0 ? [] : [`.env から読んだ: ${r.loaded.join(", ")}`]),
    ...(r.ignored.length === 0 ? [] : [`.env の次のキーは読みません: ${r.ignored.join(", ")}`]),
  ];
}
