import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSkill, main } from "./check-skill-frontmatter.js";

const REPO_SKILLS = path.join(import.meta.dirname, "..", ".claude", "skills");
const dirs: string[] = [];

function skill(name: string, lines: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-fm-"));
  dirs.push(root);
  mkdirSync(path.join(root, name));
  const file = path.join(root, name, "SKILL.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function run(root: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main([root], { stdout: (s) => (out += s), stderr: (s) => (err += s) }, REPO_SKILLS);
  return { code, out, err };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("skill の frontmatter 検査（issue #416）", () => {
  it("正常な YAML と必須キーを受理する", () => {
    const f = skill("valid", ["---", "name: valid", "description: Use when a valid fixture is needed.", "---", "# Valid"]);
    expect(checkSkill(f)).toEqual([]);
    expect(run(path.dirname(path.dirname(f)))).toMatchObject({ code: 0, out: "OK: skill frontmatter 1 件\n" });
  });

  it.each([
    ["malformed", ["---", "name: malformed", "description: [broken", "---"], "YAML として読めません"],
    ["missing-description", ["---", "name: missing-description", "---"], "必須の description"],
    ["missing-name", ["---", "description: Use when a fixture without a name is needed.", "---"], "name は 1〜64 文字"],
    ["missing-trigger", ["---", "name: missing-trigger", "description: Valid YAML without an invocation condition.", "---"], "起動条件"],
    ["unterminated", ["---", "name: unterminated", "description: Use when testing an unterminated frontmatter block."], "終了 marker"],
    ["too-long", ["---", "name: too-long", `description: Use when ${"x".repeat(1020)}`, "---"], "1024 文字以内"],
    ["no-start", ["name: no-start", "description: Use when x.", "---"], "開始 marker"],
    ["wrong-dir", ["---", "name: other", "description: Use when x.", "---"], "親 directory 名"],
    ["not-a-map", ["---", "- a", "---"], "YAML map"],
    ["alias", ["---", "name: &n alias", "description: *n", "---"], "alias"],
    ["dated", ["---", "name: dated", "description: Use when x.", "since: 2026-10-15", "---"], "日付"],
  ])("%s を拒否する", (name, lines, message) => {
    const f = skill(name, [...lines, "# body"]);
    const errors = checkSkill(f);
    expect(errors.join("\n")).toContain(message);
    expect(run(path.dirname(path.dirname(f))).code).toBe(1);
  });

  it("description の長さは文字数で数える（1024 文字ちょうどは受理）", () => {
    const f = skill("multibyte", ["---", "name: multibyte", `description: "Use when ${"あ".repeat(1024 - 9)}"`, "---"]);
    expect(checkSkill(f)).toEqual([]);
  });

  it("SKILL.md が無ければ exit 1", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-fm-"));
    dirs.push(root);
    expect(run(root)).toMatchObject({ code: 1 });
  });

  it("repository の全 skill が正常", () => {
    expect(run(REPO_SKILLS).code).toBe(0);
  });

  it("fix-issue は description 全文と issue 引数メタデータを保持する", () => {
    const text = readFileSync(path.join(REPO_SKILLS, "fix-issue", "SKILL.md"), "utf8");
    const meta = parse(text.split(/^---\s*$/m, 3)[1]!) as Record<string, unknown>;
    expect(meta.description).toContain("#12");
    expect(meta.arguments).toEqual(["issue"]);
    expect(meta["argument-hint"]).toBe("[issue-number]");
  });
});
