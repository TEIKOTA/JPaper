import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, repairJsonEscapes, runAgent, MAX_RESPONSE_CHARS } from "./llm-client.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

describe("extractJson", () => {
  it("素の JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("```json フェンス", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("前後に散文がある場合も取り出す", () => {
    expect(extractJson("結果:\n{\"a\":1}\nおわり")).toEqual({ a: 1 });
    expect(extractJson("prefix [1,2,3]")).toEqual([1, 2, 3]);
  });
  it("無効なブラケットの後にある JSON を見つける", () => {
    expect(extractJson('Note [draft]\n{"a":1}')).toEqual({ a: 1 });
  });
  it("文字列内の閉じ括弧を無視する", () => {
    expect(extractJson('x {"s":"a}b"} y')).toEqual({ s: "a}b" });
  });
  it("JSON が無ければ例外", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("runAgent", () => {
  it("complete→extractJson→zod.parse", async () => {
    const c = new FakeLlmClient('```json\n{"x":5}\n```');
    expect(await runAgent(c, { system: "s", user: "u" }, z.object({ x: z.number() }))).toEqual({
      x: 5,
    });
  });
  it("スキーマ不一致は retry 上限まで試して throw", async () => {
    let n = 0;
    const client = {
      async complete() {
        n++;
        return '{"x":"no"}';
      },
    };
    await expect(
      runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
        retries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
    expect(n).toBe(3); // 初回＋2 retry（不正応答も transient 扱いで再試行）
  });

  it("応答の parse/検証失敗も retry する（不正JSON→次で正常なら成功）", async () => {
    let n = 0;
    const client = {
      async complete() {
        return n++ < 1 ? "json ではない散文応答" : '{"x":1}';
      },
    };
    const out = await runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
      sleep: async () => {},
    });
    expect(out).toEqual({ x: 1 });
    expect(n).toBe(2); // 1 回目の parse 失敗を retry して 2 回目で成功
  });

  it("一時エラーは client 境界でリトライする", async () => {
    let n = 0;
    const client = {
      async complete() {
        if (n++ < 1) throw { code: "ETIMEDOUT" };
        return '{"x":1}';
      },
    };
    const out = await runAgent(client, { system: "s", user: "u" }, z.object({ x: z.number() }), {
      sleep: async () => {},
    });
    expect(out).toEqual({ x: 1 });
    expect(n).toBe(2);
  });
});

describe("契約に合わない応答の分類", () => {
  it("リトライしても zod を通らない応答は provider 起因として返す", async () => {
    const { JpaperError } = await import("../types/errors.js");
    const schema = z.object({ ja: z.string() });
    const client = { complete: async () => '{"ja": 42}' };
    let err: unknown;
    try {
      await runAgent(client, { system: "s", user: "u" }, schema, {
        retries: 1,
        sleep: async () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JpaperError);
    expect((err as InstanceType<typeof JpaperError>).kind).toBe("provider");
    // 生の zod エラーをそのまま外へ出さない（長さも抑える）。
    expect((err as Error).message).toContain("契約に合いません");
    expect((err as Error).message.length).toBeLessThan(300);
  });

  it("プロバイダ自身のエラーは分類を変えない", async () => {
    const { JpaperError } = await import("../types/errors.js");
    const boom = new JpaperError(2, "provider", "ollama HTTP 404");
    const client = {
      complete: async () => {
        throw boom;
      },
    };
    await expect(
      runAgent(client, { system: "s", user: "u" }, z.object({}), { retries: 0 }),
    ).rejects.toBe(boom);
  });
});

describe("応答の仕事量の上限", () => {
  it("閉じない括弧が並ぶ応答でも二次にならない", () => {
    // 候補ごとに末尾まで再走査していた頃は 50 万文字で 25,629ms かかり、
    // withRetry の 4 試行で 4 倍になった（timeoutMs も割り込めない同期処理）。
    const text = "\\textbf{x ".repeat(50_000);
    const started = Date.now();
    expect(() => extractJson(text)).toThrowError(/JSON が見つかりません/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("上限を超える長さの応答は読まずに落とす", () => {
    const text = "{".repeat(MAX_RESPONSE_CHARS + 1);
    expect(() => extractJson(text)).toThrowError(/上限/);
  });
});


// #264: LaTeX を JSON 文字列で運ぶと、モデルは backslash の二重化にしばしば失敗する。
describe("repairJsonEscapes", () => {
  it("不正なエスケープを literal な backslash へ直す（\\citep が JSON を壊す）", () => {
    const raw = '{"ja":"\\\\subsubsection{見出し} と \\citep{smith2020} と \\%"}';
    const v = extractJson(raw) as { ja: string };
    expect(v.ja).toBe("\\subsubsection{見出し} と \\citep{smith2020} と \\%");
  });

  it("正しいエスケープは触らない", () => {
    expect(repairJsonEscapes('"a\\nb\\tc\\"d\\\\e\\/f\\u3042g"')).toBe(
      '"a\\nb\\tc\\"d\\\\e\\/f\\u3042g"',
    );
  });

  it("\\u の後ろが 16 進 4 桁でなければ literal 扱いにする", () => {
    const v = extractJson('{"ja":"\\unit テスト"}') as { ja: string };
    expect(v.ja).toBe("\\unit テスト");
  });

  it("文字列の外の文字には触らない", () => {
    expect(repairJsonEscapes('{ "a": 1, "b": [2, 3] }')).toBe('{ "a": 1, "b": [2, 3] }');
  });

  it("文字列中の生の改行・タブを綴りへ直す", () => {
    const v = extractJson('{"ja":"1 行目\n2 行目\tタブ"}') as { ja: string };
    expect(v.ja).toBe("1 行目\n2 行目\tタブ");
  });

  it("コードフェンス付きでも直す", () => {
    const v = extractJson('```json\n{"ja":"\\citep{a}"}\n```') as { ja: string };
    expect(v.ja).toBe("\\citep{a}");
  });

  it("すでに妥当な JSON は修復を通さない（既存の挙動を変えない）", () => {
    // 修復が走ると \\\\ が \\\\\\\\ になりかねない。直接 parse できたら触らないことを固定する。
    const v = extractJson('{"ja":"\\\\citep{a}"}') as { ja: string };
    expect(v.ja).toBe("\\citep{a}");
  });

  it("修復しても JSON にならなければ従来どおり失敗させる", () => {
    expect(() => extractJson("これは散文です")).toThrow(/JSON が見つかりません/);
  });

  it("backslash の直後の生の改行も綴りへ直す（実測 seg-0018 が落ちた形）", () => {
    // モデルが `}\<生の改行>\\label{...}` を吐いた。backslash を二重化するだけでは
    // 生の改行が残り、JSON としてまだ不正なまま。
    const raw = '{"ja":"図の終わり}' + "\\\n" + '\\\\label{fig:a}"}';
    const v = extractJson(raw) as { ja: string };
    expect(v.ja).toBe("図の終わり}" + "\\\n" + "\\label{fig:a}");
  });

  it("末尾が backslash で切れていても例外にしない", () => {
    expect(() => repairJsonEscapes('{"ja":"末尾 \\')).not.toThrow();
  });
});
