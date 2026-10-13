// 契約付録 §5（.env の読み込み）。issue #273。
// 作業ディレクトリの .env を読み、プロセスの環境変数に載せる。既にある環境変数は上書きしない。
// 無ければ何もしない。読めない・壊れているならその理由を返す。
export function loadDotEnv(
  file = ".env",
  load: (path: string) => void = (p) => process.loadEnvFile(p),
): { error?: string } {
  try {
    load(file);
    return {};
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return {};
    return { error: String((e as Error)?.message ?? e) };
  }
}
