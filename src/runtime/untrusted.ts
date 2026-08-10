// 契約付録 §1・プロンプト注入 ADR(20260811)。論文・LLM 由来の文字列を prompt / 端末へ出す前の正規化。
// 目的は「データがデータとして読まれること」。改行や制御文字で見出し・指示を偽装させない。

// 改行を含む全ての C0/C1 制御文字。
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;

// 改行・タブは残し、それ以外の制御文字（ESC 等）だけを落とす。
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export const MAX_TERM_CHARS = 200;
export const MAX_NOTE_CHARS = 400;
export const MAX_ISSUE_CHARS = 500;
export const MAX_ISSUES = 20;

// 改行・制御文字を落として 1 行に畳み、長さで切る。切ったことは省略記号で残す。
export function oneLine(s: string, max: number): string {
  const flat = s.replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// 端末へ出す文字列。ANSI エスケープによる表示偽装を防ぐ（改行・タブは保つ）。
export function forTerminal(s: string): string {
  return s.replace(CONTROL_EXCEPT_NEWLINE, "");
}
