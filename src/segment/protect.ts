// 契約付録 §3。翻訳前に数式を不透明な印へ差し替え、訳文で復元する（保護区間）。
// 「訳させて壊れたら差し戻す」より「壊せない形で渡す」ほうが安い。実測ではローカル
// モデルの再訳 1 回が 320〜408 秒かかり、それでも数式の不一致が残った。
import { mathSpans, verbatimSpans, MATH_ENVS, type Span } from "../tools/tex-spans.js";

// 印の形は実測で選んだ。gemma4:12b-it-qat で 4 形式を比べ、〔n〕 は 9/9 保持し、
// 助詞も自然に付いた（「すべての実験において〔1〕を設定し、〔2〕を〔3〕とともに報告します」）。
export const MARK_OPEN = "〔";
export const MARK_CLOSE = "〕";

// 全角数字と前後の空白を許す（モデルが整形しても拾えるようにする）。
const MARK_RE = /〔\s*([0-9０-９]+)\s*〕/g;

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface Protection {
  // translator へ渡す本文（数式が印に置き換わっている）。
  text: string;
  // 印の番号順に並んだ原文の数式（区切り込み）。空なら保護していない。
  spans: string[];
}

// エスケープした特殊文字。訳す対象ではなく、原文のまま持ち越すのが正しいと分かって
// いるので、数式と同じく書き写しの機会を与えない。\\（行終端）は含めない——位置が
// 意味を持ち、セル本文は翻訳対象なので表ごと伏せると訳せなくなる。契約付録 §3
const ESCAPED_SPECIALS = "%&#$_{}";

// 数式・verbatim の外にあるエスケープ済み特殊文字を 2 文字の区間として拾う。
function escapedSpecialSpans(latex: string, excluded: readonly Span[]): Span[] {
  const spans: Span[] = [];
  let k = 0;
  for (let i = 0; i < latex.length - 1; i++) {
    // 除外区間（数式・verbatim）は飛ばす。excluded は昇順・非重複。
    while (k < excluded.length && excluded[k]![1] <= i) k++;
    if (k < excluded.length && i >= excluded[k]![0]) {
      i = excluded[k]![1] - 1;
      continue;
    }
    if (latex[i] !== "\\") continue;
    if (!ESCAPED_SPECIALS.includes(latex[i + 1]!)) {
      // \\ は行終端。2 文字ぶん進めて、続く文字を綴りの開始と誤認しない。
      if (latex[i + 1] === "\\") i++;
      continue;
    }
    spans.push([i, i + 2]);
    i++;
  }
  return spans;
}

function mergeSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  return [...a, ...b].sort((x, y) => x[0] - y[0]);
}

export function protectMath(latex: string): Protection {
  // 原文が印そのものを含むなら保護しない。復元時にどちらが印か区別できず、
  // 原文の一部を数式で上書きしてしまう（保護しなければ従来どおりの経路に戻るだけ）。
  if (latex.includes(MARK_OPEN)) return { text: latex, spans: [] };
  const math = mathSpans(latex, MATH_ENVS);
  const spans = mergeSpans(math, escapedSpecialSpans(latex, mergeSpans(math, verbatimSpans(latex))));
  if (spans.length === 0) return { text: latex, spans: [] };
  const kept: string[] = [];
  let out = "";
  let prev = 0;
  for (const [start, end] of spans) {
    // 区間は昇順・非重複が前提。崩れたら保護をやめる（黙って壊さない）。
    if (start < prev) return { text: latex, spans: [] };
    out += latex.slice(prev, start) + `${MARK_OPEN}${String(kept.length + 1)}${MARK_CLOSE}`;
    kept.push(latex.slice(start, end));
    prev = end;
  }
  return { text: out + latex.slice(prev), spans: kept };
}

export interface Restoration {
  text: string;
  // 訳文から消えた印の番号。差し戻しで名指しするために返す。
  missing: number[];
  // 2 回以上現れた印の番号（同じ数式が複製される）。
  duplicated: number[];
  // 原文に無い番号の印（モデルの創作）。復元せず印のまま残す。
  unknown: number[];
}

export function restoreMath(ja: string, spans: readonly string[]): Restoration {
  if (spans.length === 0) return { text: ja, missing: [], duplicated: [], unknown: [] };
  const seen = new Map<number, number>();
  const text = ja.replace(MARK_RE, (whole, digits: string) => {
    const n = Number(toHalfWidthDigits(digits));
    seen.set(n, (seen.get(n) ?? 0) + 1);
    const body = spans[n - 1];
    return body ?? whole;
  });
  const missing = spans.map((_, i) => i + 1).filter((n) => !seen.has(n));
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const unknown = [...seen.keys()].filter((n) => n < 1 || n > spans.length);
  return { text, missing, duplicated: duplicated.sort((a, b) => a - b), unknown: unknown.sort((a, b) => a - b) };
}

const mark = (n: number) => `${MARK_OPEN}${String(n)}${MARK_CLOSE}`;

// 差し戻し文。番号を名指しする（「5 件中の差異」では直しようがない）。
export function describeMarkIssues(r: Restoration): string[] {
  const out: string[] = [];
  if (r.missing.length > 0) {
    out.push(
      `訳文から印が消えています: ${r.missing.map(mark).join(" ")}。印は数式の差し替えなので、訳さず消さず、同じ形のまま適切な位置に残してください。`,
    );
  }
  if (r.duplicated.length > 0) {
    out.push(`同じ印が 2 回以上あります: ${r.duplicated.map(mark).join(" ")}。原文と同じ回数だけ置いてください。`);
  }
  if (r.unknown.length > 0) {
    out.push(`原文に無い印を作らないでください: ${r.unknown.map(mark).join(" ")}。`);
  }
  return out;
}
