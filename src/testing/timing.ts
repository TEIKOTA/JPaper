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

// Windows の CPU 時間は POSIX より重い。windows-latest の全スイート併走の実測は、同じ検査の Linux 併走の 2.9〜3.2 倍
// （main-tex 指数展開 2,235ms 対 758ms、resolve の existsSync 予算いっぱい 3,110ms 対 974ms）。
// ⚠ landmines.md
export const WINDOWS_BUDGET_FACTOR = 3;

// 時間の閾値（POSIX 基準のミリ秒）を実行 OS に合わせて返す。POSIX ではそのまま、Windows では WINDOWS_BUDGET_FACTOR 倍。
export function budgetMs(posixMs: number, platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? posixMs * WINDOWS_BUDGET_FACTOR : posixMs;
}
