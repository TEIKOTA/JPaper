import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJpaperHome } from "../config.js";
// isolate-env.ts は import しない（import すると setupFiles が無くても副作用で隔離され、検査が空振りする）。
const REAL_HOME_ENV = "JPAPER_TEST_REAL_HOME";
const REAL_TMPDIR_ENV = "JPAPER_TEST_REAL_TMPDIR";

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

describe("テストの環境の隔離（#484）", () => {
  const realHome = process.env[REAL_HOME_ENV] as string;
  const realTmp = process.env[REAL_TMPDIR_ENV] as string;

  it("実の HOME・tmpdir を記録している", () => {
    expect(realHome).toBeTruthy();
    expect(realTmp).toBeTruthy();
  });

  it("os.homedir() と JPAPER_HOME が実の HOME の外を指す", () => {
    expect(os.homedir()).not.toBe(realHome);
    expect(within(os.homedir(), realTmp)).toBe(true);
    expect(within(resolveJpaperHome(), os.homedir())).toBe(true);
    expect(existsSync(resolveJpaperHome())).toBe(false);
  });

  it("os.tmpdir() が共有の一時 dir の下の専用 dir を指し、TEMP・TMP も同じ", () => {
    expect(os.tmpdir()).not.toBe(realTmp);
    expect(within(os.tmpdir(), realTmp)).toBe(true);
    expect(process.env.TEMP).toBe(os.tmpdir());
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.USERPROFILE).toBe(os.homedir());
  });

  it("mkdtemp(os.tmpdir()) が専用 dir の下に作られる", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "iso-"));
    try {
      expect(within(d, realTmp)).toBe(true);
      expect(d.startsWith(os.tmpdir())).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
