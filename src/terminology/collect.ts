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

const PATTERNS: { re: RegExp; def: boolean }[] = [
  { re: /\\newcommand\{?(\\[A-Za-z@]+)\}?/g, def: true },
  {
    re: /\bwe\s+(?:call|define|term|denote)\s+(?:the\s+|an?\s+|this\s+|it\s+)?([A-Za-z][\w\- ]*?)(?=\s+as\b|[.,;:()]|$)/gi,
    def: true,
  },
  {
    re: /\bwe\s+refer\s+to\s+.+?\s+as\s+(?:the\s+|an?\s+)?([A-Za-z][\w\- ]*?)(?=[.,;:()]|$)/gi,
    def: true,
  },
  {
    re: /([A-Z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,3})\s+(?:is|are)\s+defined\s+as\b/g,
    def: true,
  },
  { re: /\\(?:emph|textit|textbf)\{([^}]+)\}/g, def: true },
  { re: /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g, def: false },
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
