import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue, spawnRunner, traceCost, type JobRunner, type ProcessExit, type ProcessSpec } from "./jobs.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-jobs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeProc {
  spec: ProcessSpec;
  line: (line: string, stream?: "stdout" | "stderr") => void;
  exit: (code: number | null, signal?: string | null) => void;
  killed: number;
}

function fakeRunner() {
  const procs: FakeProc[] = [];
  const runner: JobRunner = (spec, onLine) => {
    let resolve!: (e: ProcessExit) => void;
    const done = new Promise<ProcessExit>((r) => (resolve = r));
    const p: FakeProc = {
      spec,
      line: (line, stream = "stderr") => onLine(stream, line),
      exit: (code, signal = null) => resolve({ code, signal }),
      killed: 0,
    };
    procs.push(p);
    return {
      done,
      kill: () => {
        p.killed += 1;
        resolve({ code: null, signal: "SIGTERM" });
      },
    };
  };
  return { runner, procs };
}

const flush = () => new Promise((r) => setImmediate(r));

function setup(concurrency = 1) {
  const root = tmp();
  const articleDir = path.join(root, "article");
  const fake = fakeRunner();
  let limit = concurrency;
  const queue = new JobQueue({
    articleDir,
    repoRoot: root,
    concurrency: () => limit,
    runner: fake.runner,
    env: { JPAPER_HOME: path.join(root, "home") },
  });
  return { root, articleDir, queue, procs: fake.procs, setLimit: (n: number) => (limit = n) };
}

const claude = { provider: "claude" as const, model: "sonnet", effort: "medium" };

function writeTrace(outDir: string, records: object[]): void {
  mkdirSync(path.join(outDir, ".run"), { recursive: true });
  for (const r of records) appendFileSync(path.join(outDir, ".run", "llm-trace.jsonl"), `${JSON.stringify(r)}\n`);
}

