// fn を runs 回走らせ、1 回あたりのプロセスの CPU 時間（user + system）の最小値をミリ秒で返す。
// ⚠ landmines.md
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
