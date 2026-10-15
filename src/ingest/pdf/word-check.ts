// 契約付録 §8（PDF 入力）・PDF 入力 ADR(20261015) 決定 2。起こした LaTeX とテキスト層の語句の突き合わせ。
import { MATH_ENVS, mathSpans, maskChars, verbatimSpans } from "../../tools/tex-spans.js";

// テキスト層の語がこの数以上連続して起こした側に無ければ不合格。
export const MAX_MISSING_RUN = 5;
// LLM が「意図して省いた」と申告できる語数の上限（ページの語数に対する割合と、最低値）。
export const OMITTED_RATIO = 0.25;
export const MIN_OMITTED_ALLOWANCE = 30;
// 省いた文字を申告するコメントの印。組み立てるときに取り除く。
export const OMITTED_MARK = "% jpaper-omitted:";

// 数式の中で ASCII の語として現れる演算子名。テキスト層では本文の語と区別できない。
const MATH_OPERATORS = new Set([
  "lim", "liminf", "limsup", "min", "max", "sup", "inf", "exp", "log", "sin", "cos", "tan",
  "tanh", "sinh", "cosh", "det", "var", "cov", "argmin", "argmax", "sgn", "sign", "dist",
  "supp", "diag", "rank", "span", "tr", "dim", "ker", "deg", "gcd", "mod", "def", "pop", "law",
  "softmax", "relu", "erf", "arg", "prob",
]);

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

function words(text: string): string[] {
  const s = text
    .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g, (c) => LIGATURES[c] ?? c)
    // 行末の分綴をつなぐ（"approxima-\ntion"）。
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2");
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z]{3,}/g)) {
    const w = m[0].toLowerCase();
    if (!MATH_OPERATORS.has(w)) out.push(w);
  }
  return out;
}

export function textLayerWords(text: string): string[] {
  return words(text);
}

// 数式の中で地の文として描かれる引数（\text{for all} など）。
const TEXT_IN_MATH = /\\(?:text|textrm|textup|textit|textbf|textnormal|mbox|operatorname\*?|mathrm)\s*\{([^{}]*)\}/g;

export interface LatexWords {
  words: string[];
  omitted: string[];
}

// 起こした LaTeX の語。数式は落とすが、数式の中の \text{…} は残す。コメントは落とすが、
// 省いた文字の申告（OMITTED_MARK）は omitted として別に返す。
export function latexWords(tex: string): LatexWords {
  const omitted: string[] = [];
  const lines = tex.split("\n").map((line) => {
    const at = line.indexOf(OMITTED_MARK);
    if (at >= 0) {
      omitted.push(...words(line.slice(at + OMITTED_MARK.length)));
      return line.slice(0, at);
    }
    // エスケープされていない % 以降はコメント。
    return line.replace(/(^|[^\\])%.*$/, "$1");
  });
  const body = lines.join("\n");
  const spans = mathSpans(body, MATH_ENVS);
  const kept: string[] = [];
  for (const [start, end] of spans) {
    for (const m of body.slice(start, end).matchAll(TEXT_IN_MATH)) kept.push(m[1]!);
  }
  const masked = maskChars(body, [...spans, ...verbatimSpans(body)]);
  // 命令名を落とし、引数（\textbf{Lemma} の Lemma・\cite{BCN18} の BCN18）は残す。
  const prose = masked.replace(/\\[A-Za-z@]+\*?/g, " ");
  return { words: [...words(prose), ...words(kept.join(" "))], omitted };
}

export interface WordCheck {
  // テキスト層の語のうち、起こした側に無い語の最長の連続。
  maxMissingRun: number;
  // その連続の語（読み直しの指摘に使う）。
  missingSample: string;
  // 起こした側にだけある語の数（画面に描かれない文字・LLM の付け足し）。
  extra: number;
  // 省いたと申告した語のうち、テキスト層の語を埋めた数と、その上限。
  omitted: number;
  omittedAllowance: number;
  ok: boolean;
}

export function checkWords(textLayer: string, tex: string): WordCheck {
  const src = textLayerWords(textLayer);
  const { words: got, omitted } = latexWords(tex);
  const pool = new Map<string, number>();
  for (const w of got) pool.set(w, (pool.get(w) ?? 0) + 1);
  const omittedPool = new Map<string, number>();
  for (const w of omitted) omittedPool.set(w, (omittedPool.get(w) ?? 0) + 1);
  // 省いたという申告は、テキスト層の語を埋めた分だけ数える。
  let omittedUsed = 0;
  let run = 0;
  let best = { len: 0, end: 0 };
  src.forEach((w, i) => {
    const n = pool.get(w) ?? 0;
    const o = omittedPool.get(w) ?? 0;
    if (n > 0) {
      pool.set(w, n - 1);
      run = 0;
    } else if (o > 0) {
      omittedPool.set(w, o - 1);
      omittedUsed++;
      run = 0;
    } else {
      run++;
      if (run > best.len) best = { len: run, end: i + 1 };
    }
  });
  const extra = [...pool.values()].reduce((a, n) => a + n, 0);
  const omittedAllowance = Math.max(MIN_OMITTED_ALLOWANCE, Math.ceil(src.length * OMITTED_RATIO));
  return {
    maxMissingRun: best.len,
    missingSample: src.slice(best.end - best.len, best.end).join(" "),
    extra,
    omitted: omittedUsed,
    omittedAllowance,
    ok: best.len < MAX_MISSING_RUN && omittedUsed <= omittedAllowance,
  };
}
