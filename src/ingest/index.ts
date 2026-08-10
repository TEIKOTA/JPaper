// 設計メモ §3・契約付録 §3/§5/§8。source-first 取り込みの配線。
import { readFileSync, statSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JpaperInput } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import { fetchArxivSource, type ArxivDeps } from "./arxiv.js";
import { extractArchive, writeFileMap, isArchive } from "./extract.js";
import { detectMainTex, expandInputs } from "./main-tex.js";
import { collectFigures } from "./resolve.js";
import { DEFAULT_LIMITS, type IngestLimits } from "./limits.js";

export interface Ingested {
  cleanLatex: string;
  figures: string[];
  paperId: string;
  sourceDir: string;
  mainDir: string;
}

export interface IngestDeps {
  arxiv?: ArxivDeps;
  // 取り込みのサイズ・件数上限。既定は DEFAULT_LIMITS。
  limits?: IngestLimits;
}

const PATH_STRIP =
  /\.(?:tar\.gz|tex\.gz|tgz|tar|zip|gz|tex)$/i;

export function derivePaperId(input: JpaperInput): string {
  if (input.kind === "arxiv") {
    return input.id.replace(/v\d+$/i, "").replace(/\//g, "_");
  }
  const base = input.path.replace(/[/\\]+$/, "");
  const name = base.slice(base.replace(/\\/g, "/").lastIndexOf("/") + 1);
  return name.replace(PATH_STRIP, "").replace(/[^A-Za-z0-9._-]/g, "_") || "paper";
}

interface Materialized {
  sourceDir: string;
  mainRel?: string;
  // 展開経路（Budget が累積を見る）以外は、ingest 側で本文サイズを判定する必要がある。
  limited?: boolean;
}

function extractInto(bytes: Buffer, workDir: string, limits: IngestLimits): string {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  writeFileMap(extractArchive(bytes, limits), workDir);
  return workDir;
}

async function materialize(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps,
): Promise<Materialized> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  if (input.kind === "path") {
    let bytes: Buffer;
    try {
      const st = statSync(input.path);
      if (st.isDirectory()) return { sourceDir: input.path, limited: true };
      // アーカイブ以外の入力にも上限を掛ける。web で最も普通の形（アップロード済み
      // ファイルのパス）が無検査だと、プラン別に締めても素通りする。
      if (st.size > limits.maxArchiveBytes) {
        throw new JpaperError(
          2,
          "too-large",
          `入力が上限 ${limits.maxArchiveBytes} バイトを超えています`,
        );
      }
      bytes = readFileSync(input.path);
    } catch (e) {
      if (e instanceof JpaperError) throw e;
      throw new JpaperError(2, "input", `入力パスを読めません: ${input.path}`);
    }
    if (!isArchive(bytes)) {
      if (!/\.tex$/i.test(input.path)) {
        throw new JpaperError(2, "input", `未対応の入力形態です: ${input.path}`);
      }
      const abs = path.resolve(input.path);
      return { sourceDir: path.dirname(abs), mainRel: path.basename(abs), limited: true };
    }
    return { sourceDir: extractInto(bytes, workDir, limits) };
  }
  const bytes = await fetchArxivSource(input.id, { limits, ...deps.arxiv });
  return { sourceDir: extractInto(bytes, workDir, limits) };
}

export async function ingest(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps = {},
): Promise<Ingested> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const { sourceDir, mainRel, limited } = await materialize(input, workDir, deps);
  const main = mainRel ?? detectMainTex(sourceDir, limits.maxEntries);
  const cleanLatex = expandInputs(sourceDir, main, { maxBytes: limits.maxLatexBytes });
  // 展開経路（アーカイブ）は Budget が累積を見ているが、素の .tex とディレクトリは
  // ここが唯一の関門。checkpoint へ書く前に判定する（拒否した入力にディスクを使わない）。
  if (Buffer.byteLength(cleanLatex) > limits.maxLatexBytes) {
    throw new JpaperError(
      2,
      "too-large",
      `取り込んだ本文が上限 ${limits.maxLatexBytes} バイトを超えています`,
    );
  }
  const mainDir = path.join(sourceDir, path.dirname(main));
  const figures = collectFigures(cleanLatex, mainDir, sourceDir);
  return { cleanLatex, figures, paperId: derivePaperId(input), sourceDir, mainDir };
}
