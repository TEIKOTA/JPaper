// テスト用の偽の外部 CLI（node で動く JS）。契約付録 §5「Windows」（issue #462）
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// body から使える: fs・args（argv の 3 番目以降）・readStdin()・argAfter(flag)。
const PRELUDE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  });
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};`;

// npm の cmd-shim 9 が置く .cmd と同じ書式（bin/spawn-cli.test.mjs の NPM_CODEX）。
const npmShim = (target: string): string =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");

// dir に name で起動できる偽の CLI を置く。POSIX は実行可能な name、Windows は name.cmd と name.cjs。
export function writeFakeCli(dir: string, name: string, body: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true });
  const js = `${PRELUDE}\n(async () => {\n${body}\n})().catch((e) => {\n  console.error(e);\n  process.exit(1);\n});\n`;
  if (platform !== "win32") {
    writeFileSync(path.join(dir, name), `#!/usr/bin/env node\n${js}`, { mode: 0o755 });
    return;
  }
  writeFileSync(path.join(dir, `${name}.cjs`), js);
  writeFileSync(path.join(dir, `${name}.cmd`), npmShim(`${name}.cjs`));
}
