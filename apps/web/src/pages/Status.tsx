import type { Loaded } from "../load.js";

export function Status<T>(props: { loaded: Loaded<T> }) {
  if (props.loaded.state === "loading") return <p className="status">読み込んでいます…</p>;
  if (props.loaded.state === "error") return <p className="status error">{props.loaded.message}</p>;
  return null;
}
