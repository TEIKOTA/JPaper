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

// fn を ms ごとに呼び直す。reload で即座に呼び直す。
export function usePoll<T>(fn: () => Promise<T>, ms: number): [Loaded<T>, () => void] {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      fn().then(
        (data) => live && setLoaded({ state: "ok", data }),
        (e: unknown) => live && setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e) }),
      ).finally(() => {
        if (live) timer = setTimeout(run, ms);
      });
    };
    run();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ms, tick]);
  return [loaded, () => setTick((t) => t + 1)];
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
