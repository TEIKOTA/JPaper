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
  env?: NodeJS.ProcessEnv;
  run?: typeof spawnSync;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

// Windows で見つからなければ code が "ENOENT" の Error を投げる。
export function resolveCommand(cmd: string, args: readonly string[], deps?: ResolveDeps): { command: string; args: string[] };
export function spawnOptions<const T extends SpawnOptions>(opts: T, platform?: NodeJS.Platform): Omit<T, "detached"> & { detached?: boolean; windowsHide?: boolean };
export function killTree(pid: number | undefined, signal?: NodeJS.Signals, deps?: KillDeps): void;
export function killChild(child: Pick<ChildProcess, "pid" | "kill"> & Partial<Pick<ChildProcess, "exitCode" | "signalCode">>, signal?: NodeJS.Signals, deps?: KillDeps): void;
