import { describe, it, expect } from "vitest";
import { applyVerification, usableForm, verifyTargets, MAX_USAGE_FORM_CHARS } from "./verify.js";
import { MAX_VERIFY_TERMS, type TermVerifyOut } from "../types/contract.js";
import type { ResolvedRow } from "./glossary-io.js";

const row = (src: string, form: string, cls = "established", rendering = "translate"): ResolvedRow => ({
  src,
  form,
  class: cls,
  rendering,
});

describe("verifyTargets（契約付録 §4・issue #309）", () => {
  it("承認済みの訳が無く、訳す established・paper-defined の語だけを選ぶ", () => {
    const resolved = [
      row("Widget set", "ウィジェット集合"),
      row("Gizmo ratio", "ギズモ比(Gizmo ratio)", "paper-defined", "bilingual"),
      row("BLEU", "BLEU", "established", "keep-original"),
      row("Tokyo", "東京", "proper-noun"),
      row("LaTeX", "LaTeX", "do-not-translate"),
      row("Known term", "既知の語"),
      row("the", "その"),
    ];
    const got = verifyTargets(resolved, "", (src) => src === "Known term");
    expect(got.map((t) => t.src)).toEqual(["Gizmo ratio", "Widget set"]);
    expect(got[1]).toEqual({ src: "Widget set", form: "ウィジェット集合" });
  });

  it("抜粋に多く出る語から、同数なら paper-defined、用語集の順で上限まで", () => {
    const resolved = Array.from({ length: MAX_VERIFY_TERMS + 3 }, (_, i) => row(`term number ${String(i)}`, `語${String(i)}`));
    resolved.push(row("central idea", "中心の考え", "paper-defined"));
    const excerpt = "Central idea and central idea. term number 12 once.";
    const got = verifyTargets(resolved, excerpt, () => false);
    expect(got).toHaveLength(MAX_VERIFY_TERMS);
    expect(got[0]!.src).toBe("central idea");
    expect(got[1]!.src).toBe("term number 12");
    expect(got[2]!.src).toBe("term number 0");
  });
});

const out = (terms: TermVerifyOut["terms"]): TermVerifyOut => ({ terms });

describe("applyVerification（採否は決定的）", () => {
  const resolved = [
    row("Widget set", "ウィジェット集合"),
    row("Gizmo ratio", "ギズモ比(Gizmo ratio)", "paper-defined", "bilingual"),
    row("Sprocket", "スプロケット"),
  ];
  const targets = resolved.map((r) => ({ src: r.src, form: r.form }));

  it("https の出典の引用に表記がそのまま含まれれば、用例の表記へ差し替える（併記形は組み直す）", () => {
    const r = applyVerification(
      resolved,
      targets,
      out([
        {
          src: "widget SET",
          status: "found",
          form: "部品集合",
          sources: [
            { url: "https://example.jp/a", quote: "部品集合とは何か" },
            { url: "http://example.jp/b", quote: "部品集合" },
            { url: "https://example.jp/c", quote: "引用に表記が無い" },
          ],
        },
        { src: "Gizmo ratio", status: "found", form: "機巧比", sources: [{ url: "https://ex.org/x", quote: "この機巧比は" }] },
        { src: "Sprocket", status: "found", form: "スプロケット", sources: [{ url: "https://ex.org/s", quote: "スプロケットの" }] },
      ]),
    );
    expect(r.resolved.map((x) => x.form)).toEqual(["部品集合", "機巧比(Gizmo ratio)", "スプロケット"]);
    expect(r.checks).toEqual([
      { src: "Widget set", status: "replaced", form: "部品集合", original: "ウィジェット集合", sources: ["https://example.jp/a"] },
      {
        src: "Gizmo ratio",
        status: "replaced",
        form: "機巧比(Gizmo ratio)",
        original: "ギズモ比(Gizmo ratio)",
        sources: ["https://ex.org/x"],
      },
      { src: "Sprocket", status: "confirmed", form: "スプロケット", sources: ["https://ex.org/s"] },
    ]);
    expect(resolved[0]!.form).toBe("ウィジェット集合");
  });

  it("not-found・conflicting・出典の条件を満たさない・応答に無い語は未確認のまま訳を変えない", () => {
    const r = applyVerification(
      resolved,
      targets,
      out([
        { src: "Widget set", status: "conflicting", form: "部品集合", sources: [{ url: "https://a.jp", quote: "部品集合" }] },
        { src: "Gizmo ratio", status: "found", form: "機巧比", sources: [{ url: "ftp://a.jp", quote: "機巧比" }] },
      ]),
    );
    expect(r.resolved.map((x) => x.form)).toEqual(resolved.map((x) => x.form));
    expect(r.checks.map((c) => c.status)).toEqual(["unverified", "unverified", "unverified"]);
    expect(r.checks.every((c) => c.sources.length === 0)).toBe(true);
  });

  it("同じ語の応答が重なれば先のものを使う", () => {
    const r = applyVerification(
      resolved,
      targets.slice(0, 1),
      out([
        { src: "Widget set", status: "not-found", sources: [] },
        { src: "Widget set", status: "found", form: "部品集合", sources: [{ url: "https://a.jp", quote: "部品集合" }] },
      ]),
    );
    expect(r.checks[0]!.status).toBe("unverified");
  });

  it("用例の表記は 1 行・長さ・日本語を含む・マークアップの文字を含まないものだけ", () => {
    expect(usableForm(" 羅生門集合 ")).toBe("羅生門集合");
    expect(usableForm("Rashomon set")).toBeUndefined();
    expect(usableForm("集合\\textbf{x}")).toBeUndefined();
    expect(usableForm("集合|表")).toBeUndefined();
    expect(usableForm("集合\n次の行")).toBeUndefined();
    expect(usableForm("あ".repeat(MAX_USAGE_FORM_CHARS + 1))).toBeUndefined();
    expect(usableForm(undefined)).toBeUndefined();
  });

  it("DIVERSE（2601.20627）の Rashomon set: 出典付きの「羅生門集合」に差し替える", () => {
    const rows = [row("Rashomon set", "ラショモン集合")];
    const r = applyVerification(
      rows,
      [{ src: "Rashomon set", form: "ラショモン集合" }],
      out([
        {
          src: "Rashomon set",
          status: "found",
          form: "羅生門集合",
          sources: [
            {
              url: "https://blog.fltech.dev/entry/2022/11/29/duke-neurips2022-paper-ja",
              quote: "次にこの決定木に対する羅生門集合を定義します．",
            },
          ],
        },
      ]),
    );
    expect(r.resolved[0]!.form).toBe("羅生門集合");
    expect(r.checks[0]!.status).toBe("replaced");
  });
});
