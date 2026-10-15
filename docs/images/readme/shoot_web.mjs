// README の Web アプリの画面のスクリーンショットを撮る（issue #418）。
// 使い方: node docs/images/readme/shoot_web.mjs <画面の URL> [<出力先>]
//   例: node docs/images/readme/shoot_web.mjs http://127.0.0.1:5173
// 前提: Google Chrome。Web アプリは、公開できる論文だけを置いた article/ と、空の JPAPER_HOME で立ち上げておく。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const WIDTH = 1280;
const HEIGHT = 820;
const PAPER = "2606.22649";
const QUERY = "Mahalanobis out-of-distribution";
const TERM = "OOD";

const [url, outArg] = process.argv.slice(2);
if (url === undefined) {
  console.error("使い方: node docs/images/readme/shoot_web.mjs <画面の URL> [<出力先>]");
  process.exit(2);
}
const outDir = outArg ?? path.dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), "jpaper-shoot-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--lang=ja", "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
const pending = new Map();
const connect = async () => {
  const failed = new Promise((_, reject) => chrome.once("error", reject));
  const ready = (async () => {
    let targets = [];
    for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
      await sleep(200);
      try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      } catch {}
    }
    const page = targets.find((t) => t.type === "page");
    if (page === undefined) throw new Error("Chrome のページに接続できない");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools に接続できない")), { once: true });
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
  })();
  await Promise.race([ready, failed]);
};
let seq = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (expr, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await evaluate(expr)) return;
    await sleep(200);
  }
  throw new Error(`timeout: ${expr}`);
};
const open = async (hash, ready) => {
  await send("Page.navigate", { url: `${url}/${hash}` });
  await waitFor(ready);
  await sleep(500);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, name), Buffer.from(data, "base64"));
  console.log(`shot ${path.join(outDir, name)}`);
};
const text = (selector, pattern) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => ${pattern}.test(e.textContent ?? ""))`;

try {
  await connect();
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await open(`#/search?q=${encodeURIComponent(QUERY)}`, text("main", "/件中/"));
  await shot("web-search.png");
  await open(`#/translate?id=${PAPER}`, `!!document.querySelector('main form')`);
  await shot("web-translate.png");
  await open(`#/papers/${PAPER}`, text("main", "/分布外/"));
  await shot("web-paper.png");
  await open(`#/papers/${PAPER}/terms/${encodeURIComponent(TERM)}`, `!!document.querySelector('#new-ja')`);
  await shot("web-term.png");
} finally {
  ws?.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
