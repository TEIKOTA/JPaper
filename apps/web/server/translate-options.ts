// 契約付録 §9（Web アプリ）。翻訳ジョブの provider・model・effort と arXiv ID の検査。検査は CLI と同じ関数を使う。
import { modelConfigFrom } from "../../../src/cli.js";
import { detectInput, isArxivId } from "../../../src/ingest/detect-input.js";
import { Provider } from "../../../src/types/contract.js";
import { JpaperError } from "../../../src/types/errors.js";

export interface TranslateOptions {
  provider: Provider;
  model?: string;
  effort?: string;
  // false なら CLI に --no-verify-terms を渡す（設定の「用語を Web 検索で確かめる」）。
  verifyTerms?: false;
}

export interface ProviderInfo {
  name: Provider;
  effort: boolean;
}

const MAX_TEXT = 200;

// 空・未指定は undefined。先頭 `-`・制御文字・長すぎる値は拒む。
export function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new JpaperError(2, "input", `${name} は文字列で指定してください`);
  const s = value.trim();
  if (s === "") return undefined;
  if (s.startsWith("-") || /[\x00-\x1f\x7f]/.test(s) || s.length > MAX_TEXT) {
    throw new JpaperError(2, "input", `${name} の値が不正です: ${s.slice(0, MAX_TEXT)}`);
  }
  return s;
}

export function parseProvider(value: unknown): Provider {
  const p = Provider.safeParse(typeof value === "string" ? value.trim() : value);
  if (!p.success) throw new JpaperError(2, "input", `provider は ${Provider.options.join("|")} から選んでください`);
  return p.data;
}

export function parseTranslateOptions(body: { provider?: unknown; model?: unknown; effort?: unknown }): TranslateOptions {
  const provider = parseProvider(body.provider);
  const model = optionalText(body.model, "model");
  const effort = optionalText(body.effort, "effort");
  modelConfigFrom(provider, model, undefined, undefined, effort);
  return { provider, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

// provider ごとに effort を受け付けるか。CLI の検査に試しに通して決める。
export function providerInfo(): ProviderInfo[] {
  return Provider.options.map((name) => {
    try {
      modelConfigFrom(name, undefined, undefined, undefined, "low");
      return { name, effort: true };
    } catch {
      return { name, effort: false };
    }
  });
}

// arXiv ID（`arxiv:` 接頭辞・版の付いたものを含む）を正規化する。ファイルの道筋としては解釈しない。
export function parseArxivId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new JpaperError(2, "input", "arXiv ID を入力してください");
  let input;
  try {
    input = detectInput(value, () => false);
  } catch {
    throw new JpaperError(2, "input", `arXiv ID の形式が不正です: ${value.trim().slice(0, MAX_TEXT)}`);
  }
  if (input.kind !== "arxiv" || !isArxivId(input.id)) {
    throw new JpaperError(2, "input", `arXiv ID の形式が不正です: ${value.trim().slice(0, MAX_TEXT)}`);
  }
  return input.id;
}

// input は arXiv ID か PDF の絶対パス。pages・yes は PDF 入力のとき（§8「PDF 入力」の --pages・--yes）。
export function cliArgs(
  input: string,
  opts: TranslateOptions,
  outDir: string,
  pdf: { pages?: string; yes?: boolean } = {},
): string[] {
  return [
    input,
    "--provider",
    opts.provider,
    ...(opts.model === undefined ? [] : ["--model", opts.model]),
    ...(opts.effort === undefined ? [] : ["--effort", opts.effort]),
    ...(opts.verifyTerms === false ? ["--no-verify-terms"] : []),
    ...(pdf.pages === undefined ? [] : ["--pages", pdf.pages]),
    ...(pdf.yes === true ? ["--yes"] : []),
    "--out",
    outDir,
  ];
}
