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

// 脚注を挿してはいけない領域。数式（$・$$・\[..\]・\(..\)・数式環境）と verbatim 系の中、
// 制御綴りそのもの、\begin{...}/\end{...} の環境名。$ の個数だけを見ていた頃は
// \begin{align} の中が「数式でない」と判定され、\begin{align\footnote{...}} を生成して
// 組版が確実に落ちた（品質ゲートの後なので、全節 pass した翻訳を後段で壊せた）。
const PROTECTED = [
  /\$\$[\s\S]*?\$\$/g,
  /(?<!\\)\$[\s\S]*?(?<!\\)\$/g,
  /\\\[[\s\S]*?\\\]/g,
  /\\\([\s\S]*?\\\)/g,
  /\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math|verbatim|lstlisting|alltt|minted)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
  /\\(?:begin|end)\s*\{[^{}]*\}/g,
  /\\[a-zA-Z@]+\*?/g,
];

function protectedMask(tex: string): Uint8Array {
  const mask = new Uint8Array(tex.length);
  for (const re of PROTECTED) {
    re.lastIndex = 0;
    for (const m of tex.matchAll(re)) {
      const at = m.index;
      mask.fill(1, at, at + m[0].length);
    }
  }
  return mask;
}

const WORDISH = /[A-Za-z0-9]/;

// 語の途中への割り込みも弾く（form="tion" が translation に当たるような部分一致）。
function safeAt(tex: string, mask: Uint8Array, idx: number, end: number): boolean {
  for (let i = idx; i < end; i++) if (mask[i] === 1) return false;
  if (end < tex.length && mask[end] === 1 && tex[end] !== "\\") return false;
  const before = tex[idx - 1];
  const after = tex[end];
  if (WORDISH.test(tex[idx] ?? "") && before !== undefined && WORDISH.test(before)) return false;
  if (WORDISH.test(tex[end - 1] ?? "") && after !== undefined && WORDISH.test(after)) return false;
  return true;
}

// 訳注の初出脚注をセグメント本文へ注入する（form の最初の安全な出現の直後）。見つからなければ巻末のみ。
export function injectFootnotes(
  segTex: string,
  segmentId: string,
  notes: TranslatorNote[],
  formBySrc: Map<string, string>,
): string {
  const inserts: { at: number; text: string }[] = [];
  const mask = protectedMask(segTex);
  for (const n of notes) {
    if (n.segmentId !== segmentId || !n.src) continue;
    const form = formBySrc.get(n.src);
    if (!form) continue;
    for (let from = 0; ; ) {
      const idx = segTex.indexOf(form, from);
      if (idx === -1) break;
      const end = idx + form.length;
      if (safeAt(segTex, mask, idx, end)) {
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
