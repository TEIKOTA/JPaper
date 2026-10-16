import { describe, expect, it } from "vitest";
import type { PaperSummary } from "../api.js";
import { sortPapers } from "./PapersPage.js";

function paper(id: string, titleJa: string, createdAt: string, updatedAt: string): PaperSummary {
  return { id, titleJa, termCount: 0, pdf: { ja: false, bilingual: false }, createdAt, updatedAt };
}

const PAPERS = [
  paper("a", "生成", "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z"),
  paper("b", "安定", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
  paper("c", "画像", "2026-09-30T00:00:00.000Z", "2026-10-05T00:00:00.000Z"),
  paper("d", "安定", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
];

const ids = (order: Parameters<typeof sortPapers>[1]) => sortPapers(PAPERS, order).map((p) => p.id);

describe("論文の一覧の並び順（契約付録 §9）", () => {
  it("更新日・作成日の新しい順と古い順、同じ日時は ID の順", () => {
    expect(ids("updated-desc")).toEqual(["c", "a", "b", "d"]);
    expect(ids("updated-asc")).toEqual(["b", "d", "a", "c"]);
    expect(ids("created-desc")).toEqual(["b", "d", "a", "c"]);
    expect(ids("created-asc")).toEqual(["c", "a", "b", "d"]);
  });

  it("タイトル順は日本語のタイトルで並べ、元の配列を変えない", () => {
    expect(ids("title")).toEqual(["b", "d", "c", "a"]);
    expect(PAPERS.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
