export const APP_NAME = "JPaper";

export { translatePaper } from "./workflows/translate-paper.js";
export type { TranslateOptions, TranslateDeps } from "./workflows/translate-paper.js";
export { runCli } from "./cli.js";
export type { JpaperInput, Result, RunSummary } from "./types/contract.js";
