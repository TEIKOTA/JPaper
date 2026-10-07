// 契約付録 §5・§6・§8。jpaper CLI（core API translatePaper の薄い皮）。
import { detectInput } from "./ingest/detect-input.js";
import { translatePaper, type RunProgress } from "./workflows/translate-paper.js";
import { Provider, type Result } from "./types/contract.js";
import { JpaperError } from "./types/errors.js";
import { forTerminal } from "./runtime/untrusted.js";
import {
  DEFAULT_OLLAMA,
  DEFAULT_OPENROUTER,
  MAX_CONCURRENCY,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
} from "./config.js";
import type { OllamaConfig, OpenRouterConfig } from "./config.js";

export interface CliDeps {
  translate?: typeof translatePaper;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

const VALUE_FLAGS = ["--provider", "--out", "--model", "--context-window", "--concurrency"];
const BOOL_FLAGS = ["--think", "--no-think", "--no-bilingual"];

function parseConcurrency(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new JpaperError(2, "input", `--concurrency は正の整数で指定してください: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new JpaperError(
      2,
      "input",
      `--concurrency は 1〜${String(MAX_CONCURRENCY)} で指定してください: ${raw}`,
    );
  }
  return n;
}

function parseContextWindow(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new JpaperError(2, "input", `--context-window は正の整数で指定してください: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < MIN_CONTEXT_WINDOW || n > MAX_CONTEXT_WINDOW) {
    throw new JpaperError(
      2,
      "input",
      `--context-window は ${String(MIN_CONTEXT_WINDOW)}〜${String(MAX_CONTEXT_WINDOW)} で指定してください: ${raw}`,
    );
  }
  return n;
}

// 契約付録 §5。claude(subprocess) はログインセッションのモデルで動くため、モデル系の
// 指定を受け取れない。黙って捨てると「指定したのに効かない」になるので入口で落とす。
// --think は ollama だけの口（OpenRouter はモデル側の既定に委ねる）。
function modelConfigFrom(
  provider: Provider,
  model: string | undefined,
  contextWindow: string | undefined,
  think: boolean | undefined,
): { ollama?: OllamaConfig; openrouter?: OpenRouterConfig } {
  const givenModelFlag =
    model !== undefined ? "--model" : contextWindow !== undefined ? "--context-window" : undefined;
  const givenThinkFlag = think === undefined ? undefined : think ? "--think" : "--no-think";

  if (provider === "claude") {
    const given = givenModelFlag ?? givenThinkFlag;
    if (given !== undefined) {
      throw new JpaperError(2, "input", `${given} は --provider ollama|openrouter のときだけ指定できます`);
    }
    return {};
  }

  if (provider === "openrouter") {
    if (givenThinkFlag !== undefined) {
      throw new JpaperError(2, "input", `${givenThinkFlag} は --provider ollama のときだけ指定できます`);
    }
    if (givenModelFlag === undefined) return {};
    const id = (model ?? DEFAULT_OPENROUTER.model).trim();
    if (id === "") throw new JpaperError(2, "input", "--model に値が必要です");
    return {
      openrouter: {
        ...DEFAULT_OPENROUTER,
        model: id,
        contextWindow:
          contextWindow === undefined
            ? DEFAULT_OPENROUTER.contextWindow
            : parseContextWindow(contextWindow),
      },
    };
  }

  if (model === undefined && contextWindow === undefined && think === undefined) return {};
  const id = (model ?? DEFAULT_OLLAMA.model).trim();
  if (id === "") throw new JpaperError(2, "input", "--model に値が必要です");
  return {
    ollama: {
      ...DEFAULT_OLLAMA,
      model: id,
      contextWindow:
        contextWindow === undefined ? DEFAULT_OLLAMA.contextWindow : parseContextWindow(contextWindow),
      ...(think === undefined ? {} : { think }),
    },
  };
}

const PHASE_LABEL: Record<RunProgress["phase"], string> = {
  ingest: "取り込み",
  context: "文脈",
  translate: "翻訳",
  typeset: "組版",
};

// 契約付録 §5
export function formatProgress(e: RunProgress): string | undefined {
  const label = PHASE_LABEL[e.phase];
  if (e.phase !== "translate") {
    return e.done < e.total ? undefined : `[${label}] 完了`;
  }
  if (e.segmentId === undefined) return undefined;
  const head = `[${label} ${String(e.done)}/${String(e.total)}] ${e.segmentId}`;
  const rev =
    e.maxRevisions === undefined
      ? ""
      : ` (改稿 ${String(e.usedRevisions ?? 0)}/${String(e.maxRevisions)})`;
  if (e.passed !== false) return `${head} ok${rev}`;
  const kinds = e.failedKinds ?? [];
  return `${head} 失敗 ${kinds.length > 0 ? kinds.join(", ") : "品質"}${rev}`;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const translate = deps.translate ?? translatePaper;
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  // 論文由来の文字列が混ざるため、端末へ出す前に ESC 等の制御文字を落とす。
  const rawStderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const stderr = (s: string): void => rawStderr(forTerminal(s));

  const args = argv.slice(2);

  try {
    const positional: string[] = [];
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === undefined) continue;
      if (VALUE_FLAGS.includes(a)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("--")) {
          throw new JpaperError(2, "input", `${a} に値が必要です`);
        }
        flags.set(a, v);
        i++;
      } else if (BOOL_FLAGS.includes(a)) {
        flags.set(a, "");
      } else if (a.startsWith("--")) {
        // 綴り違いを黙って <input> として扱うと、論文 ID の解釈に失敗した形で表面化する。
        throw new JpaperError(2, "input", `不明なオプション: ${a}`);
      } else {
        positional.push(a);
      }
    }
    const providerArg = flags.get("--provider");
    const outArg = flags.get("--out");

    const inputStr = positional[0];
    if (inputStr === undefined) {
      throw new JpaperError(2, "input", "<input> が必要です");
    }
    if (providerArg === undefined) {
      throw new JpaperError(2, "input", "--provider {ollama|claude|openrouter} が必要です");
    }
    const provider = Provider.parse(providerArg);
    const wantThink = flags.has("--think");
    const wantNoThink = flags.has("--no-think");
    if (wantThink && wantNoThink) {
      throw new JpaperError(2, "input", "--think と --no-think は同時に指定できません");
    }
    const modelCfg = modelConfigFrom(
      provider,
      flags.get("--model"),
      flags.get("--context-window"),
      wantThink ? true : wantNoThink ? false : undefined,
    );
    const concurrencyArg = flags.get("--concurrency");
    const input = detectInput(inputStr);
    const result: Result = await translate(
      input,
      {
        provider,
        outDir: outArg,
        ...modelCfg,
        ...(concurrencyArg === undefined ? {} : { concurrency: parseConcurrency(concurrencyArg) }),
        ...(flags.has("--no-bilingual") ? { bilingual: false } : {}),
      },
      {
        onError: (m) => stderr(`エラー: ${m}\n`),
        onProgress: (e) => {
          const line = formatProgress(e);
          if (line !== undefined) stderr(`${line}\n`);
        },
      },
    );
    stdout(`${JSON.stringify(result.summary, null, 2)}\n`);
    if (result.pdfPath) stdout(`PDF: ${result.pdfPath}\n`);
    const bilingualPdf = result.summary.bilingual.pdfPath;
    if (bilingualPdf !== undefined) stdout(`対訳 PDF: ${bilingualPdf}\n`);
    if (result.error) stderr(`失敗[${result.error.kind}]: ${result.error.message}\n`);
    return result.exitCode;
  } catch (e) {
    if (e instanceof JpaperError) {
      stderr(`エラー: ${e.message}\n`);
      return e.code;
    }
    if ((e as { name?: string })?.name === "ZodError") {
      stderr(`エラー: --provider は ollama|claude|openrouter のいずれか\n`);
      return 2;
    }
    stderr(`想定外エラー: ${String((e as Error)?.message ?? e)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv).then((code) => process.exit(code));
}
