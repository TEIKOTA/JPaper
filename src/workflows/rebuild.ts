// 契約付録 §8（手で訳した節）。組版に失敗して残した build を、同じ閉じ込めの latexmk で組み直して成果物にする。
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { acquireRunLock } from "../durable/run-lock.js";
import { defaultRunner, unsafeSupportFiles, type LatexRunner } from "../tools/build-gate.js";
import { dropDeliverables, publishDeliverable } from "../tools/pdf-name.js";
import { findUnsafeTexCommands } from "../tools/tex-safety.js";
import { JpaperError } from "../types/errors.js";
import { DELIVERABLE_INFO, FAILED_BUILD_SUFFIX } from "./translate-paper.js";

export interface RebuildResult {
  exitCode: number;
  kind?: "ja" | "bilingual";
  pdfPath?: string;
  message?: string;
}

const KIND_OF_DIR: Record<string, "ja" | "bilingual"> = {
  [`build${FAILED_BUILD_SUFFIX}`]: "ja",
  [`bilingual${FAILED_BUILD_SUFFIX}`]: "bilingual",
};
const FINAL_DIR: Record<"ja" | "bilingual", string> = { ja: "build", bilingual: "bilingual" };
const NAME = /^[A-Za-z0-9._-]+-(ja|bilingual)\.pdf$/;
const TEX_FILE = /\.tex$/i;

function texFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...texFiles(p));
    else if (e.isFile() && TEX_FILE.test(e.name)) out.push(p);
  }
  return out;
}

function errorLines(log: string): string {
  const lines = log
    .split("\n")
    .filter((l) => l.startsWith("!") || /^[^\s:]+\.(tex|sty|cls):\d+: /.test(l))
    .slice(0, 3)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  return lines.length === 0 ? "latexmk が失敗しました（main.log を見てください）" : lines.join(" / ");
}

function readInfo(failedRoot: string, kind: "ja" | "bilingual"): string {
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(path.join(failedRoot, DELIVERABLE_INFO), "utf8"));
  } catch {
    throw new JpaperError(2, "input", `${path.join(failedRoot, DELIVERABLE_INFO)} を読めません`);
  }
  const { kind: k, name } = (info ?? {}) as { kind?: unknown; name?: unknown };
  if (k !== kind || typeof name !== "string" || !NAME.test(name) || !name.endsWith(`-${kind}.pdf`)) {
    throw new JpaperError(2, "input", `${DELIVERABLE_INFO} の中身が不正です`);
  }
  return name;
}

export async function rebuildKept(dir: string, runner: LatexRunner = defaultRunner): Promise<RebuildResult> {
  const abs = path.resolve(dir);
  const layout = path.basename(abs);
  const failedRoot = path.dirname(abs);
  const kind = KIND_OF_DIR[path.basename(failedRoot)];
  const translationDir = path.dirname(failedRoot);
  if (
    (layout !== "original" && layout !== "template") ||
    kind === undefined ||
    path.basename(translationDir) !== "translation" ||
    !existsSync(abs) ||
    !statSync(abs).isDirectory()
  ) {
    throw new JpaperError(
      2,
      "input",
      `--rebuild には translation/build.failed/<original|template> か translation/bilingual.failed/<original|template> を指定してください: ${dir}`,
    );
  }
  const outDir = path.dirname(translationDir);
  const name = readInfo(failedRoot, kind);
  const main = path.join(abs, "main.tex");
  if (!existsSync(main)) throw new JpaperError(2, "input", `${main} がありません`);
  const lock = acquireRunLock(path.join(outDir, ".run"));
  try {
    const unsafe = [
      ...texFiles(abs).flatMap((f) => findUnsafeTexCommands(readFileSync(f, "utf8")).map((c) => `${path.relative(abs, f).split(path.sep).join("/")}: \\${c}`)),
      ...unsafeSupportFiles(abs).map((u) => `${u.file}: ${u.commands.map((c) => `\\${c}`).join(", ")}`),
    ];
    if (unsafe.length > 0) {
      return {
        exitCode: 5,
        kind,
        message: `組版時にファイル読み書き・Lua 実行を行うコマンドを含むため実行しません: ${unsafe.slice(0, 5).join(" / ")}`,
      };
    }
    const pdf = path.join(abs, "main.pdf");
    rmSync(pdf, { force: true });
    const r = await runner(abs);
    if (r.envError !== undefined) return { exitCode: 1, kind, message: `組版できません（実行環境の障害）: ${r.envError}` };
    if (r.code !== 0 || !existsSync(pdf)) return { exitCode: 5, kind, message: errorLines(r.log) };
    const finalDir = path.join(translationDir, FINAL_DIR[kind]);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(abs, finalDir);
    rmSync(failedRoot, { recursive: true, force: true });
    if (kind === "ja") {
      rmSync(path.join(translationDir, FINAL_DIR.bilingual), { recursive: true, force: true });
      dropDeliverables(outDir, "bilingual");
    }
    const pdfPath = publishDeliverable(outDir, path.join(finalDir, "main.pdf"), name, kind);
    return { exitCode: 0, kind, pdfPath };
  } finally {
    lock.release();
  }
}
