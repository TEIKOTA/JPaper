#!/usr/bin/env node
// jpaper コマンドの起動用のファイル。repo の更新を取り込んでから、src/cli.ts を tsx で読み、build せずに動かす。契約付録 §5
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selfUpdate } from "./self-update.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
selfUpdate({ root });
const { register } = await import("tsx/esm/api");
register({ tsconfig: join(root, "tsconfig.json") }); // ⚠ landmines.md
const { main } = await import(pathToFileURL(join(root, "src", "cli.ts")).href);
await main(process.argv);
