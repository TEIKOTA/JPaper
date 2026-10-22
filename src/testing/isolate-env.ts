import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// vitest の setupFiles。テストファイル（forks の 1 プロセス）ごとに HOME・JPAPER_HOME・一時 dir を専用の dir へ向け、
// 実の HOME（~/.jpaper の署名鍵など）や共有の os.tmpdir() をテストが読み書きしないようにする（#484）。
// 実の値は REAL_HOME_ENV / REAL_TMPDIR_ENV に残す（隔離の検査用）。
const REAL_HOME_ENV = "JPAPER_TEST_REAL_HOME";
const REAL_TMPDIR_ENV = "JPAPER_TEST_REAL_TMPDIR";

const realHome = os.homedir();
const realTmp = os.tmpdir();
const root = mkdtempSync(path.join(realTmp, "jpaper-test-"));
const home = path.join(root, "home");
const tmp = path.join(root, "tmp");
mkdirSync(home);
mkdirSync(tmp);

process.env[REAL_HOME_ENV] = realHome;
process.env[REAL_TMPDIR_ENV] = realTmp;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.JPAPER_HOME = path.join(home, ".jpaper");
process.env.TMPDIR = tmp;
process.env.TEMP = tmp;
process.env.TMP = tmp;

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
