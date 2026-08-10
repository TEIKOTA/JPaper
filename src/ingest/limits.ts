// 契約付録 §5・§8。信頼できない入力を扱うためのリソース上限（正本はここ 1 箇所）。
export interface IngestLimits {
  // 取得・読み込みするアーカイブの生バイト数。
  maxArchiveBytes: number;
  // 展開後の累積バイト数（圧縮爆弾の増幅を止める）。
  maxTotalBytes: number;
  // 単一エントリの展開後バイト数。
  maxEntryBytes: number;
  // エントリ数（数の爆発を止める）。
  maxEntries: number;
  // 取り込み後の LaTeX 本文（\input 展開込み）のバイト数。図（バイナリ）とは桁が違うので
  // 別に持つ。ここを図と同じ上限で見ていたため、40MB の .tex が既定で通っていた。
  maxLatexBytes: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxLatexBytes: 8 * 1024 * 1024,
};
