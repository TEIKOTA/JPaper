import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
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
  titleRaw?: string;
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
    if (isTitle(req)) {
      return opts.titleRaw ?? `\`\`\`tex\n${opts.titleJa ?? "\\title{甲の研究}\n% pdf-name: Alpha Study"}\n\`\`\``;
    }
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
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir, bilingual: false }, {
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
    // 名前の行は訳題と一緒に出させ、形式検査・evaluator・組版には渡さない（契約付録 §8「成果物 PDF の名前」）。
    expect(titleCalls[0]!.user).toContain("% pdf-name: <name>");
    const bodyTranslator = c.calls.filter((q) => !isTitle(q) && q.meta?.role === "translator");
    expect(bodyTranslator.every((q) => !q.user.includes("pdf-name"))).toBe(true);
    const titleEval = c.calls.filter((q) => isTitle(q) && q.meta?.role === "evaluator");
    expect(titleEval).toHaveLength(1);
    expect(titleEval[0]!.user).toContain("甲の研究");
    expect(titleEval[0]!.user).not.toContain("pdf-name");
    expect(seen[0]).not.toContain("pdf-name");
    expect(r.pdfPath).toBe(path.join(outDir, "p_alpha-study-ja.pdf"));
    expect(readFileSync(r.pdfPath!, "utf8")).toBe("%PDF");
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
    // 名前も checkpoint の title の結果から取る（再実行で変わらない）。
    expect(first.pdfPath).toBe(path.join(outDir, "p_alpha-study-ja.pdf"));
    expect(second.pdfPath).toBe(first.pdfPath);
    expect(second.summary.bilingual.pdfPath).toBe(path.join(outDir, "p_alpha-study-bilingual.pdf"));
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
    // title=failed の run は ID だけの名前。
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
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
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir, bilingual: false }, {
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
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    db.close();
  });

  it("構造起因の組版失敗では原題での組み直しをせず、テンプレへ進む（訳したタイトルのまま）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const runner = recordingRunner(seen, (tex) =>
      tex.includes("a4paper") ? undefined : "! LaTeX Error: File `a.cls' not found.",
    );
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir, bilingual: false }, {
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

  // arXiv の arxiv_style テンプレート（PathoROB 2507.17845）型: \title が \begin{document} の後、\maketitle の前。
  const BODY_TITLE_PAPER = [
    "\\documentclass{a}",
    "\\title{Preamble Draft}",
    "\\begin{document}",
    "",
    "\\title{\\textbf{Alpha Study}}",
    "\\author{A}",
    "\\maketitle",
    "\\section{Intro}Alpha text.",
    "\\section{Body}Beta text.",
    "\\end{document}",
  ].join("\n");

  // \title を伏せた印を保って返す本文 translator（seg-0000 が \title を含む節）。
  function bodyTitleClient(opts: { dropMark?: boolean } = {}): FakeLlmClient {
    const base = client({ titleJa: "\\title{\\textbf{甲の研究}}" });
    return new FakeLlmClient((req) => {
      if (req.meta?.segmentId === "seg-0000" && req.meta.role === "translator") {
        return `\`\`\`tex\n${opts.dropMark === true ? "" : "〔1〕\n"}\\author{A}\n\\maketitle\n\`\`\``;
      }
      return base.complete(req);
    });
  }

  it("本文中の \\title（\\maketitle より前）を title 節で 1 回だけ訳し、本文の \\title に差し戻す", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const c = bodyTitleClient();
    const r = await translatePaper(
      { kind: "path", path: paperTar(BODY_TITLE_PAPER) },
      { provider: "claude", outDir, bilingual: false },
      { client: c, db, latexRunner: recordingRunner(seen) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("translated");
    expect(r.summary.segments).toEqual({ total: 3, passed: 3, failed: 0 });
    expect(seen).toHaveLength(1);
    const [preamble, body] = seen[0]!.split("\\begin{document}");
    // 効くのは本文の \title。前文の \title は訳さず原文のまま。
    expect(preamble).toContain("\\title{Preamble Draft}");
    expect(body).toContain("\\title{\\textbf{甲の研究}}\n\\author{A}\n\\maketitle");
    expect(seen[0]).not.toContain("Alpha Study");
    // タイトルを訳すのは title 節だけ。本文の translator・evaluator には原題を見せない（二重に訳さない）。
    const titleCalls = c.calls.filter((q) => isTitle(q) && q.meta?.role === "translator");
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]!.user).toContain("\\title{\\textbf{Alpha Study}}");
    expect(titleCalls[0]!.user).not.toContain("Preamble Draft");
    const bodyCalls = c.calls.filter((q) => q.meta?.segmentId === "seg-0000");
    expect(bodyCalls.length).toBeGreaterThan(0);
    expect(bodyCalls.every((q) => !q.user.includes("Alpha Study"))).toBe(true);
    // 本文の訳文（chapters）には原題の命令が残り、差し替えは組版時だけ。
    const chapter = readFileSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"), "utf8");
    expect(chapter).toContain("\\title{\\textbf{Alpha Study}}");
    db.close();
  });

  it("本文中の \\title の訳で組版が翻訳起因に落ちたら、本文の \\title を原題に戻して組み直す", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const seen: string[] = [];
    const runner = recordingRunner(seen, (tex) => {
      if (!tex.includes("甲の研究")) return undefined;
      const line = tex.split("\n").findIndex((l) => l.includes("\\maketitle")) + 1;
      return `./main.tex:${String(line)}: Undefined control sequence.`;
    });
    const r = await translatePaper(
      { kind: "path", path: paperTar(BODY_TITLE_PAPER) },
      { provider: "claude", outDir, bilingual: false },
      { client: bodyTitleClient(), db, latexRunner: runner, onError: (m) => errs.push(m) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("failed");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("\\title{\\textbf{Alpha Study}}");
    expect(errs.some((e) => e.includes("訳したタイトルでは組版できなかった"))).toBe(true);
    db.close();
  });

  it("本文の \\title を伏せた印を落とし続けた節は title で落ちる（原題も訳題も黙って消さない）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const r = await translatePaper(
      { kind: "path", path: paperTar(BODY_TITLE_PAPER) },
      { provider: "claude", outDir, bilingual: false },
      { client: bodyTitleClient({ dropMark: true }), db, latexRunner: recordingRunner([]) },
    );
    expect(r.exitCode).toBe(3);
    expect(r.summary.segments.failed).toBe(1);
    db.close();
  });

  it("対訳 PDF の右側のタイトルブロックにも訳したタイトルが入る（左は原題）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: recordingRunner(seen),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("translated");
    expect(r.summary.bilingual.status).toBe("ok");
    expect(seen).toHaveLength(2);
    const bilingualTex = seen[1]!;
    expect(bilingualTex).toContain(
      "\\jpTitleBlock{Alpha Study\\thanks{Funded by X.}}\n\\switchcolumn\n\\jpTitleBlock{甲の研究\\thanks{Funded by X.}}",
    );
    db.close();
  });

  it("本文中の \\title の論文でも、対訳 PDF の右側のタイトルブロックに訳したタイトルが入る", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const r = await translatePaper(
      { kind: "path", path: paperTar(BODY_TITLE_PAPER) },
      { provider: "claude", outDir },
      { client: bodyTitleClient(), db, latexRunner: recordingRunner(seen) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("translated");
    expect(r.summary.bilingual.status).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/\\jpTitleBlock\{\\textbf\{Alpha Study\}\}\n\\switchcolumn\n\\jpTitleBlock\{\\textbf\{甲の研究\}\}/);
    db.close();
  });

  it("原題で組み直した run では、対訳 PDF の右側のタイトルも原題にする", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const runner = recordingRunner(seen, (tex) => {
      if (!tex.includes("甲の研究")) return undefined;
      const line = tex.split("\n").findIndex((l) => l.includes("訳文")) + 1;
      return `./main.tex:${String(line)}: Undefined control sequence.`;
    });
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("failed");
    expect(r.summary.bilingual.status).toBe("ok");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toContain("\\switchcolumn\n\\jpTitleBlock{Alpha Study\\thanks{Funded by X.}}");
    expect(seen[2]).not.toContain("甲の研究");
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
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    expect(r.summary.bilingual.pdfPath).toBe(path.join(outDir, "p-bilingual.pdf"));
    db.close();
  });

  it("本題がマクロ参照だけなら訳さず absent にし、警告して原題のまま組版する", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const c = client();
    const errs: string[] = [];
    const seen: string[] = [];
    const paper = PAPER.replace(
      "\\title{Alpha Study\\thanks{Funded by X.}}",
      "\\newcommand{\\papertitle}{Alpha Study}\n\\title{\\papertitle}",
    );
    const r = await translatePaper({ kind: "path", path: paperTar(paper) }, { provider: "claude", outDir }, {
      client: c,
      db,
      latexRunner: recordingRunner(seen),
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.title).toBe("absent");
    expect(c.calls.filter(isTitle)).toHaveLength(0);
    expect(seen[0]).toContain("\\title{\\papertitle}");
    expect(errs.some((e) => e.includes("地の文を含まない") && e.includes("\\papertitle"))).toBe(true);
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
    // translated は「訳を得て組版へ渡した」。PDF に入ったかは buildOk で判断する（契約付録 §8）。
    expect(r.summary.buildOk).toBeNull();
    expect(r.summary.title).toBe("translated");
    db.close();
  });

  it("組版が失敗した run（buildOk=false）でも訳を得ていれば translated", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const seen: string[] = [];
    const runner = recordingRunner(seen, () => "! LaTeX Error: File `a.cls' not found.");
    const r = await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir }, {
      client: client(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(5);
    expect(r.summary.buildOk).toBe(false);
    expect(r.summary.title).toBe("translated");
    expect(seen.every((t) => t.includes("甲の研究"))).toBe(true);
    db.close();
  });

  it("本文の翻訳中の例外で終わった run は、タイトルを訳し終えていても title が null", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const base = client();
    const c = new FakeLlmClient((req) => {
      if (!isTitle(req) && req.meta?.segmentId !== undefined && req.meta.role === "translator") {
        throw new Error("body provider down");
      }
      return base.complete(req);
    });
    const r = await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "claude", outDir, concurrency: 1 },
      { client: c, db, latexRunner: recordingRunner([]) },
    );
    expect(r.exitCode).not.toBe(0);
    expect(c.calls.some((q) => isTitle(q) && q.meta?.role === "evaluator")).toBe(true);
    expect(r.summary.title).toBeNull();
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

