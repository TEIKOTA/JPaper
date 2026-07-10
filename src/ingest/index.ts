// 設計メモ §3・契約付録 §3/§5/§8。source-first 取り込みの配線。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { JpaperInput } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import { fetchArxivSource, type ArxivDeps } from "./arxiv.js";
import { extractArchive, writeFileMap, isArchive } from "./extract.js";
import { detectMainTex, expandInputs } from "./main-tex.js";
import { collectFigures } from "./resolve.js";

export interface Ingested {
  cleanLatex: string;
  figures: string[];
  paperId: string;
  sourceDir: string;
}

export interface IngestDeps {
  arxiv?: ArxivDeps;
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
}

async function materialize(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps,
): Promise<Materialized> {
  if (input.kind === "path") {
    if (statSync(input.path).isDirectory()) return { sourceDir: input.path };
    const bytes = readFileSync(input.path);
    if (!isArchive(bytes)) {
      if (!/\.tex$/i.test(input.path)) {
        throw new JpaperError(2, "input", `未対応の入力形態です: ${input.path}`);
      }
      const abs = path.resolve(input.path);
      return { sourceDir: path.dirname(abs), mainRel: path.basename(abs) };
    }
    writeFileMap(extractArchive(bytes), workDir);
    return { sourceDir: workDir };
  }
  const bytes = await fetchArxivSource(input.id, deps.arxiv);
  writeFileMap(extractArchive(bytes), workDir);
  return { sourceDir: workDir };
}

export async function ingest(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps = {},
): Promise<Ingested> {
  const { sourceDir, mainRel } = await materialize(input, workDir, deps);
  const main = mainRel ?? detectMainTex(sourceDir);
  const cleanLatex = expandInputs(sourceDir, main);
  const figures = collectFigures(cleanLatex, sourceDir);
  return { cleanLatex, figures, paperId: derivePaperId(input), sourceDir };
}
