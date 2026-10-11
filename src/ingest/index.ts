// 設計メモ §3・契約付録 §3/§5/§8。source-first 取り込みの配線。
import { readFileSync, statSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { JpaperInput } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import { fetchArxivSource, type ArxivDeps } from "./arxiv.js";
import { isArxivId } from "./detect-input.js";
import { extractArchive, writeFileMap, isArchive } from "./extract.js";
import { detectMainTex, expandInputs, type ExpandBudget } from "./main-tex.js";
import { dropDisabledBlocks } from "./disabled-blocks.js";
import { collectFigures } from "./resolve.js";
import { DEFAULT_LIMITS, type IngestLimits } from "./limits.js";

export interface Ingested {
  cleanLatex: string;
  figures: string[];
  paperId: string;
  sourceDir: string;
  mainDir: string;
  // 解決できなかった \input / \include の件数。0 でなければ本文の一部が欠けている。
  unresolvedInputs: number;
}

export interface IngestDeps {
  arxiv?: ArxivDeps;
  // 取り込みのサイズ・件数上限。既定は DEFAULT_LIMITS。
  limits?: IngestLimits;
}

const PATH_STRIP =
  /\.(?:tar\.gz|tex\.gz|tgz|tar|zip|gz|tex)$/i;

const DIGEST_SUFFIX = /-[0-9a-f]{8}$/;

export function derivePaperId(input: JpaperInput): string {
  // 形式検査は fetchArxivSource の中＝出力先の決定と run lock の mkdir より後にしかなかった。
  // 呼び出し側は JpaperInput を自前で組めるので（id は z.string()）、検証前に任意名の
  // ディレクトリが作られ、RunSummary.paperId には制御文字がそのまま載った（実測）。
  // 副作用より前にここで落とす。
  if (input.kind === "arxiv" && !isArxivId(input.id)) {
    throw new JpaperError(2, "input", `arXiv ID の形式が不正です: ${input.id}`);
  }
  // 単射性の規則は path 分岐と共有する（arXiv 分岐だけ / を _ に潰していたため、
  // "math/0309136" と "math_0309136" が同じ出力先へ写る規則になっていた）。
  const stem =
    input.kind === "arxiv"
      ? input.id.replace(/v\d+$/i, "")
      : (() => {
          const base = input.path.replace(/[/\\]+$/, "");
          const name = base.slice(base.replace(/\\/g, "/").lastIndexOf("/") + 1);
          return name.replace(PATH_STRIP, "");
        })();
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "_");
  // 正規化で名前が変わったら元名のダイジェストを付けて単射に戻す。潰したままだと
  // "a b.tex" / "a+b.tex" / "a:b.tex" が同じ出力先・同じ .run/steps・同じ run.lock を共有し、
  // 「別の論文なら既存 md を採用しない」印（.paper-id）も paperId が一致するため発動しない。
  // ダイジェストを条件付きで付ける規則は、**ダイジェスト付きの形が不動点**になる。
  // 攻撃者はその名前を直接付けられるので、"a b.tex"→"a_b-c8687a08" と
  // "a_b-c8687a08.tex" が衝突した（arXiv 分岐を跨いだ衝突も実測）。
  // 既にダイジェストの形をしている名前は、変換不要でも通さない。⚠ landmines.md
  if (safe === stem && safe !== "" && !DIGEST_SUFFIX.test(safe)) return safe;
  const digest = createHash("sha256").update(stem).digest("hex").slice(0, 8);
  return `${safe === "" ? "paper" : safe}-${digest}`;
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
  const expand: ExpandBudget = { maxBytes: limits.maxLatexBytes };
  const expanded = expandInputs(sourceDir, main, expand);
  // 展開経路（アーカイブ）は Budget が累積を見ているが、素の .tex とディレクトリは
  // ここが唯一の関門。checkpoint へ書く前に判定する（拒否した入力にディスクを使わない）。
  if (Buffer.byteLength(expanded) > limits.maxLatexBytes) {
    throw new JpaperError(
      2,
      "too-large",
      `取り込んだ本文が上限 ${limits.maxLatexBytes} バイトを超えています`,
    );
  }
  const cleanLatex = dropDisabledBlocks(expanded);
  const mainDir = path.join(sourceDir, path.dirname(main));
  const figures = collectFigures(cleanLatex, mainDir, sourceDir, limits.maxFigureRefs);
  return {
    cleanLatex,
    figures,
    paperId: derivePaperId(input),
    sourceDir,
    mainDir,
    unresolvedInputs: expand.unresolved ?? 0,
  };
}
