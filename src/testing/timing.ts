// 実時間で「計算量の桁」を見るテスト用の測定。1 回の実測は同居する重い処理に引きずられ、
// 桁違いの回帰しか見ていない閾値を負荷だけで割ってしまう（実測: Ollama 実行中の
// 全体のテスト実行で 2,247ms、単独実行では 230ms）。最小値は「邪魔が最も入らなかった試行」で、
// 遅い側へのノイズを落とす。速い側へのノイズは無いので、上限の断言に対して安全側に働く。
export function fastestMs(runs: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = Date.now();
    fn();
    best = Math.min(best, Date.now() - started);
  }
  return best;
}