describe("成果物 PDF の名前（契約付録 §8）", () => {
  const run = async (
    outDir: string,
    c: FakeLlmClient,
    opts: { bilingual?: boolean } = {},
    runner: LatexRunner = recordingRunner([]),
  ) => {
    const db = new GlossaryDb();
    try {
      return await translatePaper({ kind: "path", path: paperTar() }, { provider: "claude", outDir, ...opts }, {
        client: c,
        db,
        latexRunner: runner,
      });
    } finally {
      db.close();
    }
  };

  it("訳題と一緒に出た名前で <ID>_<slug>-ja.pdf / -bilingual.pdf を出力先の直下に置く", async () => {
    const outDir = path.join(tmp(), "out");
    const r = await run(outDir, client());
    expect(r.exitCode).toBe(0);
    expect(r.pdfPath).toBe(path.join(outDir, "p_alpha-study-ja.pdf"));
    expect(r.summary.bilingual.status).toBe("ok");
    expect(r.summary.bilingual.pdfPath).toBe(path.join(outDir, "p_alpha-study-bilingual.pdf"));
    expect(readFileSync(r.summary.bilingual.pdfPath!, "utf8")).toBe("%PDF");
    const pdfs = readdirSync(outDir).filter((f) => f.endsWith(".pdf")).sort();
    expect(pdfs).toEqual(["p_alpha-study-bilingual.pdf", "p_alpha-study-ja.pdf"]);
  });

  it("囲みの外に書かれた名前の行も拾う", async () => {
    const outDir = path.join(tmp(), "out");
    const r = await run(
      outDir,
      client({ titleRaw: "```tex\n\\title{甲の研究}\n```\n% pdf-name: cellvit" }),
      { bilingual: false },
    );
    expect(r.summary.title).toBe("translated");
    expect(r.pdfPath).toBe(path.join(outDir, "p_cellvit-ja.pdf"));
  });

  it.each([
    ["名前の行が無い", "\\title{甲の研究}"],
    ["英数字が残らない名前", "\\title{甲の研究}\n% pdf-name: 甲の研究"],
    ["空の名前", "\\title{甲の研究}\n% pdf-name:"],
  ])("%s なら ID だけの名前にする", async (_name, titleJa) => {
    const outDir = path.join(tmp(), "out");
    const r = await run(outDir, client({ titleJa }));
    expect(r.summary.title).toBe("translated");
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    expect(r.summary.bilingual.pdfPath).toBe(path.join(outDir, "p-bilingual.pdf"));
  });

  it("前回と名前が変わったら、古い名前の成果物 PDF を残さない", async () => {
    const outDir = path.join(tmp(), "out");
    expect((await run(outDir, client({ titleJa: "\\title{甲の研究}\n% pdf-name: old-name" }))).exitCode).toBe(0);
    expect(existsSync(path.join(outDir, "p_old-name-ja.pdf"))).toBe(true);
    expect(existsSync(path.join(outDir, "p_old-name-bilingual.pdf"))).toBe(true);
    // title 節の checkpoint を消して、別の名前で訳し直させる。
    const steps = path.join(outDir, ".run", "steps");
    for (const f of readdirSync(steps).filter((x) => x.startsWith("title."))) rmSync(path.join(steps, f));
    const r = await run(outDir, client({ titleJa: "\\title{甲の研究}\n% pdf-name: new-name" }));
    expect(r.exitCode).toBe(0);
    expect(r.pdfPath).toBe(path.join(outDir, "p_new-name-ja.pdf"));
    const pdfs = readdirSync(outDir).filter((f) => f.endsWith(".pdf")).sort();
    expect(pdfs).toEqual(["p_new-name-bilingual.pdf", "p_new-name-ja.pdf"]);
  });

  it("対訳を作らなかった run（--no-bilingual・対訳の組版失敗）では前回の対訳の成果物 PDF を残さない", async () => {
    const outDir = path.join(tmp(), "out");
    await run(outDir, client());
    expect(existsSync(path.join(outDir, "p_alpha-study-bilingual.pdf"))).toBe(true);
    const disabled = await run(outDir, client(), { bilingual: false });
    expect(disabled.summary.bilingual.status).toBe("disabled");
    expect(existsSync(path.join(outDir, "p_alpha-study-ja.pdf"))).toBe(true);
    expect(existsSync(path.join(outDir, "p_alpha-study-bilingual.pdf"))).toBe(false);

    await run(outDir, client());
    const bilingualFails = recordingRunner([], (tex) =>
      tex.includes("\\begin{paracol}") ? "! LaTeX Error: File `paracol.sty' not found." : undefined,
    );
    const failed = await run(outDir, client(), {}, bilingualFails);
    expect(failed.summary.bilingual.status).toBe("failed");
    expect(failed.summary.bilingual.pdfPath).toBeUndefined();
    expect(readdirSync(outDir).filter((f) => f.endsWith(".pdf"))).toEqual(["p_alpha-study-ja.pdf"]);
  });

  it("和訳 PDF を組めなかった run は前回の成果物 PDF を壊さない", async () => {
    const outDir = path.join(tmp(), "out");
    await run(outDir, client());
    const r = await run(outDir, client(), {}, recordingRunner([], () => "! LaTeX Error: File `a.cls' not found."));
    expect(r.exitCode).toBe(5);
    expect(r.pdfPath).toBeUndefined();
    const pdfs = readdirSync(outDir).filter((f) => f.endsWith(".pdf")).sort();
    expect(pdfs).toEqual(["p_alpha-study-bilingual.pdf", "p_alpha-study-ja.pdf"]);
  });
});
