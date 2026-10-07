// 契約付録 §9（Web アプリ）。API の読み込み状態。
import { useCallback, useEffect, useState } from "react";

export type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): [Loaded<T>, () => void] {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const run = useCallback(fn, deps);
  useEffect(() => {
    let live = true;
    run().then(
      (data) => live && setLoaded({ state: "ok", data }),
      (e: unknown) => live && setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [run, tick]);
  return [loaded, () => setTick((t) => t + 1)];
}

export function includesFold(hay: string | null | undefined, needle: string): boolean {
  return (hay ?? "").toLowerCase().includes(needle.trim().toLowerCase());
}
