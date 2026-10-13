// 契約付録 §8（.env の読み込み）。issue #273。
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

// 相対パスなら .env のあるディレクトリを基準に絶対パスへ直すキー（先頭の ~/ はホームに展開する）。
const PATH_KEYS = new Set<string>(["JPAPER_HOME", "JPAPER_DUMP_RAW", "CODEX_HOME"]);
// 名前を出してよいキーの形（大文字・数字・_）。
const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface DotEnvResult {
  loaded: string[];
  // 許可していないキーのうち、キー名の形をしたもの。
  ignored: string[];
  // キー名の形（KEY_NAME）をしていない行の数（名前は出さない）。
  malformed?: number;
  error?: string;
}

function absolutePath(v: string, base: string, home: () => string): string {
  if (v === "" || path.isAbsolute(v)) return v;
  if (v === "~" || v.startsWith("~/")) return path.join(home(), v.slice(1));
  return path.resolve(base, v);
}

// .env を読み、DOTENV_KEYS のうち環境変数に無い（undefined の）キーだけを env に載せる。キー名は辞書順で返す。
// 先頭の BOM は外す。PATH_KEYS の ~/ はホームに、相対パスは .env のあるディレクトリを基準に解決する。
// ファイルが無ければ何もしない。読めなければ error（中身は含めない）。
export function loadDotEnv(
  file = ".env",
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  home: () => string = os.homedir,
): DotEnvResult {
  let text: string;
  try {
    text = read(file);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") return { loaded: [], ignored: [] };
    return { loaded: [], ignored: [], error: typeof code === "string" ? code : "読み込みに失敗しました" };
  }
  const parsed = parseEnv(text.replace(/^\uFEFF/, ""));
  const allowed = new Set<string>(DOTENV_KEYS);
  const base = path.dirname(path.resolve(file));
  const loaded: string[] = [];
  const ignored: string[] = [];
  let malformed = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (!KEY_NAME.test(k)) malformed++;
    else if (!allowed.has(k)) ignored.push(k);
    else if (env[k] === undefined && v !== undefined) {
      env[k] = PATH_KEYS.has(k) ? absolutePath(v, base, home) : v;
      loaded.push(k);
    }
  }
  return { loaded: loaded.sort(), ignored: ignored.sort(), ...(malformed === 0 ? {} : { malformed }) };
}

// 読んだ・読まなかったキーの名前（値は出さない）。
export function describeDotEnv(r: DotEnvResult): string[] {
  return [
    ...(r.loaded.length === 0 ? [] : [`.env から読んだ: ${r.loaded.join(", ")}`]),
    ...(r.ignored.length === 0 ? [] : [`.env の次のキーは読みません: ${r.ignored.join(", ")}`]),
    ...(r.malformed === undefined ? [] : [`.env のキー名の形でない ${String(r.malformed)} 行は読みません`]),
  ];
}
