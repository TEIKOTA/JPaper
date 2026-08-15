import { describe, it, expect } from "vitest";
import { jaPartOf, canonicalBilingualForm, normalizeBilingualForms } from "./bilingual-form.js";
import type { ResolvedTerm } from "../types/contract.js";

describe("jaPartOf（併記形の日本語部分）", () => {
  it("末尾の括弧組だけを落とす", () => {
    expect(jaPartOf("分布シフト(distribution shift)")).toBe("分布シフト");
    expect(jaPartOf("値 (Value)")).toBe("値");
  });

  // 最初の括弧で切ると、日本語側に括弧を持つ語で日本語部分が欠ける。
  it("日本語側の括弧を残す", () => {
    expect(jaPartOf("分布外(OOD)データ(out-of-distribution (OOD) data)")).toBe("分布外(OOD)データ");
    expect(
      jaPartOf("修正ハウスドルフ距離(HD95)(modified (95th-percentile) Hausdorff distance (HD95))"),
    ).toBe("修正ハウスドルフ距離(HD95)");
  });

  it("全角括弧でも切れる", () => {
    expect(jaPartOf("分布外（OOD）データ（out-of-distribution data）")).toBe("分布外（OOD）データ");
  });

  it("括弧が無ければそのまま", () => {
    expect(jaPartOf("アテンション")).toBe("アテンション");
  });

  it("閉じない括弧は切らない（壊れた入力で日本語を失わない）", () => {
    expect(jaPartOf("分布シフト(distribution shift")).toBe("分布シフト(distribution shift");
  });
});

describe("canonicalBilingualForm（原語部分は src で固定）", () => {
  // 検査は完全一致なので、モデルが大文字化するとその節は永久に通らない（実測 seg-0018）。
  it("モデルの綴りを採らず原文の綴りを入れる", () => {
    expect(canonicalBilingualForm("ガンマ圧縮(Gamma compression)", "gamma compression")).toBe(
      "ガンマ圧縮(gamma compression)",
    );
  });

  it("全角括弧で書かれても半角の併記形に揃える", () => {
    expect(canonicalBilingualForm("異方性（Anisotropic）", "anisotropic")).toBe(
      "異方性(anisotropic)",
    );
  });

  it("併記になっていない form にも原語を補う", () => {
    expect(canonicalBilingualForm("分布シフト", "distribution shift")).toBe(
      "分布シフト(distribution shift)",
    );
  });

  it("日本語側の括弧を保ったまま原語を差し替える", () => {
    expect(
      canonicalBilingualForm(
        "分布外(OOD)データ(Out-of-distribution (OOD) data)",
        "out-of-distribution (OOD) data",
      ),
    ).toBe("分布外(OOD)データ(out-of-distribution (OOD) data)");
  });

  it("日本語部分が空なら src だけにする（空の併記形を作らない）", () => {
    expect(canonicalBilingualForm("(Foo)", "foo")).toBe("foo");
  });
});

describe("normalizeBilingualForms", () => {
  const base = { class: "paper-defined", firstOccurrence: true } as const;
  const terms: ResolvedTerm[] = [
    { ...base, src: "gamma compression", form: "ガンマ圧縮(Gamma compression)", rendering: "bilingual" },
    { ...base, src: "attention", form: "アテンション", rendering: "translate" },
    { ...base, src: "BLEU", form: "BLEU", rendering: "keep-original" },
  ];

  it("bilingual は原語を src で固定する", () => {
    const out = normalizeBilingualForms(terms);
    expect(out[0]!.form).toBe("ガンマ圧縮(gamma compression)");
  });

  // translate なのに併記が入ると、本文の全出現に英語が撒かれる（実測: run5 の
  // 「等方性 (isotropic) downsampling」を evaluator が「英語が混じりすぎている」と指摘）。
  it("translate は末尾の原語併記を落とす", () => {
    const out = normalizeBilingualForms([
      { ...base, src: "isotropic", form: "等方性 (isotropic)", rendering: "translate" },
      { ...base, src: "Vision Transformers", form: "Vision Transformer (ViT)", rendering: "translate" },
      { ...base, src: "attention", form: "アテンション", rendering: "translate" },
    ]);
    expect(out[0]!.form).toBe("等方性");
    expect(out[1]!.form).toBe("Vision Transformer");
    expect(out[2]!.form).toBe("アテンション");
  });

  it("translate でも日本語側の括弧は壊さない", () => {
    const out = normalizeBilingualForms([
      { ...base, src: "OOD data", form: "分布外 (OOD) データ", rendering: "translate" },
    ]);
    expect(out[0]!.form).toBe("分布外 (OOD) データ");
  });

  it("keep-original は触らない", () => {
    const out = normalizeBilingualForms(terms);
    expect(out[2]!.form).toBe("BLEU");
    expect(out[1]!.form).toBe("アテンション");
  });

  it("入力を書き換えない", () => {
    normalizeBilingualForms(terms);
    expect(terms[0]!.form).toBe("ガンマ圧縮(Gamma compression)");
  });
});
