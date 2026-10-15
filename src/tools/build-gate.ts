// 契約付録 §6(exit5)・§7／2層化 ADR(20260709) 決定1・4。全文組版ゲート（ビルド＋エラー分類＋逆引き）。
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { segmentAtLine, type SourceSpan } from "./assemble-latex.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import { findUnsafeTexCommands, findUnsafeSupportCommands } from "./tex-safety.js";

export interface FailedSegment {
  id: string;
  line: number;
  message: string;
}
export interface Classification {
  failedSegments: FailedSegment[];
  structuralErrors: string[];
  unresolvedRefs: string[];
  missingFigures: string[];
}
export interface BuildGateResult extends Classification {
  buildOk: boolean;
  pdfPath?: string;
  droppedFigures: string[];
  // 配布パッケージと同名の同梱ファイル。探索順で無効化済みだが、体裁が変わり得るので surface する。
  shadowedPackages: string[];
}

export interface RunResult {
  code: number;
  log: string;
}
export type LatexRunner = (buildDir: string, signal?: AbortSignal) => RunResult | Promise<RunResult>;

export interface StageInput {
  sourceDir: string;
  mainDir: string;
  figures: string[];
}

const ERROR_LINE = /(?:^|\s)(?:\.\/)?([A-Za-z0-9._/-]+\.(?:tex|cls|sty|bst|bib|def|ltx)):(\d+):\s*(.+)$/gm;
const MISSING_FIG = /(?:File `([^'\n]+)' not found|Unable to load picture or PDF file `([^'\n]+)')/g;
const UNRESOLVED = /(?:Reference|Citation) `([^'\n]+)' (?:on page \d+ )?undefined/g;
const SUPPORT_EXT = /\.(sty|cls|bst|bib|bbl)$/i;

const FATAL_TRAILER = /^==> Fatal error occurred/;
const UNDEFINED_ENV = /LaTeX Error: Environment ([A-Za-z@*]+) undefined/;
const UNDEFINED_CS = /^Undefined control sequence/;
// エラー直後の `l.<行> <文脈>` 行の末尾に、未定義だった制御綴りが出る。
const CONTEXT_LINE = /^l\.\d+ .*?\\([a-zA-Z@]+)\s*$/m;

// 未定義エラーの原因となった名前（環境名・制御綴り）。取れなければ undefined。
function offendingName(message: string, rest: string): string | undefined {
  const env = UNDEFINED_ENV.exec(message);
  if (env) return env[1];
  if (!UNDEFINED_CS.test(message)) return undefined;
  return CONTEXT_LINE.exec(rest.slice(0, 400))?.[1];
}

// 原文にも同名があるなら translator は関与していない＝構造・テンプレ起因（2層化 ADR 決定4）。
function comesFromSource(name: string, originalTex: string): boolean {
  return (
    originalTex.includes(`\\begin{${name}}`) ||
    new RegExp(`\\\\${name}(?![a-zA-Z])`).test(originalTex)
  );
}

export function classifyLog(
  log: string,
  sourceMap: SourceSpan[],
  originalTex = "",
): Classification {
  const failedSegments: FailedSegment[] = [];
  const structuralErrors: string[] = [];
  const missingFigures = new Set<string>();
  const unresolvedRefs = new Set<string>();
  let lastWasStructural = false;

  for (let m = ERROR_LINE.exec(log); m; m = ERROR_LINE.exec(log)) {
    const file = m[1]!;
    const line = Number(m[2]);
    const message = m[3]!.trim();
    const inSegment = path.basename(file) === "main.tex" ? segmentAtLine(sourceMap, line) : undefined;
    const name = offendingName(message, log.slice(m.index + m[0].length));
    // 直前の診断の追随行。独立したエラーではないので分類を引き継ぐ。
    const structural: boolean = FATAL_TRAILER.test(message)
      ? lastWasStructural
      : name !== undefined && comesFromSource(name, originalTex);
    lastWasStructural = structural || inSegment === undefined;
    const id = structural ? undefined : inSegment;
    if (id) failedSegments.push({ id, line, message });
    else structuralErrors.push(`${file}:${line}: ${message}`);
  }
  for (let m = MISSING_FIG.exec(log); m; m = MISSING_FIG.exec(log)) {
    missingFigures.add((m[1] ?? m[2])!);
  }
  for (let m = UNRESOLVED.exec(log); m; m = UNRESOLVED.exec(log)) {
    unresolvedRefs.add(m[1]!);
  }
  return {
    failedSegments,
    structuralErrors,
    unresolvedRefs: [...unresolvedRefs],
    missingFigures: [...missingFigures],
  };
}

// manifest の各図が assemble 済み本文に \includegraphics として残っているか検証（訳が図を落とすと警告は出ない）。
export function checkFigures(mainTex: string, mainDir: string, figures: string[]): string[] {
  // 図ごとに本文全体を走査すると O(図数 × 本文長) になる（実測 5,000 図 × 8MB で 1,472ms）。
  // 検査したいのは \includegraphics の引数だけなので、引数を 1 度集めてそこだけを探す。
  const args: string[] = [];
  for (const m of mainTex.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
    args.push(m[1]!);
  }
  const hay = args.join("\n");
  const dropped: string[] = [];
  for (const fig of figures) {
    const abs = path.isAbsolute(fig) ? fig : path.join(mainDir, fig);
    const rel = path.relative(mainDir, abs);
    const stem = rel.replace(/\.[^./]+$/, "");
    if (!hay.includes(stem) && !hay.includes(path.basename(stem))) dropped.push(rel);
  }
  return dropped;
}

function collectSupportFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collectSupportFiles(p, acc);
    else if (SUPPORT_EXT.test(name)) acc.push(p);
  }
  return acc;
}

// 論文同梱の支援ファイルは配布パッケージより後に探索させる。cwd 直下に置くと同名で配布版を上書きできる。
export const SRC_PKG_DIR = "srcpkg";

// 配布パッケージと同名かは kpsewhich に問う。解決できない環境では検出なし（防御は探索順で既に効いている）。
// ファイル数に比例した subprocess 起動を避けるため、名前をまとめて 1 回だけ問う。
export type PackageResolver = (names: string[]) => Set<string>;

// kpsewhich は 1 つでも未解決の名前があると終了コード != 0 を返すが、解決できた分は
// stdout に出ている。throw を「全滅」として扱うと配布版の判定材料が消え、read
// プリミティブを含む配布パッケージ（実測: TeX Live の tex/latex 6,000 件のうち 4.4%）を
// 同梱しただけの正規論文が組版前に拒否される。arXiv 提出物は .bbl を同梱するのが
// 常道なので、未解決が混ざるのはむしろ普通。
const defaultResolver: PackageResolver = (names) => {
  if (names.length === 0) return new Set();
  let out: string;
  try {
    out = execFileSync("kpsewhich", names, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // kpsewhich が無い環境では stdout も無い＝空集合（全て走査）へフォールバックする。
    out = String((e as { stdout?: string | Buffer }).stdout ?? "");
  }
  return parseResolved(out);
};

// kpsewhich の出力（解決できたパスの行）を basename の集合にする。
export function parseResolved(out: string): Set<string> {
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const base = path.basename(line.trim());
    if (base !== "") found.add(base);
  }
  return found;
}

export interface UnsafeSupportFile {
  file: string;
  commands: string[];
}

// 同梱の .sty/.cls 等のうち「実際に読み込まれるもの」を検査する。
// 配布版と同名のものは探索順で無効化されるので対象外（そちらを検査すると、論文が
// elsarticle.cls などを同梱しているだけで落ちる）。
// 走査する支援ファイルの最大サイズ。配布クラスでも数百 KB に収まる。
const MAX_SUPPORT_SCAN_BYTES = 8 * 1024 * 1024;

export function unsafeSupportFiles(
  sourceDir: string,
  resolver: PackageResolver = defaultResolver,
): UnsafeSupportFile[] {
  const files = collectSupportFiles(sourceDir);
  const distributed = resolver(files.map((f) => path.basename(f)));
  const bad: UnsafeSupportFile[] = [];
  for (const f of files) {
    if (distributed.has(path.basename(f))) continue;
    // 支援ファイルには maxLatexBytes が効かない（上限は maxEntryBytes の 128MiB だけ）。
    // 走査は線形だが、巨大な .sty を投げられると走査そのものがメモリと時間を食う。
    // この大きさの支援ファイルは正規の論文には無いので、読まずに危険として扱う。
    if (statSync(f).size > MAX_SUPPORT_SCAN_BYTES) {
      bad.push({ file: path.relative(sourceDir, f), commands: ["too-large"] });
      continue;
    }
    const commands = findUnsafeSupportCommands(readFileSync(f, "utf8"));
    if (commands.length > 0) bad.push({ file: path.relative(sourceDir, f), commands });
  }
  return bad;
}

// build dir に main.tex＋支援ファイル(.sty/.cls/.bst/.bib/.bbl は srcpkg/ へ基底名で)＋main と同じ階層の唯一の .bbl(main.bbl として)＋図(main 相対で配置)を置く。
export function stageBuild(
  buildDir: string,
  mainTex: string,
  opts: StageInput,
  resolver: PackageResolver = defaultResolver,
): string[] {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "main.tex"), mainTex);
  const pkgDir = path.join(buildDir, SRC_PKG_DIR);
  mkdirSync(pkgDir, { recursive: true });
  const bases: string[] = [];
  for (const sty of collectSupportFiles(opts.sourceDir)) {
    const base = path.basename(sty);
    cpSync(sty, path.join(pkgDir, base));
    bases.push(base);
    // \documentclass{style/naturep} のようにディレクトリ付きで読む支援ファイルは、main からの相対位置にも置く。⚠ landmines.md
    const rel = path.relative(opts.mainDir, sty);
    if (rel.includes(path.sep) && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      mkdirSync(path.dirname(path.join(buildDir, rel)), { recursive: true });
      cpSync(sty, path.join(buildDir, rel));
    }
  }
  const distributed = resolver(bases);
  const shadowed = bases.filter((b) => distributed.has(b));
  // 契約付録 §8（.bbl だけの提出物）。
  const mainBbls = existsSync(opts.mainDir)
    ? readdirSync(opts.mainDir).filter((f) => /\.bbl$/i.test(f) && statSync(path.join(opts.mainDir, f)).isFile())
    : [];
  if (mainBbls.length === 1 && !distributed.has(mainBbls[0]!)) {
    cpSync(path.join(opts.mainDir, mainBbls[0]!), path.join(buildDir, "main.bbl"));
  }
  for (const fig of opts.figures) {
    const abs = path.isAbsolute(fig) ? fig : path.join(opts.mainDir, fig);
    if (!existsSync(abs)) continue;
    const rel = path.relative(opts.mainDir, abs);
    if (rel.startsWith("..")) continue;
    const dest = path.join(buildDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(abs, dest);
  }
  return shadowed;
}

// kpathsea 変数は環境変数で上書きできる。texmf.cnf の緩い設定に依存せず build ツリーへ閉じ込める。
export function sandboxEnv(base: NodeJS.ProcessEnv, buildDir: string): NodeJS.ProcessEnv {
  const pkg = `${path.join(buildDir, SRC_PKG_DIR)}//`;
  return {
    ...base,
    // 先頭の空要素で既定パスを前に置く＝同名なら配布パッケージが勝つ。
    TEXINPUTS: `:${pkg}`,
    BIBINPUTS: `:${pkg}`,
    BSTINPUTS: `:${pkg}`,
    openout_any: "p",
    shell_escape: "f",
  };
}

function readLog(buildDir: string): string {
  for (const p of [path.join(buildDir, "main.log"), path.join(buildDir, "out", "main.log")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

export const BUILD_TIMEOUT_MS = 300_000;

// latexmk は子（lualatex）を起こす。detached でプロセスグループを作り、超過時はグループごと止める。
// execFileSync の timeout は直接の子にしか届かず、孫が孤児として生き残るため。
export const defaultRunner: LatexRunner = (buildDir, signal) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(
      "latexmk",
      [
        "-lualatex",
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "main.tex",
      ],
      {
        cwd: buildDir,
        stdio: ["ignore", "ignore", "ignore"],
        env: sandboxEnv(process.env, buildDir),
        detached: true,
      },
    );
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, log: readLog(buildDir) });
    };
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish(1);
    }, BUILD_TIMEOUT_MS);
    // 中断もタイムアウトと同じ扱い。孫（lualatex）ごと落とす。
    const onAbort = (): void => {
      killGroup(child.pid);
      finish(1);
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });

