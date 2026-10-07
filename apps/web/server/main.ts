// 契約付録 §9（Web アプリ）。API を 127.0.0.1 で起動する。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { apiPortFromEnv, configFromEnv, HOST } from "./config.js";

const config = configFromEnv();
mkdirSync(path.dirname(config.dbPath), { recursive: true });
const port = apiPortFromEnv();
serve({ fetch: createApp(config).fetch, hostname: HOST, port }, (info) => {
  console.log(`JPaper 用語集 API: http://${HOST}:${String(info.port)}`);
  console.log(`  論文: ${config.articleDir}`);
  console.log(`  全体の用語 DB: ${config.dbPath}`);
});
