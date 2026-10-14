import { describe, it, expect } from "vitest";
import { trimTermPunctuation, normalizeTermSrcs } from "./term-src.js";

describe("trimTermPunctuation（issue #376）", () => {
  it.each([
    ["Rashomon Ratio.", "Rashomon Ratio"],
    ["Baselines.", "Baselines"],
    ["Training with Data Subsets.", "Training with Data Subsets"],
    ["Effective approach:", "Effective approach"],
    ["Total:", "Total"],
    ["Sharpness metric;", "Sharpness metric"],
    ["Rashomon set,", "Rashomon set"],
    ["Rashomon Ratio. ", "Rashomon Ratio"],
    ["Rashomon Ratio.:", "Rashomon Ratio"],
    ["Step 1.", "Step 1"],
    ["CIFAR10/CIFAR10.1.", "CIFAR10/CIFAR10.1"],
    ["合計：", "合計"],
    ["ベースライン。", "ベースライン"],
  ])("%s → %s", (src, want) => {
    expect(trimTermPunctuation(src)).toBe(want);
  });

  it.each([
    "et al.",
    "e.g.",
    "i.e.",
    "w.r.t.",
    "Ph.D.",
    "J.T.S.",
    "S. U.",
    "Sandra E.",
    "ID Acc.",
    "OOD Acc.",
    "Epistemic vs.",
    "Fig.",
    "etc.",
    "Rashomon Ratio",
    "Pre- vs.\\ post-normalization",
  ])("略語の末尾のピリオドは残す: %s", (src) => {
    expect(trimTermPunctuation(src)).toBe(src);
  });

  it("略語の後ろのコロンだけを落とす", () => {
    expect(trimTermPunctuation("ID Acc.:")).toBe("ID Acc.");
  });

  it("句読点だけの語は空になる", () => {
    expect(trimTermPunctuation(".:")).toBe("");
  });
});

describe("normalizeTermSrcs（issue #376）", () => {
  it("src の末尾の句読点を落とし、その語の form の句読点も落とす", () => {
    const got = normalizeTermSrcs([
      { src: "Baselines.", form: "ベースライン。" },
      { src: "Total:", form: "合計:" },
      { src: "e.g.", form: "e.g." },
      { src: "ID Acc.", form: "ID精度" },
    ]);
    expect(got).toEqual([
      { src: "Baselines", form: "ベースライン" },
      { src: "Total", form: "合計" },
      { src: "e.g.", form: "e.g." },
      { src: "ID Acc.", form: "ID精度" },
    ]);
  });

  it("src を変えない語は form も触らない", () => {
    expect(normalizeTermSrcs([{ src: "attention", form: "注意。" }])).toEqual([
      { src: "attention", form: "注意。" },
    ]);
  });

  it("正規化で同じ src になった語は先の 1 つを残し、空の src は落とす", () => {
    const got = normalizeTermSrcs([
      { src: "Rashomon Ratio", form: "ラショモン比" },
      { src: "Rashomon Ratio.", form: "ラショモン比率。" },
      { src: ".", form: "。" },
    ]);
    expect(got).toEqual([{ src: "Rashomon Ratio", form: "ラショモン比" }]);
  });
});
