import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const file = path.resolve(import.meta.dirname, "../../.github/workflows/node-flake-scan.yml");
type Step = { run?: string; shell?: string };
type Workflow = {
  name: string;
  on: { schedule?: { cron: string }[] };
  jobs: Record<string, { strategy: { matrix: { os: string[] } }; "timeout-minutes"?: number; steps: Step[] }>;
};
const wf = parse(readFileSync(file, "utf8")) as Workflow;

describe("node-flake-scan workflow（#484）", () => {
  it("定期実行で、ubuntu と windows の両方を回す", () => {
    expect(wf.name).toBe("node-flake-scan");
    expect(wf.on.schedule?.length).toBeGreaterThan(0);
    expect(wf.jobs.scan?.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
  });

  it("ハングした回が Actions の時間を食わないよう、job に上限がある", () => {
    expect(wf.jobs.scan?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(wf.jobs.scan?.["timeout-minutes"]).toBeLessThanOrEqual(120);
  });

  it("pnpm test を 3 回まわし、途中で落ちても残りの回を続け、1 回でも落ちたら failure にする", () => {
    const step = wf.jobs.scan?.steps.find((s) => s.run?.includes("pnpm test"));
    expect(step?.shell).toBe("bash");
    expect(step?.run).toContain("for i in 1 2 3");
    expect(step?.run).not.toMatch(/^\s*set -e/m);
    expect(step?.run).toContain('[ "$failed" -eq 0 ]');
  });
});
