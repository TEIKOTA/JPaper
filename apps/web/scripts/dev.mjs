// 契約付録 §9（Web アプリ）。API（tsx）と画面（vite）を一緒に立ち上げる。どちらかが終われば両方止める。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const env = {
  ...process.env,
  JPAPER_ARTICLE_DIR: path.resolve(root, process.env.JPAPER_ARTICLE_DIR?.trim() || "article"),
  ...(process.env.JPAPER_GLOSSARY_DB?.trim()
    ? { JPAPER_GLOSSARY_DB: path.resolve(root, process.env.JPAPER_GLOSSARY_DB.trim()) }
    : {}),
  ...(process.env.JPAPER_HOME?.trim() ? { JPAPER_HOME: path.resolve(root, process.env.JPAPER_HOME.trim()) } : {}),
};
// 動いている間は <repo>/.jpaper-web/<pid> を置く。契約付録 §5
const pidFile = path.join(root, ".jpaper-web", String(process.pid));
mkdirSync(path.dirname(pidFile), { recursive: true });
writeFileSync(pidFile, "");
process.on("exit", () => rmSync(pidFile, { force: true }));
const children = [
  spawn("pnpm", ["--filter", "@jpaper/web", "run", "server"], { stdio: "inherit", env }),
  spawn("pnpm", ["--filter", "@jpaper/web", "run", "dev"], { stdio: "inherit", env }),
];
let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  process.exitCode = code;
};
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop(0));
