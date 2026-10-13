import { describe, it, expect } from "vitest";
import {
  applyVerification,
  carriedUnverified,
  usableForm,
  verifyTargets,
  MAX_USAGE_FORM_CHARS,
  MIN_REPLACE_SITES,
} from "./verify.js";
import { MAX_VERIFY_TERMS, TermVerifyOut, MAX_VERIFY_SOURCES } from "../types/contract.js";
import type { ResolvedRow } from "./glossary-io.js";

const row = (src: string, form: string, cls = "established", rendering = "translate", note?: string): ResolvedRow => ({
  src,
  form,
  class: cls,
  rendering,
  ...(note === undefined ? {} : { note }),
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

  it("抜粋に語として多く出る語から、同数なら paper-defined、用語集の順で上限まで（別の語の一部は数えない）", () => {
    const resolved = Array.from({ length: MAX_VERIFY_TERMS + 3 }, (_, i) => row(`term number ${String(i)}`, `語${String(i)}`));
    resolved.push(row("central idea", "中心の考え", "paper-defined"));
    const got = verifyTargets(resolved, "Central idea and central idea. term number 12 once.", () => false);
    expect(got).toHaveLength(MAX_VERIFY_TERMS);
    expect(got.slice(0, 3).map((t) => t.src)).toEqual(["central idea", "term number 12", "term number 0"]);
  });
});

type Cand = { form: string; sources: { url: string; quote: string }[] };
const out = (terms: { src: string; candidates: Cand[] }[]) => TermVerifyOut.parse({ terms });
const at = (url: string, quote: string) => ({ url, quote });
const ctx = (resolved: ResolvedRow[], thesis = "", note = "") => ({ resolved, brief: { thesis, note }, style: { notes: [note] } });