describe("翻訳ジョブのキュー（契約付録 §9）", () => {
  it("既定の並行数 1: 1 本ずつ実行し、CLI の引数を配列で渡す", async () => {
    const { queue, procs, articleDir, root } = setup();
    const a = queue.enqueue({ arxivId: "2601.00001", options: claude, title: "A" });
    const b = queue.enqueue({ arxivId: "2601.00002v2", options: { provider: "ollama" } });
    expect(a.state).toBe("running");
    expect(b.state).toBe("queued");
    expect(procs).toHaveLength(1);
    const spec = procs[0]!.spec;
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toMatch(/tsx[\\/].*cli\.mjs$/);
    expect(spec.args.slice(1)).toEqual([
      path.join(root, "src", "cli.ts"),
      "2601.00001",
      "--provider",
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--out",
      path.join(articleDir, "2601.00001-ja"),
    ]);
    expect(spec.cwd).toBe(root);
    expect(spec.env).toEqual({ JPAPER_HOME: path.join(root, "home") });

    procs[0]!.exit(0);
    await flush();
    expect(queue.get(a.id)?.state).toBe("done");
    expect(queue.get(b.id)?.state).toBe("running");
    expect(procs[1]!.spec.args.slice(2)).toEqual([
      "2601.00002v2",
      "--provider",
      "ollama",
      "--out",
      path.join(articleDir, "2601.00002-ja"),
    ]);
  });

  it("並行数を上げると待機中のジョブがすぐ始まる", () => {
    const { queue, procs, setLimit } = setup(1);
    queue.enqueue({ arxivId: "2601.00001", options: claude });
    queue.enqueue({ arxivId: "2601.00002", options: claude });
    queue.enqueue({ arxivId: "2601.00003", options: claude });
    expect(procs).toHaveLength(1);
    setLimit(2);
    queue.pump();
    expect(procs).toHaveLength(2);
    expect(queue.list().map((j) => j.state)).toEqual(["running", "running", "queued"]);
  });

  it("進捗: stderr の行から段階・節 n/m、trace からこの実行の費用、ログの末尾", async () => {
    const { queue, procs, articleDir } = setup();
    const outDir = path.join(articleDir, "2601.00001-ja");
    writeTrace(outDir, [{ runId: "old-run", costUsd: 9 }]);
    const job = queue.enqueue({ arxivId: "2601.00001", options: claude });
    const p = procs[0]!;
    expect(queue.get(job.id)).toMatchObject({ phase: "ingest", costUsd: null });
    p.line("[取り込み] 完了");
    expect(queue.get(job.id)?.phase).toBe("context");
    writeTrace(outDir, [{ runId: "new-run", costUsd: 0.25 }, { runId: "new-run" }]);
    p.line("[文脈] 完了");
    p.line("[翻訳 1/3] seg-0001 ok (改稿 0/2)");
    p.line("\x1b[31m[翻訳 2/3] seg-0002 失敗 math (改稿 2/2)\x1b[0m");
    writeTrace(outDir, [{ runId: "new-run", costUsd: 0.5 }]);
    expect(queue.get(job.id)).toMatchObject({ phase: "translate", section: { done: 2, total: 3 }, costUsd: 0.75 });
    p.line("[翻訳 3/3] seg-0003 ok");
    expect(queue.get(job.id)?.phase).toBe("typeset");
    p.line("[組版] 完了");
    p.line("PDF: /x/y.pdf", "stdout");
    for (let i = 0; i < 40; i++) p.line(`line ${String(i)}`);
    const view = queue.get(job.id)!;
    expect(view.log).toHaveLength(30);
    expect(view.log.at(-1)).toBe("line 39");
    p.exit(0);
    await flush();
    expect(queue.get(job.id)).toMatchObject({ state: "done", exitCode: 0, costUsd: 0.75 });
    expect(queue.get(job.id)?.finishedAt).toBeGreaterThanOrEqual(view.startedAt!);
  });

  it("失敗: 「失敗[kind]: …」の行を理由にする。無ければ最後のエラー行・終了コード・シグナル", async () => {
    const { queue, procs } = setup(4);
    const a = queue.enqueue({ arxivId: "2601.00001", options: claude });
    const b = queue.enqueue({ arxivId: "2601.00002", options: claude });
    const c = queue.enqueue({ arxivId: "2601.00003", options: claude });
    const d = queue.enqueue({ arxivId: "2601.00004", options: claude });
    procs[0]!.line("エラー: 途中の警告");
    procs[0]!.line("失敗[provider]: claude CLI が見つかりません");
    procs[0]!.exit(2);
    procs[1]!.line("エラー: --model の値が不正です: x");
    procs[1]!.exit(2);
    procs[2]!.exit(1);
    procs[3]!.line("エラー: 単一ユーザ既定を使用");
    procs[3]!.exit(null, "SIGKILL");
    await flush();
    expect(queue.get(a.id)).toMatchObject({ state: "failed", exitCode: 2, error: "claude CLI が見つかりません（provider）" });
    expect(queue.get(b.id)).toMatchObject({ state: "failed", error: "--model の値が不正です: x" });
    expect(queue.get(c.id)).toMatchObject({ state: "failed", error: "CLI が終了コード 1 で終わりました" });
    expect(queue.get(d.id)).toMatchObject({ state: "failed", error: "CLI が止まりました（SIGKILL）" });
  });

  it("取り消し: 待機中は起動せずに取り消し、実行中はプロセスを止める。終わったジョブは取り消せない", async () => {
    const { queue, procs } = setup();
    const a = queue.enqueue({ arxivId: "2601.00001", options: claude });
    const b = queue.enqueue({ arxivId: "2601.00002", options: claude });
    expect(queue.cancel(b.id)?.state).toBe("canceled");
    expect(queue.cancel(a.id)?.state).toBe("running");
    expect(procs[0]!.killed).toBe(1);
    await flush();
    expect(queue.get(a.id)?.state).toBe("canceled");
    expect(procs).toHaveLength(1);
    expect(() => queue.cancel(a.id)).toThrow("既に終わっています");
    expect(queue.cancel("job-999")).toBeUndefined();
  });

  it("同じ論文（版違いを含む）の二重実行を拒む。終われば再び受け付ける", async () => {
    const { queue, procs } = setup();
    queue.enqueue({ arxivId: "2601.00001", options: claude });
    queue.enqueue({ arxivId: "2601.00002", options: claude });
    expect(() => queue.enqueue({ arxivId: "2601.00001v3", options: claude })).toThrow("既に実行中です");
    expect(() => queue.enqueue({ arxivId: "2601.00002", options: claude })).toThrow("既に待機中です");
    expect(queue.activePapers()).toEqual(
      new Map([
        ["2601.00001", "running"],
        ["2601.00002", "queued"],
      ]),
    );
    procs[0]!.exit(3);
    await flush();
    expect(queue.enqueue({ arxivId: "2601.00001", options: claude }).state).toBe("queued");
  });

  it("サーバ終了: 待機中は取り消し、実行中は止める", async () => {
    const { queue, procs } = setup();
    const a = queue.enqueue({ arxivId: "2601.00001", options: claude });
    const b = queue.enqueue({ arxivId: "2601.00002", options: claude });
    queue.shutdown();
    await flush();
    expect(procs[0]!.killed).toBe(1);
    expect(queue.get(a.id)?.state).toBe("canceled");
    expect(queue.get(b.id)?.state).toBe("canceled");
    expect(procs).toHaveLength(1);
  });

  it("費用: 開始前からあった runId の記録と、壊れた行は数えない", () => {
    const outDir = tmp();
    writeTrace(outDir, [{ runId: "a", costUsd: 1 }, { runId: "b", costUsd: 2 }]);
    appendFileSync(path.join(outDir, ".run", "llm-trace.jsonl"), '{"runId":"b","cost');
    writeFileSync(path.join(outDir, ".run", "llm-trace.jsonl.1"), `${JSON.stringify({ runId: "b", costUsd: 4 })}\n`);
    expect(traceCost(outDir, new Set(["a"]))).toBe(6);
    expect(traceCost(outDir, new Set(["a", "b"]))).toBeNull();
  });
});

