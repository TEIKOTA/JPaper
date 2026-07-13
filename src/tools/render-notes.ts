// 契約付録 §7・§8／翻訳一貫性 ADR(20260710) 決定3。訳注の PDF 描画（初出脚注＋巻末一覧）。
import type { TranslatorNote } from "../types/contract.js";

const ESC: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function latexEscape(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => ESC[c]!);
}

function insideMath(tex: string, idx: number): boolean {
  const dollars = (tex.slice(0, idx).match(/(?<!\\)\$/g) ?? []).length;
  return dollars % 2 === 1;
}

// 訳注の初出脚注をセグメント本文へ注入する（form の最初の非数式出現の直後）。見つからなければ巻末のみ。
export function injectFootnotes(
  segTex: string,
  segmentId: string,
  notes: TranslatorNote[],
  formBySrc: Map<string, string>,
): string {
  const inserts: { at: number; text: string }[] = [];
  for (const n of notes) {
    if (n.segmentId !== segmentId || !n.src) continue;
    const form = formBySrc.get(n.src);
    if (!form) continue;
    for (let from = 0; ; ) {
      const idx = segTex.indexOf(form, from);
      if (idx === -1) break;
      const end = idx + form.length;
      if (!insideMath(segTex, idx)) {
        inserts.push({ at: end, text: `\\footnote{訳注: ${latexEscape(n.text)}}` });
        break;
      }
      from = end;
    }
  }
  // 後ろから挿入して先行インデックスのずれを防ぐ。
  inserts.sort((a, b) => b.at - a.at);
  let out = segTex;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}

// 全訳注を列挙する巻末セクション（脚注に載らなかった注も必ず残す）。
export function renderBackmatter(
  notes: TranslatorNote[],
  formBySrc: Map<string, string>,
): string {
  if (notes.length === 0) return "";
  const items = notes.map((n) => {
    const label = n.src
      ? `\\textbf{${latexEscape(formBySrc.get(n.src) ?? n.src)}}（${latexEscape(n.src)}）`
      : "\\textbf{訳注}";
    return `\\item ${label}: ${latexEscape(n.text)}`;
  });
  return ["\\section*{訳注一覧}", "\\begin{itemize}", ...items, "\\end{itemize}"].join("\n");
}
