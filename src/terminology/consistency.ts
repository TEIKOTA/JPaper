// 契約付録 §3。用語集の内部矛盾（同じ語の表記揺れ）を LLM 無しで拾う。
import type { ResolvedRow } from "./glossary-io.js";

// 片仮名の連なりだけを見る。訳語の揺れはほぼ音訳で起き、漢字語では起きにくい
// （実測: ハウスドルフ距離 と ハウスドッフ距離 が 1 つの用語集に同居した）。
// 長音符・中黒は語の一部として扱う。
const KATAKANA_RUN = /[ァ-ヴー・]{4,}/g;

// 短い列は別語の衝突（パス / バス）が起きやすいので、比較は 5 文字以上に限る。
const MIN_COMPARE = 5;

// 用語集で照合するのは訳語だけ。原表記のまま残す語は比較しない。
const COMPARED_RENDERINGS = new Set(["translate", "bilingual"]);

// 併記形は `訳語(原語)` なので、訳語部分だけを取り出す。原語は**末尾**の括弧なので、
// 最初の括弧で切ると訳語の中の括弧で切れる（実測: 「修正（95パーセンタイル）ハウス
// ドッフ距離(...)」が「修正」になり、揺れの検出対象から消えた）。
const TRAILING_PAREN = /^(.*)[(（][^(（)）]*[)）]\s*$/s;

export function japaneseFormOf(form: string): string {
  return (TRAILING_PAREN.exec(form)?.[1] ?? form).trim();
}

export function katakanaRuns(text: string): string[] {
  return text.match(KATAKANA_RUN) ?? [];
}

// 編集距離が limit を超えるかだけを見る（距離そのものは要らない）。
// 全体を埋めずに帯だけ回す。用語集は小さいが、本文へ広げても効くようにしておく。
export function withinEditDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j] ?? 0);
    }
    if (best > limit) return false; // この行より下は改善しない
    prev = cur;
  }
  return (prev[b.length] ?? 0) <= limit;
}

export interface Inconsistency {
  a: string;
  b: string;
  terms: string[];
}

// 1 文字違いの片仮名列を「同じ語の揺れ」として拾う。落とさず警告に留める
// （語形の違い（ベクタ / ベクター）も揺れではあるが、断定はしない）。
export function findKatakanaDrift(rows: ResolvedRow[]): Inconsistency[] {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!COMPARED_RENDERINGS.has(row.rendering)) continue;
    for (const run of katakanaRuns(japaneseFormOf(row.form))) {
      if (run.length < MIN_COMPARE) continue;
      const set = owners.get(run) ?? new Set<string>();
      set.add(row.src);
      owners.set(run, set);
    }
  }
  const runs = [...owners.keys()].sort();
  const found: Inconsistency[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]!;
      const b = runs[j]!;
      if (!withinEditDistance(a, b, 1)) continue;
      found.push({
        a,
        b,
        terms: [...new Set([...(owners.get(a) ?? []), ...(owners.get(b) ?? [])])].sort(),
      });
    }
  }
  return found;
}

export function describeDrift(d: Inconsistency): string {
  return `用語集の表記揺れ: 「${d.a}」と「${d.b}」が同居しています（${d.terms.join(" / ")}）`;
}
