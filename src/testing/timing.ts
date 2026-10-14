// fn を runs 回走らせ、1 回あたりのプロセスの CPU 時間（user + system）の最小値をミリ秒で返す。
// 実測（#377。\graphicspath の宣言数のテスト、関係する 16 ファイルの並列実行）: 実時間 2,469〜2,868ms、
// CPU 時間 997〜1,094ms。単独実行では実時間・CPU 時間とも 540〜562ms。
export function fastestMs(runs: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = process.cpuUsage();
    fn();
    const used = process.cpuUsage(started);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}
