// 契約付録 §8。決定的な用語候補収集（固定5パターン＋DB 最長一致）。網羅性は求めない。
import { oneLine, MAX_TERM_CHARS } from "../runtime/untrusted.js";

export interface Candidate {
  src: string;
  definedInPaper: boolean;
}

interface Acc {
  def: boolean;
  pos: number;
}

// 量指定子はすべて有界にする。終端の無い [^}]+ や .+? は開始位置ごとに末尾まで走査し、
// 本文全体（maxLatexBytes=8MiB）に対して二次になる（実測 512KiB で 35,510ms、8MiB へ外挿で
// 約 2.5 時間。gzip 14KB の入力で完全同期にイベントループが死ぬ）。どのみち add() で
// MAX_TERM_CHARS に切るので、それを超える長さを探すこと自体が無駄。
const PATTERNS: { re: RegExp; def: boolean }[] = [
  { re: /\\newcommand\{?(\\[A-Za-z@]{1,200})\}?/g, def: true },
  {
    re: /\bwe\s{1,20}(?:call|define|term|denote)\s{1,20}(?:the\s|an?\s|this\s|it\s)?([A-Za-z][\w\- ]{0,200}?)(?=\s+as\b|[.,;:()]|$)/gi,
    def: true,
  },
  {
    re: /\bwe\s{1,20}refer\s{1,20}to\s{1,20}.{1,200}?\s{1,20}as\s{1,20}(?:the\s|an?\s)?([A-Za-z][\w\- ]{0,200}?)(?=[.,;:()]|$)/gi,
    def: true,
  },
  {
    re: /([A-Z][A-Za-z-]{0,200}(?:\s{1,20}[A-Za-z][A-Za-z-]{0,200}){0,3})\s{1,20}(?:is|are)\s{1,20}defined\s{1,20}as\b/g,
    def: true,
  },
  { re: /\\(?:emph|textit|textbf)\{([^}]{1,200})\}/g, def: true },
  { re: /\b([A-Z][a-zA-Z]{1,200}(?:\s{1,20}[A-Z][a-zA-Z]{1,200}){1,20})\b/g, def: false },
];

// 候補は論文本文そのもの。\emph{...} は改行を跨げるため、1 行化と長さ上限で指示文の注入を潰す。
function add(map: Map<string, Acc>, raw: string, def: boolean, pos: number): void {
  const src = oneLine(raw, MAX_TERM_CHARS);
  if (src === "") return;
  const cur = map.get(src);
  if (cur) {
    cur.def = cur.def || def;
    if (pos < cur.pos) cur.pos = pos;
  } else {
    map.set(src, { def, pos });
  }
}

export function collectCandidates(latex: string, knownTerms: string[] = []): Candidate[] {
  const map = new Map<string, Acc>();
  for (const { re, def } of PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(latex)) !== null) add(map, m[1] ?? "", def, m.index);
  }
  for (const t of knownTerms) {
    const i = latex.indexOf(t);
    if (i !== -1) add(map, t, false, i);
  }
  return [...map.entries()]
    .sort((a, b) => a[1].pos - b[1].pos)
    .map(([src, v]) => ({ src, definedInPaper: v.def }));
}
