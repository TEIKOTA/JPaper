// 契約付録 §1・§2。編集可能な glossary.md/brief.md/style.md の描画と読み戻し（durable 編集ループ）。
import type { DocumentBrief, StyleContract, TermCheck } from "../types/contract.js";

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

// 検証の結果の欄（読み戻さない）。契約付録 §4
function checkCell(c: TermCheck | undefined): string {
  if (c === undefined) return "";
  const src = c.sources.length === 0 ? "" : ` 出典: ${c.sources.join(" ")}`;
  if (c.status === "replaced" && c.via !== undefined) {
    return `用例に合わせた ${c.via} の訳に揃えた（元の訳: ${c.original ?? ""}）`;
  }
  if (c.status === "replaced") return `用例に合わせた（元の訳: ${c.original ?? ""}）${src}`;
  if (c.status === "confirmed") return `用例と一致${src}`;
  const via = c.via === undefined ? "" : `。${c.via} の訳に揃えた（元の訳: ${c.original ?? ""}）`;
  if (c.reason === "conflicting") return `未確認（用例の表記が割れている）${via}`;
  if (c.reason === "few-sites") return `未確認（差し替えに足りる用例が無い）${via}`;
  if (c.reason === "failed") return `未確認（検証の呼び出しに失敗した）${via}`;
  return `未確認（Web 検索で用例を確かめられなかった）${via}`;
}

// checks を渡すと「検証」の欄を足す（parseGlossaryMd は先頭 5 欄だけを読む）。
export function renderGlossaryMd(resolved: ResolvedRow[], checks?: readonly TermCheck[]): string {
  const bySrc = new Map((checks ?? []).map((c) => [c.src, c]));
  const withChecks = checks !== undefined;
  const rows = resolved
    .map((r) => {
      const base = `| ${cell(r.src)} | ${cell(r.form)} | ${cell(r.class)} | ${cell(r.rendering)} | ${cell(r.note ?? "")} |`;
      return withChecks ? `${base} ${cell(checkCell(bySrc.get(r.src)))} |` : base;
    })
    .join("\n");
  const head = withChecks
    ? "| 原語 | 確定訳/表記 | 分類 | 表記方針 | 訳注 | 検証 |\n|---|---|---|---|---|---|"
    : "| 原語 | 確定訳/表記 | 分類 | 表記方針 | 訳注 |\n|---|---|---|---|---|";
  return `# 用語集\n\n編集可（訳語・表記を直して再実行すると当該語の訳が差し替わる）。\n\n${head}\n${rows}\n`;
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

function splitSections(md: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of md.split("\n")) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      current = [];
      sections.set(h[1]!.trim(), current);
    } else if (current) {
      current.push(line);
    }
  }
  return sections;
}

function bullets(lines: string[] | undefined): string[] {
  return (lines ?? [])
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.trim().slice(2).trim());
}

export function parseBriefMd(md: string): DocumentBrief {
  const s = splitSections(md);
  return {
    thesis: (s.get("主張の核") ?? []).join("\n").trim(),
    sectionRoles: bullets(s.get("節の役割")).map((b) => {
      const i = b.indexOf(": ");
      return i === -1
        ? { id: b, role: "" }
        : { id: b.slice(0, i).trim(), role: b.slice(i + 2).trim() };
    }),
    notationConventions: bullets(s.get("記法規約")),
    claimStrengthNotes: bullets(s.get("主張強度の注意")),
  };
}

export function parseStyleMd(md: string): StyleContract {
  const kv = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = /^-\s+([^:]+):\s?(.*)$/.exec(line.trim());
    if (m) kv.set(m[1]!.trim(), m[2]!.trim());
  }
  const notes = (kv.get("備考") ?? "")
    .split(" / ")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return {
    register: kv.get("register") === "polite" ? "polite" : "plain",
    tensePolicy: kv.get("時制") ?? "",
    headingStyle: kv.get("見出し") ?? "",
    numberStyle: kv.get("数字・単位") ?? "",
    notes,
  };
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