describe("子プロセスの起動（spawnRunner）", () => {
  it("行ごとに読み、取り消しはプロセスグループ（孫を含む）ごと止める", async () => {
    const root = tmp();
    const script = path.join(root, "fake-cli.mjs");
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "console.log(`grandchild ${g.pid}`);",
        'process.stderr.write("[取り込み] 完了\\n[文脈]");',
        'process.stderr.write(" 完了\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const lines: string[] = [];
    let grandchild = 0;
    const proc = spawnRunner({ command: process.execPath, args: [script], cwd: root, env: process.env }, (s, l) => {
      lines.push(`${s}:${l}`);
      const m = /^grandchild (\d+)$/.exec(l);
      if (m) grandchild = Number(m[1]);
    });
    for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(lines).toEqual(expect.arrayContaining(["stderr:[取り込み] 完了", "stderr:[文脈] 完了"]));
    expect(grandchild).toBeGreaterThan(0);
    proc.kill();
    const exit = await proc.done;
    expect(exit.signal).toBe("SIGTERM");
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("CLI を模したスクリプトで、キューが実プロセスの終了と進捗を受け取る", async () => {
    const root = tmp();
    const script = path.join(root, "fake-cli.mjs");
    writeFileSync(
      script,
      [
        'process.stderr.write("[取り込み] 完了\\n[文脈] 完了\\n[翻訳 1/1] seg-0001 ok\\n[組版] 完了\\n");',
        'process.stderr.write("失敗[build]: 組版に失敗しました\\n");',
        "process.exit(5);",
      ].join("\n"),
    );
    const queue = new JobQueue({
      articleDir: path.join(root, "article"),
      repoRoot: root,
      concurrency: () => 1,
      command: (args) => ({ command: process.execPath, args: [script, ...args] }),
    });
    const job = queue.enqueue({ arxivId: "2601.00001", options: { provider: "ollama" } });
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({
      state: "failed",
      exitCode: 5,
      phase: "typeset",
      section: { done: 1, total: 1 },
      error: "組版に失敗しました（build）",
    });
  });
});
