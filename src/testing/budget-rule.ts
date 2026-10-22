// fastestMs の結果を budgetMs を通さずに上限と比べる書き方を探す（issue #484、landmines.md の fastestMs の項）。
// 呼び出しの行か直前の行にこの印があれば検査しない（時間の閾値でなく測定どうしの比を見る検査など）。
const EXEMPT_MARK = /budget-exempt:/;

export type BudgetViolation = { line: number; reason: string };

// コメントと文字列・テンプレートの中身を空白にする（長さと改行は保つ）。
function mask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const template = (start: number): number => {
    let i = start + 1;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "`") i = template(i);
          else if (c === '"' || c === "'") i = quoted(i);
          else {
            if (c === "{") depth++;
            else if (c === "}") depth--;
            i++;
          }
        }
      } else i++;
    }
    blank(start + 1, i);
    return i + 1;
  };
  const quoted = (start: number): number => {
    let i = start + 1;
    while (i < src.length && src[i] !== src[start] && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
    blank(start + 1, i);
    return i + 1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "`") i = template(i);
    else if (c === '"' || c === "'") i = quoted(i);
    else i++;
  }
  return out.join("");
}

// open の位置の "(" に対応する ")" の次の位置。無ければ -1。
function closeParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

export function findUnbudgetedComparisons(source: string): BudgetViolation[] {
  const masked = mask(source);
  const sourceLines = source.split("\n");
  // 引数の中身は mask で消えているので、budgetMs( の有無は元の文字列で見る。
  const hasBudget = (from: number, to: number): boolean => /\bbudgetMs\s*\(/.test(source.slice(from, to));
  const found: BudgetViolation[] = [];
  // after は expect(...) を閉じた ")" の次の位置。マッチャが続けば true（上限の比較なら budgetMs の有無も検査する）。
  const checkMatcher = (after: number, line: number): boolean => {
    const m = /^\s*\.\s*(?:not\s*\.\s*)?(\w+)\s*\(/.exec(masked.slice(after));
    if (!m) return false;
    if (m[1] === "toBeLessThan" || m[1] === "toBeLessThanOrEqual") {
      const open = after + m[0].length - 1;
      if (!hasBudget(open, closeParen(masked, open))) {
        found.push({ line, reason: `fastestMs の結果を budgetMs を通さずに ${m[1]} で比べている` });
      }
    }
    return true;
  };
  for (const m of masked.matchAll(/\bfastestMs\s*\(/g)) {
    const callStart = m.index ?? 0;
    const line = lineOf(source, callStart);
    if (EXEMPT_MARK.test(sourceLines[line - 1] ?? "") || EXEMPT_MARK.test(sourceLines[line - 2] ?? "")) continue;
    const end = closeParen(masked, callStart + m[0].length - 1);
    if (end < 0) {
      found.push({ line, reason: "fastestMs の呼び出しの閉じ括弧が見つからない" });
      continue;
    }
    const before = masked.slice(0, callStart);
    const assigned = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(before);
    if (assigned) {
      const name = (assigned[1] as string).replace(/\$/g, "\\$");
      let used = false;
      for (const u of masked.slice(end).matchAll(new RegExp(`\\bexpect\\s*\\(\\s*${name}\\s*\\)`, "g"))) {
        used = true;
        const at = end + (u.index ?? 0) + u[0].length;
        checkMatcher(at, lineOf(source, at));
      }
      for (const u of masked.slice(end).matchAll(new RegExp(`(?<![\\w$.])${name}\\s*<=?(?!\\s*budgetMs)`, "g"))) {
        used = true;
        found.push({ line: lineOf(source, end + (u.index ?? 0)), reason: `fastestMs の結果 ${assigned[1]} を budgetMs を通さずに < で比べている` });
      }
      if (!used) found.push({ line, reason: "fastestMs の結果の使い方を判別できない（expect(<変数>).toBeLessThan(budgetMs(…)) の形にする）" });
      continue;
    }
    const direct = /\bexpect\s*\(\s*$/.test(before);
    const tail = /^\s*,?\s*\)/.exec(masked.slice(end));
    if (direct && tail && checkMatcher(end + tail[0].length, line)) continue;
    found.push({ line, reason: "fastestMs の結果の使い方を判別できない（expect(fastestMs(…)).toBeLessThan(budgetMs(…)) の形にする）" });
  }
  return found;
}
