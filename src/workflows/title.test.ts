import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { LlmRequest } from "../types/contract.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-title-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAPER = [
  "\\documentclass{a}",
  "\\title{Alpha Study\\thanks{Funded by X.}}",
  "\\author{A}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{Intro}Alpha text.",
  "\\section{Body}Beta text.",
  "\\end{document}",
].join("\n");

function paperTar(content = PAPER): string {
  const p = path.join(tmp(), "p.tar");
  writeFileSync(p, makeTar([{ name: "main.tex", content }]));
  return p;
}

const isTitle = (req: LlmRequest): boolean => req.meta?.segmentId === "title";

// title 節への応答だけを差し替えられる fake。
function client(opts: {
  titleJa?: string;
  titleVerdict?: "pass" | "fail";
  titleThrows?: boolean;
} = {}): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [{ src: "Alpha", form: "甲", class: "established", rendering: "translate" }],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (isTitle(req) && opts.titleThrows === true) throw new Error("title provider down");
    if (req.system.includes("審査者")) {
      const v = isTitle(req) ? (opts.titleVerdict ?? "pass") : "pass";
      return `{"verdict":"${v}","issues":[]}`;
    }
    if (isTitle(req)) return `\`\`\`tex\n${opts.titleJa ?? "\\title{甲の研究}"}\n\`\`\``;
    return "```tex\n\\section{節}訳文\n```";
  });
}

function recordingRunner(seen: string[], fail?: (tex: string) => string | undefined): LatexRunner {
  return (dir) => {
    const tex = readFileSync(path.join(dir, "main.tex"), "utf8");
    seen.push(tex);
    const log = fail?.(tex);
    if (log !== undefined) return { code: 1, log };
    writeFileSync(path.join(dir, "main.pdf"), "%PDF");
    return { code: 0, log: "Output written on main.pdf (1 page)." };
  };
}

