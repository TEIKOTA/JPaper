// JPaper — 論文和訳に最適化された決定的専門エージェント
// エントリポイント。実装は docs/adr の設計方針に従って段階的に追加する。

export const APP_NAME = "JPaper";

export function main(): void {
  // TODO: src/workflows/*.ts のワークフローを起動する jpaper CLI を実装する。
  //       配線・順序・終了判定は TS で固定し、訳出・品質判定は LLM に委ねる。
  console.log(`${APP_NAME}: 論文和訳エージェント (scaffold)`);
}

// `tsx src/index.ts` のように直接実行されたときだけ main を呼ぶ。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
