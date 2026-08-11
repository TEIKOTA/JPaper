// 契約付録 §8。TeX の対になる区間（数式・環境）を線形時間で拾う共有走査。
//
// 遅延量指定子（/\\\[[\s\S]*?\\\]/g のような綴り）は、閉じが無い入力に対して開始位置ごとに
// 末尾まで走査するため二次になる。実測: 未閉じ \[ の羅列 128KiB で 1,079ms（render-notes の
// protectedMask）、見出しに詰めた 250KiB で 4,157ms（quality-gate の visibleText）。
// サイト単位で直すと同じ罠が別の場所に残るので、走査そのものをここに集約する。

export type Span = [start: number, end: number];

// 開始・終了が別綴りの区間。閉じが見つからなければ以降のどの開始位置でも見つからないので
// 打ち切る（左から 1 回だけの走査＝線形）。
export function spansOf(tex: string, open: string, close: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; ; ) {
    const s = tex.indexOf(open, i);
    if (s === -1) return out;
    const e = tex.indexOf(close, s + open.length);
    if (e === -1) return out;
    out.push([s, e + close.length]);
    i = e + close.length;
  }
}

// 環境（\begin{name} … \end{name}）。* 付きも同じ区間として扱う。
export function envSpans(tex: string, name: string): Span[] {
  return [
    ...spansOf(tex, `\\begin{${name}}`, `\\end{${name}}`),
    ...spansOf(tex, `\\begin{${name}*}`, `\\end{${name}*}`),
  ];
}

function escapedAt(tex: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && tex[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

// $…$ と $$…$$。同じ綴りが開始と終了を兼ねるので専用に走る。\$ はエスケープ＝区切りでない。
export function dollarSpans(tex: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] !== "$" || escapedAt(tex, i)) continue;
    const double = tex[i + 1] === "$";
    const delim = double ? "$$" : "$";
    let e = -1;
    for (let j = i + delim.length; j < tex.length; j++) {
      if (tex[j] === "$" && !escapedAt(tex, j) && (!double || tex[j + 1] === "$")) {
        e = j;
        break;
      }
    }
    if (e === -1) return out;
    out.push([i, e + delim.length]);
    i = e + delim.length - 1;
  }
  return out;
}

// 区間を空白へ潰す（長さは保たない）。地の文の抽出用。
export function blankSpans(tex: string, spans: Span[]): string {
  if (spans.length === 0) return tex;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [s, e] of sorted) {
    if (s < at) continue; // 入れ子・重複は外側だけ使う
    out += `${tex.slice(at, s)} `;
    at = e;
  }
  return out + tex.slice(at);
}
