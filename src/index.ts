export const APP_NAME = "JPaper";

export function main(): void {
  // TODO: jpaper CLI を実装（WP5）。
  console.log(`${APP_NAME}: 論文和訳エージェント (scaffold)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