describe("論文タイトルの翻訳（契約付録 §8）", () => {
  it("訳したタイトルが和訳の前文 \\title に入り、\\thanks は原文のまま残る", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const c = client();
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: c,
      db,
      latexRunner: recordingRunner(seen),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("translated");
    // タイトルは segments の集計に入れない。
    expect(r.summary.segments).toEqual({ total: 3, passed: 3, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("\\title{甲の研究\\thanks{Funded by X.}}");
    expect(seen[0]).not.toContain("Alpha Study");
    // 用語集が効く（title 節の translator へ確定用語が載る）。\thanks は翻訳へ送らない。
    const titleCalls = c.calls.filter((q) => isTitle(q) && q.meta?.role === "translator");
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]!.user).toContain("\\title{Alpha Study}");
    expect(titleCalls[0]!.user).not.toContain("Funded");
    expect(titleCalls[0]!.user).toContain("甲");
    db.close();
  });

  it("タイトル翻訳は checkpoint され、2 回目は LLM を呼ばない（prune でも消えない）", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = paperTar();
    const db = new GlossaryDb();
    const first = await translatePaper({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: recordingRunner([]),
    });
    expect(first.summary.title).toBe("translated");
    expect(readdirSync(path.join(outDir, ".run", "steps")).some((f) => f.startsWith("title."))).toBe(true);
    const c2 = client();
    const seen: string[] = [];
    const second = await translatePaper({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: c2,
      db,
      latexRunner: recordingRunner(seen),
    });
    expect(second.summary.title).toBe("translated");
    expect(c2.calls.filter(isTitle)).toHaveLength(0);
    expect(seen[0]).toContain("\\title{甲の研究\\thanks{Funded by X.}}");
    db.close();
  });

  it.each([
    ["品質未達", { titleVerdict: "fail" as const }, "品質基準に達しない"],
    ["訳文に \\title が無い", { titleJa: "甲の研究" }, "\\title が無い"],
    ["形式検査を通らない（\\\\ の脱落）", { titleJa: "\\title{甲の研究}" }, "symbol-command"],
    ["プロバイダ例外", { titleThrows: true }, "title provider down"],
  ])("失敗（%s）しても原題のまま組版し、警告して exit 0", async (_name, opts, why) => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const seen: string[] = [];
    const paper =
      why === "symbol-command" ? PAPER.replace("Alpha Study", "Alpha:\\\\ Study") : PAPER;
    const r = await translatePaper({ kind: "path", path: paperTar(paper) }, { provider: "claude", outDir }, {
      client: client(opts),
      db,
      latexRunner: recordingRunner(seen),
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.summary.title).toBe("failed");
    expect(r.summary.segments).toEqual({ total: 3, passed: 3, failed: 0 });
    const original = paper.split("\n")[1]!;
    expect(seen[0]).toContain(original);
    const warn = errs.find((e) => e.includes("原題のまま"));
    expect(warn).toBeDefined();
    expect(warn).toContain(why);
    // 失敗したタイトルは checkpoint しない（次の run で訳し直す）。
    expect(readdirSync(path.join(outDir, ".run", "steps")).some((f) => f.startsWith("title."))).toBe(false);
    db.close();
  });

  it("タイトル翻訳中の中断は握り潰さず run を中断で返す（exit 6）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const ctrl = new AbortController();
    const base = client();
    const c = new FakeLlmClient((req) => {
      if (isTitle(req)) {
        ctrl.abort();
        return new Promise<string>(() => undefined);
      }
      return base.complete(req);
    });
    const r = await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "claude", outDir, signal: ctrl.signal, concurrency: 1 },
      { client: c, db, latexRunner: recordingRunner([]) },
    );
    expect(r.exitCode).toBe(6);
    expect(r.error?.kind).toBe("canceled");
    db.close();
  });

  it("タイトルの訳文が危険コマンドを持ち込んだら汚染として警告し、原題のまま組版する", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const seen: string[] = [];
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client({ titleJa: "\\title{甲の研究\\immediate\\write18{x}}" }),
      db,
      latexRunner: recordingRunner(seen),
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("failed");
    expect(seen[0]).not.toContain("write18");
    expect(errs.some((e) => e.includes("タイトルの訳文") && e.includes("汚染の疑い"))).toBe(true);
    db.close();
  });

  it("訳したタイトルで組版が翻訳起因に落ちたら原題で組み直し、警告して exit 0", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const seen: string[] = [];
    // 本文セグメントの行（\maketitle が展開される位置）でエラーになる＝訳したタイトルが原因の形。
    const runner = recordingRunner(seen, (tex) => {
      if (!tex.includes("甲の研究")) return undefined;
      const line = tex.split("\n").findIndex((l) => l.includes("訳文")) + 1;
      return `./main.tex:${String(line)}: Undefined control sequence.`;
    });
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.buildOk).toBe(true);
    expect(r.summary.layout).toBe("original");
    expect(r.summary.title).toBe("failed");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("\\title{Alpha Study\\thanks{Funded by X.}}");
    expect(errs.some((e) => e.includes("訳したタイトルでは組版できなかった"))).toBe(true);
    db.close();
  });

  it("構造起因の組版失敗では原題での組み直しをせず、テンプレへ進む（訳したタイトルのまま）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const runner = recordingRunner(seen, (tex) =>
      tex.includes("a4paper") ? undefined : "! LaTeX Error: File `a.cls' not found.",
    );
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.layout).toBe("template");
    expect(r.summary.title).toBe("translated");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("\\title{甲の研究\\thanks{Funded by X.}}");
    db.close();
  });

  it("\\title が無い論文ではタイトル節を作らない（absent）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const c = client();
    const r = await translatePaper(
      { kind: "path", path: paperTar(PAPER.replace(/\\title\{.*\}\n/, "")) },
      { provider: "claude", outDir },
      { client: c, db, latexRunner: recordingRunner([]) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("absent");
    expect(c.calls.filter(isTitle)).toHaveLength(0);
    db.close();
  });

  it("本文の節が落ちた run でもタイトルの結果は summary に出る（exitCode は節だけで決まる）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) {
        return `{"verdict":"${isTitle(req) ? "pass" : "fail"}","issues":[]}`;
      }
      return isTitle(req) ? "```tex\n\\title{甲の研究}\n```" : "```tex\n\\section{節}訳文\n```";
    });
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: c,
      db,
      latexRunner: recordingRunner([]),
    });
    expect(r.exitCode).toBe(4);
    expect(r.summary.segments.failed).toBe(3);
    expect(r.summary.title).toBe("translated");
    db.close();
  });

  it("翻訳まで到達しなかった run の title は null", async () => {
    const db = new GlossaryDb();
    const r = await translatePaper(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "claude", outDir: path.join(tmp(), "out") },
      { client: client(), db, latexRunner: recordingRunner([]) },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.summary.title).toBeNull();
    db.close();
  });
});
