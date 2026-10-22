import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// vitest の globalSetup（実の環境で動く）。全テストの前後で実の ~/.jpaper を比べ、テストが実の HOME を書いたら落とす（#484）。
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(d, name);
      try {
        const st = statSync(full);
        out.push(`${full}\t${st.isDirectory() ? "dir" : st.size}\t${st.mtimeMs}`);
        if (st.isDirectory()) walk(full);
      } catch {
        // 消えた
      }
    }
  };
  walk(dir);
  return out;
}

export default function setup(): () => void {
  const dir = path.join(os.homedir(), ".jpaper");
  const before = snapshot(dir);
  return () => {
    const after = snapshot(dir);
    if (before.join("\n") !== after.join("\n")) {
      const added = after.filter((l) => !before.includes(l));
      const removed = before.filter((l) => !after.includes(l));
      throw new Error(
        `テストが実の ${dir} を変更した（#484）。追加・変更: ${JSON.stringify(added)} 削除・変更前: ${JSON.stringify(removed)}`,
      );
    }
  };
}
