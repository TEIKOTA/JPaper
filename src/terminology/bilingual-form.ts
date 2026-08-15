// 契約付録 §1。併記形（日本語(原語)）の切り分けと正規化。
import type { ResolvedTerm } from "../types/contract.js";

// 末尾の `)` に対応する `(` の位置。後ろから深さを数える。最初の括弧で切ると、
// 日本語側に括弧を持つ語（分布外(OOD)データ(...)）で日本語部分が欠ける。
// ⚠ landmines.md
function lastGroupStart(s: string): number {
  const isOpen = (c: string): boolean => c === "(" || c === "（";
  const isClose = (c: string): boolean => c === ")" || c === "）";
  const end = s.length - 1;
  if (end < 0 || !isClose(s[end]!)) return -1;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = s[i]!;
    if (isClose(c)) depth++;
    else if (isOpen(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 併記形の日本語部分。末尾の括弧組を落とすだけで、日本語側の括弧は残す。
export function jaPartOf(form: string): string {
  const at = lastGroupStart(form);
  return (at < 0 ? form : form.slice(0, at)).trim();
}

// 併記形の原語部分は `src` そのもの＝契約で決まっている。モデルが書いた綴り
// （大文字化など）を採らず、配線側が原文の綴りを入れる。firstOccurrence を
// 配線側が付けているのと同じ扱い。契約付録 §1
export function canonicalBilingualForm(form: string, src: string): string {
  const ja = jaPartOf(form);
  return ja === "" ? src : `${ja}(${src})`;
}

// 末尾の原語併記だけを落とす。日本語側の括弧（分布外 (OOD) データ）は残る。
function withoutTrailingOriginal(form: string): string {
  const ja = jaPartOf(form);
  return ja === "" ? form : ja;
}

// form を rendering の契約に合わせる。
// - bilingual: 原語部分を src で固定する（モデルの綴りを採らない）
// - translate: 原語併記を落とす（translate は日本語のみ。併記は bilingual の初出だけ）
// - keep-original: 触らない（原表記そのものが form）
export function normalizeBilingualForms<T extends Pick<ResolvedTerm, "form" | "src" | "rendering">>(
  terms: readonly T[],
): T[] {
  return terms.map((t) => {
    if (t.rendering === "bilingual") return { ...t, form: canonicalBilingualForm(t.form, t.src) };
    if (t.rendering === "translate") return { ...t, form: withoutTrailingOriginal(t.form) };
    return t;
  });
}
