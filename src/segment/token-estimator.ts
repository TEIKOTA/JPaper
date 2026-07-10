// 契約付録 §4。プロバイダ非依存の決定的トークン推定器（分割・sizeClass が揺れない固定実装）。
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(other / 4) + cjk;
}