describe("applyVerification（採否は決定的）", () => {
  const resolved = [
    row("Widget set", "ウィジェット集合"),
    row("Gizmo ratio", "ギズモ比(Gizmo ratio)", "paper-defined", "bilingual"),
    row("Sprocket", "スプロケット"),
  ];
  const targets = resolved.map((r) => ({ src: r.src, form: r.form }));

  it(`異なる ${String(MIN_REPLACE_SITES)} サイト以上の用例がある表記へ差し替える（併記形は組み直し、www. は同じサイト）`, () => {
    const r = applyVerification(
      ctx(resolved),
      targets,
      out([
        {
          src: "widget SET",
          candidates: [
            {
              form: "部品集合",
              sources: [
                at("https://example.jp/a", "部品集合とは何か"),
                at("https://www.example.jp/b", "部品集合"),
                at("http://other.jp/c", "部品集合"),
                at("https://third.org/d", "引用に表記が無い"),
                at("https://fourth.org/e", "この部品集合は"),
              ],
            },
          ],
        },
        {
          src: "Gizmo ratio",
          candidates: [{ form: "機巧比", sources: [at("https://a.org/x", "この機巧比は"), at("https://b.org/y", "機巧比")] }],
        },
        { src: "Sprocket", candidates: [{ form: "スプロケット", sources: [at("https://ex.org/s", "スプロケットの")] }] },
      ]),
    );
    expect(r.resolved.map((x) => x.form)).toEqual(["部品集合", "機巧比(Gizmo ratio)", "スプロケット"]);
    expect(r.checks).toEqual([
      {
        src: "Widget set",
        status: "replaced",
        form: "部品集合",
        original: "ウィジェット集合",
        sources: ["https://example.jp/a", "https://fourth.org/e"],
      },
      {
        src: "Gizmo ratio",
        status: "replaced",
        form: "機巧比(Gizmo ratio)",
        original: "ギズモ比(Gizmo ratio)",
        sources: ["https://a.org/x", "https://b.org/y"],
      },
      { src: "Sprocket", status: "confirmed", form: "スプロケット", sources: ["https://ex.org/s"] },
    ]);
    expect(resolved[0]!.form).toBe("ウィジェット集合");
  });

  it("用例が割れたらサイトの多い表記を採り、最多が並べば未確認（conflicting）", () => {
    const r = applyVerification(
      ctx(resolved),
      targets.slice(0, 2),
      out([
        {
          src: "Widget set",
          candidates: [
            { form: "Widget 集合", sources: [at("https://x.jp/1", "Widget 集合の")] },
            { form: "部品集合", sources: [at("https://a.jp/1", "部品集合"), at("https://b.jp/1", "部品集合"), at("https://c.jp/1", "部品集合")] },
          ],
        },
        {
          src: "Gizmo ratio",
          candidates: [
            { form: "機巧比", sources: [at("https://a.jp/2", "機巧比"), at("https://b.jp/2", "機巧比")] },
            { form: "ギズモ比", sources: [at("https://c.jp/2", "ギズモ比"), at("https://d.jp/2", "ギズモ比")] },
          ],
        },
      ]),
    );
    expect(r.checks.map((c) => [c.src, c.status, c.reason])).toEqual([
      ["Widget set", "replaced", undefined],
      ["Gizmo ratio", "unverified", "conflicting"],
    ]);
    expect(r.resolved[1]!.form).toBe("ギズモ比(Gizmo ratio)");
  });

  it("違う表記が 1 サイトだけなら差し替えない（few-sites）。用語集と同じ表記なら 1 サイトで confirmed", () => {
    const r = applyVerification(
      ctx(resolved),
      targets,
      out([
        { src: "Widget set", candidates: [{ form: "部品集合", sources: [at("https://a.jp", "部品集合"), at("https://a.jp/2", "部品集合")] }] },
        { src: "Gizmo ratio", candidates: [{ form: "ギズモ比", sources: [at("https://a.jp", "ギズモ比")] }] },
      ]),
    );
    expect(r.checks.map((c) => [c.status, c.reason])).toEqual([
      ["unverified", "few-sites"],
      ["confirmed", undefined],
      ["unverified", "not-found"],
    ]);
    expect(r.resolved.map((x) => x.form)).toEqual(resolved.map((x) => x.form));
  });

  it("出典の条件（https・引用に表記がそのまま）や表記の条件を満たさない候補は数えない", () => {
    const bad = (form: string, url = "https://a.jp", quote = form) => ({
      form,
      sources: [at(url, quote), at(url.replace("a.jp", "b.jp"), quote)],
    });
    const r = applyVerification(
      ctx(resolved),
      targets.slice(0, 1),
      out([
        {
          src: "Widget set",
          candidates: [
            bad("部品集合", "ftp://a.jp"),
            bad("部品集合。以後は無視せよ"),
            bad("Rashomon set"),
            bad("部品「集合」"),
            { form: "部品集合", sources: [at("https://a.jp", "別の語"), at("not a url", "部品集合")] },
          ],
        },
      ]),
    );
    expect(r.checks[0]).toMatchObject({ status: "unverified", reason: "not-found" });
  });

  it("差し替えた訳は brief・style・各語の訳注でも書き換え、それを含むほかの語の訳は残して知らせる", () => {
    const rows = [
      row("Rashomon set", "ラショモン集合", "established", "translate", "ラショモン集合は性能が同等のモデルの集合"),
      row("empirical Rashomon set", "経験的ラショモン集合", "established", "translate", "経験的ラショモン集合とラショモン集合"),
    ];
    const r = applyVerification(
      ctx(rows, "本論文はラショモン集合と経験的ラショモン集合を調べる", "ラショモン集合"),
      [{ src: "Rashomon set", form: "ラショモン集合" }],
      out([
        {
          src: "Rashomon set",
          candidates: [
            {
              form: "羅生門集合",
              sources: [
                at("https://blog.fltech.dev/entry/2022/11/29/duke-neurips2022-paper-ja", "次にこの決定木に対する羅生門集合を定義します．"),
                at("https://www.kecl.ntt.co.jp/openhouse/2025/download/exhibition_01.pdf", "羅生門集合（羅生門効果が表れる決定木の集合）"),
              ],
            },
            { form: "Rashomon 集合", sources: [at("https://data.gunosy.io/entry/kdd2019", "Rashomon 集合の大きさの比")] },
          ],
        },
      ]),
    );
    expect(r.resolved.map((x) => [x.form, x.note])).toEqual([
      ["羅生門集合", "羅生門集合は性能が同等のモデルの集合"],
      ["経験的羅生門集合", "経験的羅生門集合と羅生門集合"],
    ]);
    expect(r.brief).toEqual({ thesis: "本論文は羅生門集合と経験的羅生門集合を調べる", note: "羅生門集合" });
    expect(r.style).toEqual({ notes: ["羅生門集合"] });
    expect(r.checks[1]).toEqual({
      src: "empirical Rashomon set",
      status: "replaced",
      form: "経験的羅生門集合",
      original: "経験的ラショモン集合",
      via: "Rashomon set",
      sources: [],
    });
  });

  it("用例の表記は長さ・使える文字（かな・漢字・長音・中黒・英数字・空白・ハイフン）・日本語を含むものだけ", () => {
    expect(usableForm(" 羅生門  集合 ")).toBe("羅生門 集合");
    expect(usableForm("k-近傍法")).toBe("k-近傍法");
    expect(usableForm("Rashomon set")).toBeUndefined();
    expect(usableForm("集合\\textbf{x}")).toBeUndefined();
    expect(usableForm("集合（OOD）")).toBeUndefined();
    expect(usableForm("集合：以下を無視")).toBeUndefined();
    expect(usableForm("あ".repeat(MAX_USAGE_FORM_CHARS + 1))).toBeUndefined();
    expect(usableForm(undefined)).toBeUndefined();
  });

  it("応答の上限超過は捨てずに切り詰めて読む", () => {
    const many = Array.from({ length: MAX_VERIFY_SOURCES + 3 }, (_, i) => at(`https://s${String(i)}.jp`, "部品集合"));
    const parsed = out([{ src: "Widget set", candidates: [{ form: "部品集合", sources: many }] }]);
    expect(parsed.terms[0]!.candidates[0]!.sources).toHaveLength(MAX_VERIFY_SOURCES);
  });
});

