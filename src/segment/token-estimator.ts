// 契約付録 §4。プロバイダ非依存の決定的トークン推定器（分割・sizeClass が揺れない固定実装）。
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

// 文字種の数え上げ。加法的なので、連結した文字列を数え直さずに足し込める
// （数え直すと段落を足すたびに全体を走査して二次になる）。
export interface CharCounts {
  cjk: number;
  other: number;
}

export function countChars(text: string): CharCounts {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return { cjk, other };
}

// 丸めは合計してから 1 度だけ掛ける（連結してから数えた値と一致する）。
export function tokensOf(counts: CharCounts): number {
  return Math.ceil(counts.other / 4) + counts.cjk;
}

export function estimateTokens(text: string): number {
  return tokensOf(countChars(text));
}
