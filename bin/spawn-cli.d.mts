import type { ChildProcess, SpawnOptions, spawnSync } from "node:child_process";

export class ShimError extends Error {}

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  execPath?: string;
}

export interface KillDeps {
  platform?: NodeJS.Platform;
  run?: typeof spawnSync;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export function resolveCommand(cmd: string, args: readonly string[], deps?: ResolveDeps): { command: string; args: string[] };
export function spawnOptions<const T extends SpawnOptions>(opts: T, platform?: NodeJS.Platform): T;
export function killTree(pid: number | undefined, signal?: NodeJS.Signals, deps?: KillDeps): void;
export function killChild(child: Pick<ChildProcess, "pid" | "kill">, signal?: NodeJS.Signals, deps?: KillDeps): void;
