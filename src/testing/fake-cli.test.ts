import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand } from "../../bin/spawn-cli.mjs";
import { writeFakeCli } from "./fake-cli.js";

const BODY = `const input = await readStdin();\nprocess.stdout.write(JSON.stringify({ args, after: argAfter("-o") ?? null, stdin: input.length }));`;

describe("writeFakeCli", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "jpaper-fakecli-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("POSIX では実行可能な name を置き、引数と stdin を読める", () => {
    const dir = path.join(root, "posix");
    writeFakeCli(dir, "tool", BODY, "linux");
    expect(readdirSync(dir)).toEqual(["tool"]);
    expect(statSync(path.join(dir, "tool")).mode & 0o111).not.toBe(0);
    const r = spawnSync(path.join(dir, "tool"), ["-o", "x y"], { input: "abc", encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ args: ["-o", "x y"], after: "x y", stdin: 3 });
  });

  it("Windows では npm 形式の .cmd を置き、resolveCommand が中の JS を node で起動する", () => {
    const dir = path.join(root, "win");
    writeFakeCli(dir, "tool", BODY, "win32");
    expect(readdirSync(dir).sort()).toEqual(["tool.cjs", "tool.cmd"]);
    const winDir = path.win32.resolve(dir);
    const toHost = (p: string): string => (process.platform === "win32" ? p : p.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/"));
    const cmd = resolveCommand("tool", ["-o", "x y"], {
      platform: "win32",
      env: { PATH: winDir, PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS" },
      exists: (p) => p === path.win32.join(winDir, "tool.cmd"),
      read: (p) => readFileSync(toHost(p), "utf8"),
      execPath: process.execPath,
    });
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual([path.win32.join(winDir, "tool.cjs"), "-o", "x y"]);
    const r = spawnSync(cmd.command, [toHost(cmd.args[0]!), ...cmd.args.slice(1)], { input: "abc", encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ args: ["-o", "x y"], after: "x y", stdin: 3 });
  });
});