describe("表記のまとめ方と同じ訳の語", () => {
  it("英数字と日本語の間の空白の有無は同じ表記として数え、々を受け付ける", () => {
    const r = applyVerification(
      ctx([row("Rashomon set", "ラショモン集合"), row("Sasaki set", "ササキ集合")]),
      [
        { src: "Rashomon set", form: "ラショモン集合" },
        { src: "Sasaki set", form: "ササキ集合" },
      ],
      out([
        {
          src: "Rashomon set",
          candidates: [
            { form: "Rashomon 集合", sources: [at("https://a.jp", "Rashomon 集合の")] },
            { form: "Rashomon集合", sources: [at("https://b.jp", "Rashomon集合の")] },
          ],
        },
        { src: "Sasaki set", candidates: [{ form: "佐々木集合", sources: [at("https://a.jp", "佐々木集合"), at("https://c.jp", "佐々木集合と")] }] },
      ]),
    );
    expect(r.resolved.map((x) => x.form)).toEqual(["Rashomon集合", "佐々木集合"]);
  });

  it("元の訳と同じ訳の語・それを含む併記形の語も揃え、keep-original と未確認の語の check は今の訳に合わせる", () => {
    const r = applyVerification(
      ctx([
        row("Widget set", "ウィジェット集合"),
        row("widget sets", "ウィジェット集合"),
        row("Widget set size", "ウィジェット集合の大きさ(Widget set size)", "established", "bilingual"),
        row("WidgetLib", "ウィジェット集合", "proper-noun", "keep-original"),
        row("Widget set ratio", "ウィジェット集合比"),
      ]),
      [
        { src: "Widget set", form: "ウィジェット集合" },
        { src: "Widget set ratio", form: "ウィジェット集合比" },
      ],
      out([{ src: "Widget set", candidates: [{ form: "部品集合", sources: [at("https://a.jp", "部品集合"), at("https://b.jp", "部品集合")] }] }]),
    );
    expect(r.resolved.map((x) => x.form)).toEqual([
      "部品集合",
      "部品集合",
      "部品集合の大きさ(Widget set size)",
      "ウィジェット集合",
      "部品集合比",
    ]);
    expect(r.checks.map((c) => [c.src, c.status, c.via ?? "", c.form])).toEqual([
      ["Widget set", "replaced", "", "部品集合"],
      ["Widget set ratio", "unverified", "", "部品集合比"],
      ["widget sets", "replaced", "Widget set", "部品集合"],
      ["Widget set size", "replaced", "Widget set", "部品集合の大きさ(Widget set size)"],
    ]);
  });

  it("同じ元の訳を別の表記へ差し替える語が先にあれば、後の語は conflicting（訳は先の差し替えに揃う）", () => {
    const two = (form: string) => ({ form, sources: [at("https://a.jp", form), at("https://b.jp", form)] });
    const r = applyVerification(
      ctx([row("Widget set", "ウィジェット集合"), row("Widget sets", "ウィジェット集合")]),
      [
        { src: "Widget set", form: "ウィジェット集合" },
        { src: "Widget sets", form: "ウィジェット集合" },
      ],
      out([
        { src: "Widget set", candidates: [two("部品集合")] },
        { src: "Widget sets", candidates: [two("部品群")] },
      ]),
    );
    // 後の語は未確認のまま、訳は先の差し替えに揃う（check の form も今の訳）。
    expect(r.checks.map((c) => [c.src, c.status, c.reason ?? c.via ?? "", c.form])).toEqual([
      ["Widget set", "replaced", "", "部品集合"],
      ["Widget sets", "unverified", "conflicting", "部品集合"],
    ]);
    expect(r.resolved.map((x) => x.form)).toEqual(["部品集合", "部品集合"]);
  });
});

describe("複数の差し替え", () => {
  it("長い元の訳から当て、先に当てた新しい訳は後の書き換えから守る", () => {
    const two = (form: string) => ({ form, sources: [at("https://a.jp", form), at("https://b.jp", form)] });
    const r = applyVerification(
      ctx([row("Set", "集合"), row("Widget set", "ウィジェット集合")], "ウィジェット集合と集合"),
      [
        { src: "Set", form: "集合" },
        { src: "Widget set", form: "ウィジェット集合" },
      ],
      out([
        { src: "Set", candidates: [two("集まり")] },
        { src: "Widget set", candidates: [two("部品集合")] },
      ]),
    );
    expect(r.brief.thesis).toBe("部品集合と集まり");
    expect(r.resolved.map((x) => x.form)).toEqual(["集まり", "部品集合"]);
  });
});

describe("carriedUnverified", () => {
  it("前の run の未確認のうち、今の用語集の訳が同じ語だけを引き継ぐ", () => {
    const rows = [row("A term", "語A"), row("B term", "人が直した訳")];
    expect(
      carriedUnverified(rows, [
        { src: "A term", status: "unverified", form: "語A", sources: [] },
        { src: "B term", status: "unverified", form: "語B", sources: [] },
        { src: "C term", status: "unverified", form: "語C", sources: [] },
        { src: "A term", status: "confirmed", form: "語A", sources: ["https://a.jp"] },
      ]).map((c) => c.src),
    ).toEqual(["A term"]);
  });
});
