// 契約付録 §9（Web アプリ）。翻訳ジョブのキュー。CLI を子プロセスで起動し、stderr の進捗行と
// LLM トレースから状態を作る。ジョブはサーバのメモリだけに持つ。
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { derivePaperId } from "../../../src/ingest/index.js";
import { JpaperError } from "../../../src/types/errors.js";
import { cliArgs, type TranslateOptions } from "./translate-options.js";

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";
export type JobPhase = "ingest" | "context" | "translate" | "typeset";

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface RunningProcess {
  done: Promise<ProcessExit>;
  // 子プロセスのプロセスグループごと止める。
  kill(): void;
}

export type JobRunner = (spec: ProcessSpec, onLine: (stream: "stdout" | "stderr", line: string) => void) => RunningProcess;

export interface JobView {
  id: string;
  arxivId: string;
  paperId: string;
  title?: string;
  options: TranslateOptions;
  state: JobState;
  phase?: JobPhase;
  section?: { done: number; total: number };
  costUsd: number | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  log: string[];
}

interface Job extends Omit<JobView, "log" | "costUsd"> {
  outDir: string;
  log: string[];
  cancelRequested: boolean;
  proc?: RunningProcess;
  knownRunIds?: Set<string>;
  finalCost?: number | null;
  lastError?: string;
}

export const LOG_KEEP = 200;
export const LOG_VIEW = 30;
const LINE_MAX = 1000;
const FINISHED_KEEP = 50;
const KILL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 2000;

// CLI が「エラー: 」付きで出す通知。失敗理由にしない。
const SHARED_DEFAULT_NOTICE = "単一ユーザ既定を使用";

const PROGRESS_DONE: Record<string, JobPhase> = { 取り込み: "context", 文脈: "translate", 組版: "typeset" };

export function traceFiles(outDir: string): string[] {
  const base = path.join(outDir, ".run", "llm-trace.jsonl");
  return [`${base}.1`, base];
}

interface TraceRecord {
  runId?: unknown;
  costUsd?: unknown;
}

function readTrace(outDir: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const file of traceFiles(outDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as TraceRecord);
      } catch {
        // 書きかけの行は読み飛ばす。
      }
    }
  }
  return out;
}

export function traceRunIds(outDir: string): Set<string> {
  return new Set(readTrace(outDir).flatMap((r) => (typeof r.runId === "string" ? [r.runId] : [])));
}

// known に無い runId の記録の costUsd の合計。費用の記録が 1 件も無ければ null。
export function traceCost(outDir: string, known: ReadonlySet<string>): number | null {
  let sum: number | null = null;
  for (const r of readTrace(outDir)) {
    if (typeof r.runId !== "string" || known.has(r.runId)) continue;
    if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) sum = (sum ?? 0) + r.costUsd;
  }
  return sum;
}

