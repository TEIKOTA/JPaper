// 契約付録 §5・§6・§8。jpaper CLI（core API translatePaper の薄い皮）。
import { detectInput } from "./ingest/detect-input.js";
import { translatePaper } from "./workflows/translate-paper.js";
import { Provider, type Result } from "./types/contract.js";
import { JpaperError } from "./types/errors.js";
import { forTerminal } from "./runtime/untrusted.js";

export interface CliDeps {
  translate?: typeof translatePaper;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
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
    let providerArg: string | undefined;
    let outArg: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--provider" || a === "--out") {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("--")) {
          throw new JpaperError(2, "input", `${a} に値が必要です`);
        }
        if (a === "--provider") providerArg = v;
        else outArg = v;
        i++;
      } else if (a !== undefined) {
        positional.push(a);
      }
    }

    const inputStr = positional[0];
    if (inputStr === undefined) {
      throw new JpaperError(2, "input", "<input> が必要です");
    }
    if (providerArg === undefined) {
      throw new JpaperError(2, "input", "--provider {ollama|claude} が必要です");
    }
    const provider = Provider.parse(providerArg);
    const input = detectInput(inputStr);
    const result: Result = await translate(
      input,
      { provider, outDir: outArg },
      { onError: (m) => stderr(`エラー: ${m}\n`) },
    );
    stdout(`${JSON.stringify(result.summary, null, 2)}\n`);
    if (result.pdfPath) stdout(`PDF: ${result.pdfPath}\n`);
    if (result.error) stderr(`失敗[${result.error.kind}]: ${result.error.message}\n`);
    return result.exitCode;
  } catch (e) {
    if (e instanceof JpaperError) {
      stderr(`エラー: ${e.message}\n`);
      return e.code;
    }
    if ((e as { name?: string })?.name === "ZodError") {
      stderr(`エラー: --provider は ollama|claude のいずれか\n`);
      return 2;
    }
    stderr(`想定外エラー: ${String((e as Error)?.message ?? e)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv).then((code) => process.exit(code));
}
