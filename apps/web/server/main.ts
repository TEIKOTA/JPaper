// 契約付録 §9（Web アプリ）。API を 127.0.0.1 で起動する。終了時は待機中のジョブを取り消し、実行中の翻訳を止める。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp, createServices } from "./app.js";
import { apiPortFromEnv, configFromEnv, HOST, REPO_ROOT } from "./config.js";
import { describeDotEnv, loadDotEnv } from "../../../src/env-file.js";

// ジョブの CLI と同じ repo 直下の .env を、設定を読む前に読む。契約付録 §8・§9
const dotenv = loadDotEnv(path.join(REPO_ROOT, ".env"));
if (dotenv.error !== undefined) {
  console.error(`エラー: .env を読めません: ${dotenv.error}`);
  process.exit(2);
}
for (const line of describeDotEnv(dotenv)) console.log(line);
const config = configFromEnv();
mkdirSync(path.dirname(config.dbPath), { recursive: true });
const port = apiPortFromEnv();
const services = createServices(config);
const server = serve({ fetch: createApp(config, services).fetch, hostname: HOST, port }, (info) => {
  console.log(`JPaper API: http://${HOST}:${String(info.port)}`);
  console.log(`  論文: ${config.articleDir}`);
  console.log(`  全体の用語 DB: ${config.dbPath}`);
  console.log(`  設定: ${config.settingsPath}`);
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  services.jobs.shutdown();
  server.close();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop);
process.on("exit", () => services.jobs.shutdown());