export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL"); // 負の pid＝プロセスグループ全体
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 既に終了している
    }
  }
}

export async function runBuildGate(
  input: {
    buildDir: string;
    mainTex: string;
    sourceDir: string;
    mainDir: string;
    figures: string[];
    sourceMap: SourceSpan[];
    originalTex?: string;
    signal?: AbortSignal;
    resolver?: PackageResolver;
  },
  runner: LatexRunner = defaultRunner,
): Promise<BuildGateResult> {
  throwIfAborted(input.signal, "組版前");
  // 多層防御。ingest 段で弾いているが、組立後の main.tex も latexmk へ渡す前に検査する。
  // kpathsea の openin_any=p は luaotfload のフォント読み込みごと壊すため使えない（実測）。
  const unsafeSupport = unsafeSupportFiles(input.sourceDir, input.resolver);
  const unsafe = findUnsafeTexCommands(input.mainTex);
  if (unsafe.length > 0 || unsafeSupport.length > 0) {
    const detail = [
      ...unsafe.map((c) => `main.tex: \\${c}`),
      ...unsafeSupport.map((u) => `${u.file}: ${u.commands.map((c) => `\\${c}`).join(", ")}`),
    ];
    return {
      buildOk: false,
      droppedFigures: [],
      shadowedPackages: [],
      failedSegments: [],
      structuralErrors: [
        `組版時にファイル読み書き・Lua 実行を行うコマンドを含むため実行しません: ${detail.join(" / ")}`,
      ],
      missingFigures: [],
      unresolvedRefs: [],
    };
  }
  const shadowedPackages = stageBuild(input.buildDir, input.mainTex, {
    sourceDir: input.sourceDir,
    mainDir: input.mainDir,
    figures: input.figures,
  });
  const { code, log } = await runner(input.buildDir, input.signal);
  throwIfAborted(input.signal, "組版中");
  const cls = classifyLog(log, input.sourceMap, input.originalTex);
  const droppedFigures = checkFigures(input.mainTex, input.mainDir, input.figures);
  const pdf = path.join(input.buildDir, "main.pdf");
  const pdfPath = existsSync(pdf) ? pdf : undefined;
  const buildOk =
    code === 0 &&
    cls.failedSegments.length === 0 &&
    cls.structuralErrors.length === 0 &&
    cls.unresolvedRefs.length === 0 &&
    cls.missingFigures.length === 0 &&
    droppedFigures.length === 0;
  return { buildOk, pdfPath, droppedFigures, shadowedPackages, ...cls };
}
