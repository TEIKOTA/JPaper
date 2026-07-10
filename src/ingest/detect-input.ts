// 契約付録 §5・§8。<input> 文字列を JpaperInput へ正規化。
import { existsSync } from "node:fs";
import type { JpaperInput } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";

const ARXIV_NEW = /^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_OLD = /^(?:arxiv:)?([a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/\d{7})(v\d+)?$/i;

export function detectInput(
  raw: string,
  exists: (p: string) => boolean = existsSync,
): JpaperInput {
  const s = raw.trim();
  if (s === "") throw new JpaperError(2, "input", "<input> が空です");
  if (exists(s)) return { kind: "path", path: s };
  const mNew = ARXIV_NEW.exec(s);
  if (mNew) return { kind: "arxiv", id: `${mNew[1]}${mNew[2] ?? ""}` };
  const mOld = ARXIV_OLD.exec(s);
  if (mOld) return { kind: "arxiv", id: `${mOld[1]}${mOld[2] ?? ""}` };
  throw new JpaperError(2, "input", `入力形態を判定できません: ${raw}`);
}