function traceStamp(outDir: string): string {
  return traceFiles(outDir)
    .map((f) => {
      try {
        const s = statSync(f);
        return `${String(s.size)}:${String(s.mtimeMs)}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

export function cleanLine(line: string): string {
  const s = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s;
}

// 既定の起動: repo の tsx で src/cli.ts を動かす（シェルを通さない）。
export function cliCommand(repoRoot: string, args: string[]): { command: string; args: string[] } {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return { command: process.execPath, args: [tsxCli, path.join(repoRoot, "src", "cli.ts"), ...args] };
}

export const spawnRunner: JobRunner = (spec, onLine) => {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(name, buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    });
    stream.on("end", () => {
      if (buf !== "") onLine(name, buf);
      buf = "";
    });
  }
  const done = new Promise<ProcessExit>((resolve) => {
    child.on("error", (e) => {
      onLine("stderr", `起動できませんでした: ${e.message}`);
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
    // 孫プロセスが出力を握ったまま残っても、終了から一定時間で終わったものとする。
    child.on("exit", (code, signal) => {
      setTimeout(() => resolve({ code, signal }), CLOSE_GRACE_MS).unref();
    });
  });
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // 既に終わっている。
    }
  };
  let exited = false;
  void done.then(() => {
    exited = true;
  });
  return {
    done,
    kill: () => {
      signalGroup("SIGTERM");
      setTimeout(() => {
        if (!exited) signalGroup("SIGKILL");
      }, KILL_GRACE_MS).unref();
    },
  };
};

export interface JobQueueDeps {
  articleDir: string;
  repoRoot: string;
  concurrency: () => number;
  runner?: JobRunner;
  command?: (args: string[]) => { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface EnqueueRequest {
  arxivId: string;
  options: TranslateOptions;
  title?: string;
}

export class JobQueue {
  private readonly jobs: Job[] = [];
  private seq = 0;
  private readonly runner: JobRunner;
  private readonly now: () => number;
  private readonly costCache = new Map<string, { stamp: string; cost: number | null }>();

  constructor(private readonly deps: JobQueueDeps) {
    this.runner = deps.runner ?? spawnRunner;
    this.now = deps.now ?? Date.now;
  }

  enqueue(req: EnqueueRequest): JobView {
    const paperId = derivePaperId({ kind: "arxiv", id: req.arxivId });
    const active = this.jobs.find((j) => j.paperId === paperId && (j.state === "queued" || j.state === "running"));
    if (active !== undefined) {
      throw new JpaperError(2, "conflict", `${req.arxivId} は既に${active.state === "running" ? "実行中" : "待機中"}です`);
    }
    this.seq += 1;
    const job: Job = {
      id: `job-${String(this.seq)}`,
      arxivId: req.arxivId,
      paperId,
      ...(req.title === undefined ? {} : { title: req.title }),
      options: req.options,
      outDir: path.join(this.deps.articleDir, `${paperId}-ja`),
      state: "queued",
      createdAt: this.now(),
      log: [],
      cancelRequested: false,
    };
    this.jobs.push(job);
    this.pump();
    return this.view(job);
  }

  list(): JobView[] {
    return this.jobs.map((j) => this.view(j));
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.find((j) => j.id === id);
    return job === undefined ? undefined : this.view(job);
  }

  // 待機中・実行中の論文 ID → 状態。
  activePapers(): Map<string, JobState> {
    return new Map(
      this.jobs.filter((j) => j.state === "queued" || j.state === "running").map((j) => [j.paperId, j.state]),
    );
  }

  cancel(id: string): JobView | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (job === undefined) return undefined;
    if (job.state === "queued") {
      job.state = "canceled";
      job.finishedAt = this.now();
      this.trim();
    } else if (job.state === "running") {
      job.cancelRequested = true;
      job.proc?.kill();
    } else {
      throw new JpaperError(2, "conflict", "このジョブは既に終わっています");
    }
    return this.view(job);
  }

  // 並行数の空きがあれば待機中のジョブを起動する。
  pump(): void {
    const limit = Math.max(1, this.deps.concurrency());
    let running = this.jobs.filter((j) => j.state === "running").length;
    for (const job of this.jobs) {
      if (running >= limit) break;
      if (job.state !== "queued") continue;
      this.start(job);
      running += 1;
    }
  }

  // サーバ終了時: 待機中は取り消し、実行中は止める。
  shutdown(): void {
    for (const job of this.jobs) {
      if (job.state === "queued") {
        job.state = "canceled";
        job.finishedAt = this.now();
      } else if (job.state === "running") {
        job.cancelRequested = true;
        job.proc?.kill();
      }
    }
  }

  // 実行中のジョブが全部終わるまで待つ（テスト用）。
  async idle(): Promise<void> {
    for (;;) {
      const running = this.jobs.filter((j) => j.state === "running" && j.proc !== undefined);
      if (running.length === 0) return;
      await Promise.all(running.map((j) => j.proc!.done));
      await new Promise((r) => setImmediate(r));
    }
  }

  private start(job: Job): void {
    job.state = "running";
    job.phase = "ingest";
    job.startedAt = this.now();
    job.knownRunIds = traceRunIds(job.outDir);
    const args = cliArgs(job.arxivId, job.options, job.outDir);
    const cmd = (this.deps.command ?? ((a) => cliCommand(this.deps.repoRoot, a)))(args);
    const env = { ...(this.deps.env ?? process.env) };
    try {
      job.proc = this.runner({ ...cmd, cwd: this.deps.repoRoot, env }, (stream, line) => this.onLine(job, stream, line));
    } catch (e) {
      this.onLine(job, "stderr", `起動できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      this.finish(job, { code: null, signal: null });
      return;
    }
    void job.proc.done.then((exit) => this.finish(job, exit));
  }

  private onLine(job: Job, stream: "stdout" | "stderr", raw: string): void {
    const line = cleanLine(raw);
    job.log.push(line);
    if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
    if (stream !== "stderr") return;
    const done = /^\[(取り込み|文脈|組版)\] 完了$/.exec(line);
    if (done) {
      job.phase = PROGRESS_DONE[done[1]!]!;
      return;
    }
    const seg = /^\[翻訳 (\d+)\/(\d+)\]/.exec(line);
    if (seg) {
      const d = Number(seg[1]);
      const t = Number(seg[2]);
      job.section = { done: d, total: t };
      job.phase = d >= t ? "typeset" : "translate";
      return;
    }
    const fail = /^失敗\[([^\]]+)\]: (.*)$/.exec(line);
    if (fail) {
      job.error = `${fail[2]!}（${fail[1]!}）`;
      return;
    }
    const err = /^(?:エラー|想定外エラー): (.*)$/.exec(line);
    if (err && !err[1]!.startsWith(SHARED_DEFAULT_NOTICE)) job.lastError = err[1]!;
  }

  private finish(job: Job, exit: ProcessExit): void {
    if (job.state !== "running") return;
    job.finishedAt = this.now();
    job.exitCode = exit.code;
    job.finalCost = this.cost(job);
    this.costCache.delete(job.id);
    job.proc = undefined;
    if (job.cancelRequested) {
      job.state = "canceled";
    } else if (exit.code === 0) {
      job.state = "done";
    } else {
      job.state = "failed";
      job.error ??=
        exit.code === null
          ? `CLI が止まりました（${exit.signal ?? "起動失敗"}）`
          : (job.lastError ?? `CLI が終了コード ${String(exit.code)} で終わりました`);
    }
    this.trim();
    this.pump();
  }

  private trim(): void {
    const finished = this.jobs.filter((j) => j.state === "done" || j.state === "failed" || j.state === "canceled");
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) {
      this.jobs.splice(this.jobs.indexOf(old), 1);
      this.costCache.delete(old.id);
    }
  }

  private cost(job: Job): number | null {
    if (job.finalCost !== undefined) return job.finalCost;
    if (job.knownRunIds === undefined) return null;
    const stamp = traceStamp(job.outDir);
    const hit = this.costCache.get(job.id);
    if (hit !== undefined && hit.stamp === stamp) return hit.cost;
    const cost = traceCost(job.outDir, job.knownRunIds);
    this.costCache.set(job.id, { stamp, cost });
    return cost;
  }

  private view(job: Job): JobView {
    return {
      id: job.id,
      arxivId: job.arxivId,
      paperId: job.paperId,
      ...(job.title === undefined ? {} : { title: job.title }),
      options: job.options,
      state: job.state,
      ...(job.phase === undefined ? {} : { phase: job.phase }),
      ...(job.section === undefined ? {} : { section: job.section }),
      costUsd: this.cost(job),
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.error === undefined ? {} : { error: job.error }),
      log: job.log.slice(-LOG_VIEW),
    };
  }
}
