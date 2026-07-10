// 契約付録 §1・§2。編集可能な glossary.md/brief.md/style.md の描画と読み戻し（durable 編集ループ）。
import type { DocumentBrief, StyleContract } from "../types/contract.js";

export interface ResolvedRow {
  src: string;
  form: string;
  class: string;
  rendering: string;
  note?: string;
}

function cell(s: string): string {
  return s.replace(/[|\r\n]/g, " ").trim();
}

export function renderGlossaryMd(resolved: ResolvedRow[]): string {
  const rows = resolved
    .map(
      (r) =>
        `| ${cell(r.src)} | ${cell(r.form)} | ${cell(r.class)} | ${cell(r.rendering)} | ${cell(r.note ?? "")} |`,
    )
    .join("\n");
  return `# 用語集\n\n編集可（訳語・表記を直して再実行すると当該語の訳が差し替わる）。\n\n| 原語 | 確定訳/表記 | 分類 | 表記方針 | 訳注 |\n|---|---|---|---|---|\n${rows}\n`;
}

export function parseGlossaryMd(md: string): ResolvedRow[] {
  const out: ResolvedRow[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|(.+)\|$/.exec(line.trim());
    if (!m) continue;
    const cells = m[1]!.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const [src, form, cls, rendering, note] = cells;
    if (!src || src === "原語" || /^-+$/.test(src)) continue;
    const row: ResolvedRow = {
      src,
      form: form ?? "",
      class: cls ?? "",
      rendering: rendering ?? "",
    };
    if (note) row.note = note;
    out.push(row);
  }
  return out;
}

export function renderBriefMd(b: DocumentBrief): string {
  return [
    "# 文書ブリーフ",
    "## 主張の核",
    b.thesis,
    "## 節の役割",
    b.sectionRoles.map((r) => `- ${r.id}: ${r.role}`).join("\n"),
    "## 記法規約",
    b.notationConventions.map((n) => `- ${n}`).join("\n"),
    "## 主張強度の注意",
    b.claimStrengthNotes.map((n) => `- ${n}`).join("\n"),
    "",
  ].join("\n");
}

export function renderStyleMd(s: StyleContract): string {
  return [
    "# 文体契約",
    `- register: ${s.register}`,
    `- 時制: ${s.tensePolicy}`,
    `- 見出し: ${s.headingStyle}`,
    `- 数字・単位: ${s.numberStyle}`,
    `- 備考: ${s.notes.join(" / ")}`,
    "",
  ].join("\n");
}
