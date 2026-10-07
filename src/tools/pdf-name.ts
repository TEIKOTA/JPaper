// 契約付録 §8（成果物 PDF の名前）。ADR 20261007-name-deliverable-pdfs-by-id-and-slug。
import { copyFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export type DeliverableKind = "ja" | "bilingual";

export const MAX_SLUG_CHARS = 40;
export const MAX_FILE_ID_CHARS = 100;

// translator が訳題の囲みの中に足す 1 行（TeX の行コメント）。
export const PDF_NAME_LINE = "% pdf-name:";
const NAME_LINE = /^[ \t]*%[ \t]*pdf-name[ \t]*:[ \t]*(.*?)[ \t]*$/gim;

// 短い英語名を英小文字・数字・ハイフンだけに整える。何も残らなければ undefined。
export function normalizeSlug(raw: string): string | undefined {
  const words = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  let slug = "";
  for (const w of words) {
    const next = slug === "" ? w : `${slug}-${w}`;
    if (next.length > MAX_SLUG_CHARS) {
      if (slug === "") slug = w.slice(0, MAX_SLUG_CHARS);
      break;
    }
    slug = next;
  }
  return slug === "" ? undefined : slug;
}

// 訳文から名前の行をすべて取り外す。name は最後の行の値（整える前）。
export function takePdfNameLine(text: string): { text: string; name?: string } {
  let name: string | undefined;
  const stripped = text.replace(NAME_LINE, (_m, v: string) => {
    name = v;
    return "\u0000";
  });
  if (name === undefined) return { text };
  return { text: stripped.replace(/\u0000(?:\r?\n)?/g, "").replace(/\r?\n$/, ""), name };
}

// ファイル名に使える形の ID（英数字・. _ - のみ、先頭は . 以外）。
export function safeFileId(paperId: string): string {
  const s = paperId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, (m) => "_".repeat(m.length))
    .slice(0, MAX_FILE_ID_CHARS);
  return s === "" ? "paper" : s;
}

// <ID>_<slug>-ja.pdf / <ID>-ja.pdf（slug が無い・不正なら ID だけ）。
export function deliverableName(paperId: string, slug: string | undefined, kind: DeliverableKind): string {
  const s = slug === undefined ? undefined : normalizeSlug(slug);
  return `${safeFileId(paperId)}${s === undefined ? "" : `_${s}`}-${kind}.pdf`;
}

const DELIVERABLE = /^[A-Za-z0-9._-]+-(ja|bilingual)\.pdf$/;

function listDeliverables(outDir: string, kind?: DeliverableKind): string[] {
  try {
    return readdirSync(outDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => {
        const m = DELIVERABLE.exec(n);
        return m !== null && (kind === undefined || m[1] === kind);
      });
  } catch {
    return [];
  }
}

// 出力先の直下にある成果物 PDF（kind 省略時は両方）を消す。keep は残す。
export function dropDeliverables(outDir: string, kind?: DeliverableKind, keep?: string): void {
  for (const n of listDeliverables(outDir, kind)) {
    if (n !== keep) rmSync(path.join(outDir, n), { force: true });
  }
}

// 組版の PDF を出力先の直下へ name で置き、同じ kind の他の名前の成果物を消す。置いたパスを返す。
export function publishDeliverable(outDir: string, pdfPath: string, name: string, kind: DeliverableKind): string {
  const dest = path.join(outDir, name);
  const tmp = path.join(outDir, `.${name}.tmp`);
  copyFileSync(pdfPath, tmp);
  renameSync(tmp, dest);
  dropDeliverables(outDir, kind, name);
  return dest;
}
