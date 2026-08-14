// 契約付録 §8。TeX の対になる区間（数式・環境）を線形時間で拾う共有走査。
//
// 遅延量指定子（/\\\[[\s\S]*?\\\]/g のような綴り）は、閉じが無い入力に対して開始位置ごとに
// 末尾まで走査するため二次になる。実測: 未閉じ \[ の羅列 128KiB で 1,079ms（render-notes の
// protectedMask）、見出しに詰めた 250KiB で 4,157ms（quality-gate の visibleText）。
// サイト単位で直すと同じ罠が別の場所に残るので、走査そのものをここに集約する。

export type Span = [start: number, end: number];

function escapedAt(tex: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && tex[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

// エスケープされていない次の出現。\\[2pt]（行送りの間隔指定）の \[ を表示数式の開始と
// 読むと、後続の本物の \[..\] と対になって間の地の文まで数式に入る。⚠ landmines.md
function nextUnescaped(tex: string, needle: string, from: number): number {
  for (let i = tex.indexOf(needle, from); i !== -1; i = tex.indexOf(needle, i + 1)) {
    if (!escapedAt(tex, i)) return i;
  }
  return -1;
}

// 開始・終了が別綴りの区間。閉じが見つからなければ以降のどの開始位置でも見つからないので
// 打ち切る（左から 1 回だけの走査＝線形）。
export function spansOf(tex: string, open: string, close: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; ; ) {
    const s = nextUnescaped(tex, open, i);
    if (s === -1) return out;
    const e = nextUnescaped(tex, close, s + open.length);
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

// $…$ と $$…$$。同じ綴りが開始と終了を兼ねるので専用に走る。\$ はエスケープ＝区切りでない。
// 閉じない $ は「以降にも無い」が成り立たない（同じ綴りが開閉を兼ねるため、
// ペアリングが 1 個ずれただけでも最後に余る）ので、打ち切らず**末尾までを数式とみなす**
// ＝ fail-closed。以降を素通しすると保護漏れになる。⚠ landmines.md
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
    if (e === -1) {
      out.push([i, tex.length]);
      return out;
    }
    out.push([i, e + delim.length]);
    i = e + delim.length - 1;
  }
  return out;
}

// 中身が TeX として解釈されない領域。ここの生の $ を数式の区切りと読むと、
// $ のペアリングが 1 個ずれて以降の保護が全部ずれる（実測: lstlisting 内の
// `echo $HOME` があるだけで、後続の $\mathrm{attention}(Q,K,V)$ の**内側**へ
// \footnote が入り組版が落ちた）。
const VERBATIM_ENVS = [
  "verbatim",
  "Verbatim",
  "lstlisting",
  "minted",
  "alltt",
  "comment",
  "semiverbatim",
  "filecontents",
];

// \verb<c>…<c> 系。区切り文字は直後の 1 文字（{ なら対応する } まで）。
// 綴りの直後に制御綴り文字が続くものは別コマンド。(?![a-zA-Z@]) を落とすと
// \verbatiminput{data.txt} の \verb 接頭辞に一致し、区切り文字 "a" で
// 偽の verbatim 区間 "\verbatiminput{da" を作る（\verbatiminput は実在の綴り）。
const VERB_CMDS = /\\(verb|lstinline|mintinline)\*?(?![a-zA-Z@])/g;

// \mintinline は言語を必須の第 1 引数に取る（\mintinline{python}{code}）。
// 言語を読み飛ばさないと {python} を code とみなし、**本当の code が無保護**になる。
// 実測: \mintinline{sh}{echo $HOME} で $ のペアリングが 1 個ずれ、数式をそのまま
// 持ち越した忠実な訳が math 不一致で落ちた（翻訳者に直しようがなく exit 3）。
const LANG_ARG_VERB = new Set(["mintinline"]);

export function verbatimSpans(tex: string): Span[] {
  const out: Span[] = [];
  for (const env of VERBATIM_ENVS) out.push(...envSpans(tex, env));
  VERB_CMDS.lastIndex = 0;
  for (const m of tex.matchAll(VERB_CMDS)) {
    let p = m.index + m[0].length;
    const skipSpace = (): void => {
      while (p < tex.length && /\s/.test(tex[p]!)) p++;
    };
    // オプション引数 [opts] を読み飛ばす。
    skipSpace();
    if (tex[p] === "[") {
      const close = tex.indexOf("]", p);
      if (close === -1) continue;
      p = close + 1;
      skipSpace();
    }
    // 言語引数 {lang} を読み飛ばす（区切り文字ではない）。
    if (LANG_ARG_VERB.has(m[1]!) && tex[p] === "{") {
      const close = tex.indexOf("}", p);
      if (close === -1) continue;
      p = close + 1;
      skipSpace();
    }
    if (p >= tex.length) continue;
    const open = tex[p]!;
    // { を区切りに使うのは lstinline/mintinline の {code} 形式。
    const close = open === "{" ? "}" : open;
    const e = tex.indexOf(close, p + 1);
    if (e === -1) {
      // 閉じない＝ここから末尾まで verbatim（fail-closed）。**その場で打ち切る**。
      // 続けると、閉じない \lstinline{ の羅列で候補ごとに末尾まで走査し（indexOf）、
      // さらに末尾までの区間を候補数だけ積んで maskChars も候補数×長さになる＝二次。
      // 実測（打ち切る前）: 512KB で mathSpans 5,545ms、2.2MB で 99 秒。
      // 打ち切っても結果は同じ（後続の候補はこの区間の内側にある）。⚠ landmines.md
      out.push([m.index, tex.length]);
      return out;
    }
    out.push([m.index, e + 1]);
  }
  return out;
}

// 区間を同じ長さの空白へ置き換える（添字は元文字列のまま使える）。
export function maskChars(tex: string, spans: Span[]): string {
  if (spans.length === 0) return tex;
  const buf = [...tex];
  for (const [s, e] of spans) for (let i = s; i < Math.min(e, buf.length); i++) buf[i] = " ";
  return buf.join("");
}

// 数式区間。verbatim を先に潰してから走るので、コード片の中の $ や \[ に釣られない。
// 返す添字は元の tex に対して有効。
// 数式環境の正本。保護（差し替え）と検査（照合）が別の一覧を持つと、
// 保護した区間が検査されない／検査される区間が保護されない、という食い違いになる。
export const MATH_ENVS = [
  "equation",
  "align",
  "gather",
  "multline",
  "eqnarray",
  "alignat",
  "flalign",
  "math",
  "displaymath",
];

export function mathSpans(tex: string, envs: readonly string[] = []): Span[] {
  const masked = maskChars(tex, verbatimSpans(tex));
  return [
    ...dollarSpans(masked),
    ...spansOf(masked, "\\[", "\\]"),
    ...spansOf(masked, "\\(", "\\)"),
    ...envs.flatMap((env) => envSpans(masked, env)),
  ];
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
