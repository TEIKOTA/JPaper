// 設計メモ §3・契約付録 §3/§5/§8。source-first 取り込みの配線。
import { readFileSync, statSync } from "node:fs";
import type { JpaperInput } from "../types/contract.js";
import { fetchArxivSource, type ArxivDeps } from "./arxiv.js";
import { extractArchive, writeFileMap } from "./extract.js";
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

async function materialize(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps,
): Promise<string> {
  if (input.kind === "path" && statSync(input.path).isDirectory()) {
    return input.path;
  }
  const bytes =
    input.kind === "arxiv"
      ? await fetchArxivSource(input.id, deps.arxiv)
      : readFileSync(input.path);
  writeFileMap(extractArchive(bytes), workDir);
  return workDir;
}

export async function ingest(
  input: JpaperInput,
  workDir: string,
  deps: IngestDeps = {},
): Promise<Ingested> {
  const sourceDir = await materialize(input, workDir, deps);
  const mainRel = detectMainTex(sourceDir);
  const cleanLatex = expandInputs(sourceDir, mainRel);
  const figures = collectFigures(cleanLatex, sourceDir);
  return { cleanLatex, figures, paperId: derivePaperId(input), sourceDir };
}
