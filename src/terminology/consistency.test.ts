import { describe, it, expect } from "vitest";
import {
  findKatakanaDrift,
  japaneseFormOf,
  katakanaRuns,
  withinEditDistance,
  describeDrift,
} from "./consistency.js";
import type { ResolvedRow } from "./glossary-io.js";

const row = (src: string, form: string, rendering = "bilingual"): ResolvedRow => ({
  src,
  form,
  class: "paper-defined",
  rendering,
});

describe("withinEditDistance", () => {
  it("1 文字違いを拾い、2 文字違いは拾わない", () => {
    expect(withinEditDistance("ハウスドルフ", "ハウスドッフ", 1)).toBe(true);
    expect(withinEditDistance("ハウスドルフ", "ハウスドッホ", 1)).toBe(false);
    expect(withinEditDistance("ベクタ", "ベクター", 1)).toBe(true);
    expect(withinEditDistance("セグメンテーション", "データセット", 1)).toBe(false);
  });

  it("長さ差が limit を超えたら中身を見ない", () => {
    expect(withinEditDistance("データ", "データセット", 1)).toBe(false);
  });
});

describe("japaneseFormOf", () => {
  it("併記形から訳語だけを取り出す（全角・半角の括弧とも）", () => {
    expect(japaneseFormOf("ハウスドルフ距離(Hausdorff distance)")).toBe("ハウスドルフ距離");
    expect(japaneseFormOf("分布シフト（distribution shift）")).toBe("分布シフト");
    expect(japaneseFormOf("敵対的サンプル")).toBe("敵対的サンプル");
  });

  it("訳語の中の括弧では切らない（原語は末尾の括弧）", () => {
    expect(japaneseFormOf("修正（95パーセンタイル）ハウスドッフ距離(modified HD)")).toBe(
      "修正（95パーセンタイル）ハウスドッフ距離",
    );
  });
});

describe("katakanaRuns", () => {
  it("4 文字以上の片仮名の連なりだけを返す（長音・中黒を含む）", () => {
    expect(katakanaRuns("重み付き平均ダイス類似係数")).toEqual([]);
    expect(katakanaRuns("ハウスドルフ距離")).toEqual(["ハウスドルフ"]);
    expect(katakanaRuns("セグメンテーション手法とベンチマークデータセット")).toEqual([
      "セグメンテーション",
      "ベンチマークデータセット",
    ]);
  });
});

describe("findKatakanaDrift", () => {
  it("同じ用語集に同居する 1 文字違いの音訳を拾う（実測した ハウスドルフ / ハウスドッフ）", () => {
    const drift = findKatakanaDrift([
      row("Hausdorff distance", "ハウスドルフ距離(Hausdorff distance)"),
      row(
        "modified (95th-percentile) Hausdorff distance (HD95)",
        "修正（95パーセンタイル）ハウスドッフ距離(modified Hausdorff distance)",
      ),
    ]);
    expect(drift).toHaveLength(1);
    expect([drift[0]?.a, drift[0]?.b].sort()).toEqual(["ハウスドッフ", "ハウスドルフ"]);
    expect(describeDrift(drift[0]!)).toContain("表記揺れ");
  });

  it("語の挿入は揺れとして扱わない（分布シフト と 分布（またはドメイン）シフト は正当）", () => {
    expect(
      findKatakanaDrift([
        row("distribution shift", "分布シフト(distribution shift)"),
        row("distribution (or domain) shift", "分布（またはドメイン）シフト(distribution shift)"),
      ]),
    ).toEqual([]);
  });

  it("原表記のまま残す語は比較しない", () => {
    expect(
      findKatakanaDrift([
        row("DSC", "ハウスドルフ", "keep-original"),
        row("HD95", "ハウスドッフ", "keep-original"),
      ]),
    ).toEqual([]);
  });

  it("短い片仮名は別語の衝突が起きるので比較しない（パスワード級の長さから見る）", () => {
    expect(findKatakanaDrift([row("path", "パス"), row("bus", "バス")])).toEqual([]);
  });

  it("揺れが無ければ何も返さない", () => {
    expect(
      findKatakanaDrift([
        row("segmentation", "セグメンテーション"),
        row("benchmark dataset", "ベンチマークデータセット"),
      ]),
    ).toEqual([]);
  });

  it("同じ揺れに関わる用語をすべて列挙する", () => {
    const drift = findKatakanaDrift([
      row("A", "ハウスドルフ距離"),
      row("B", "ハウスドッフ距離"),
      row("C", "ハウスドルフ空間"),
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.terms).toEqual(["A", "B", "C"]);
  });
});
