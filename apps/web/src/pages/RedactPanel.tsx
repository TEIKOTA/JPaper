// 契約付録 §9（伏せ字の範囲選択）。アップロードした PDF のページの上で語を選び、伏せ字の語の一覧を作る。
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api, type Matches, type PageWords, type Upload, type WordBox } from "../api.js";
import { errorText } from "../load.js";

export interface RedactTerm {
  term: string;
  on: boolean;
}

// 語の長さの範囲（CLI の --redact-file と同じ）。
const MIN_CHARS = 2;
const MAX_CHARS = 200;
const DEBOUNCE_MS = 250;
// 空白の入り方だけ違う形を並べる数。
const MAX_VARIANTS = 20;

// この幅（pt）未満の隙間で縦に重なる隣の語は空白なしで、行末（段の最後の行を除く。eol）が - の語は次の語へ空白なしでつなぐ。
// ⚠ CLI の src/ingest/pdf/redact-pdf.ts の JOIN_GAP・spaceBetween・hyphenated と同じ規則（RedactPanel.test.ts で突き合わせる）。
export const JOIN_GAP = 0.25;

export function spaceBetween(a: WordBox, b: WordBox): boolean {
  return !(b.x0 - a.x1 < JOIN_GAP && b.x0 >= a.x0 && b.y1 > a.y0 && b.y0 < a.y1);
}

export function hyphenated(w: { text: string; eol?: boolean }): boolean {
  return w.eol === true && w.text.endsWith("-");
}

// 選んだ語をテキスト層と同じようにつないだ文字列（行末の分綴の - は残す）から、前後の句読点・括弧を落とす。
export function termFromWords(words: readonly (WordBox & { text: string; eol?: boolean })[]): string {
  return words
    .map((w, i) => {
      const prev = words[i - 1];
      const sep = prev !== undefined && !hyphenated(prev) && spaceBetween(prev, w) ? " " : "";
      // 行末で分綴した語は - を残す（語の中の - は無くても当たるので、分綴で落ちた形にもハイフン入りの語の形にも当たる）。
      return sep + w.text;
    })
    .join("")
    .replace(/^[\s,.;:!?()[\]{}"'“”‘’]+|[\s,.;:!?()[\]{}"'“”‘’]+$/g, "");
}

export function validTerm(term: string): boolean {
  const n = [...term].length;
  // # で始まる語は --redact-file でコメントの行になるので受けない。- と空白を除いても MIN_CHARS 以上（CLI と同じ）。
  const core = [...term.replace(/[-\s]/g, "")].length;
  return n >= MIN_CHARS && n <= MAX_CHARS && core >= MIN_CHARS && !/[\x00-\x1f\x7f]/.test(term) && !term.startsWith("#");
}

// 空白の入り方だけ違う形を語に足せるか。既にある語と同じ形は足しても当たらない（文字の間の見えない制御文字・語の並び順）。
export function variantAction(text: string, terms: readonly RedactTerm[]): "add" | "same" | "invalid" {
  if (terms.some((t) => t.term === text)) return "same";
  return validTerm(text) ? "add" : "invalid";
}

// 空白・- を除いて SHORT_VARIANT 文字以下で、空白をまたぐ形（"a new" の中の "a n" など）。語の境目をまたいだ偶然の並びのことが多い。
const SHORT_VARIANT = 3;
export function crossesWords(text: string): boolean {
  return /\s/.test(text) && [...text.replace(/[-\s]/g, "")].length <= SHORT_VARIANT;
}

// pages の中で今のページの次（dir=1）・前（dir=-1）のページ。端では反対の端へ回る。
export function stepPage(pages: readonly number[], page: number, dir: 1 | -1): number | undefined {
  if (pages.length === 0) return undefined;
  return dir === 1 ? (pages.find((p) => p > page) ?? pages[0]!) : ([...pages].reverse().find((p) => p < page) ?? pages[pages.length - 1]!);
}

// 範囲（pt）に重なる語を、上から・左から順に返す。
export function wordsInRect<T extends WordBox>(words: readonly T[], r: WordBox): T[] {
  return words
    .filter((w) => w.x1 > r.x0 && w.x0 < r.x1 && w.y1 > r.y0 && w.y0 < r.y1)
    .sort((a, b) => (Math.abs(a.y0 - b.y0) > 2 ? a.y0 - b.y0 : a.x0 - b.x0));
}

export function RedactPanel(props: {
  upload: Upload;
  terms: RedactTerm[];
  onChange: (terms: RedactTerm[]) => void;
  // 語の当たりを数え終え、テキスト層と合わないページが無いか（false の間は翻訳を始めない）。
  onReady: (ready: boolean) => void;
}) {
  const { upload, terms, onChange, onReady } = props;
  const [page, setPage] = useState(1);
  const [words, setWords] = useState<PageWords>();
  const [matches, setMatches] = useState<Matches>();
  const [counting, setCounting] = useState(false);
  const [white, setWhite] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number }>();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const svg = useRef<SVGSVGElement>(null);
  const enabled = terms.filter((t) => t.on).map((t) => t.term);
  const key = enabled.join("\n");

  useEffect(() => {
    const ac = new AbortController();
    setWords(undefined);
    api.pageWords(upload.id, page, ac.signal).then(setWords, (e: unknown) => {
      if (!ac.signal.aborted) setError(errorText(e));
    });
    return () => ac.abort();
  }, [upload.id, page]);

  const mismatch = matches?.mismatchPages ?? [];
  const ready = !counting && matches !== undefined && mismatch.length === 0;
  useEffect(() => onReady(ready), [ready]);

  useEffect(() => {
    const ac = new AbortController();
    setCounting(true);
    const timer = setTimeout(() => {
      api.matches(upload.id, enabled, page, ac.signal).then(
        (m) => {
          setMatches(m);
          setCounting(false);
        },
        (e: unknown) => {
          if (ac.signal.aborted) return;
          setMatches(undefined);
          setCounting(false);
          setError(errorText(e));
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // 語の一覧は key（有効な語を改行でつないだもの）で代表する。
  }, [upload.id, page, key]);

  const add = (term: string): void => {
    const t = term.trim();
    if (!validTerm(t)) {
      setError(`語は ${String(MIN_CHARS)}〜${String(MAX_CHARS)} 文字で、# で始まらないものにしてください`);
      return;
    }
    setError(undefined);
    if (terms.some((x) => x.term === t)) {
      onChange(terms.map((x) => (x.term === t ? { ...x, on: true } : x)));
      return;
    }
    onChange([...terms, { term: t, on: true }]);
  };

  const toPt = (e: PointerEvent<SVGSVGElement>): { x: number; y: number } | undefined => {
    const el = svg.current;
    if (el === null || words === undefined) return undefined;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * words.width, y: ((e.clientY - r.top) / r.height) * words.height };
  };

  const rect = drag === undefined ? undefined : {
    x0: Math.min(drag.x0, drag.x1),
    y0: Math.min(drag.y0, drag.y1),
    x1: Math.max(drag.x0, drag.x1),
    y1: Math.max(drag.y0, drag.y1),
  };
  const picked = rect === undefined || words === undefined ? [] : wordsInRect(words.words, rect);
  const countOf = (term: string) => matches?.terms.find((m) => m.term === term);
  const totalHits = matches?.totalHits ?? 0;

  const jump = (pages: readonly number[], dir: 1 | -1): void => {
    const next = stepPage(pages, page, dir);
    if (next !== undefined) setPage(next);
  };

  return (
    <section className="redact" aria-label="伏せ字">
      <div className="redact-viewer">
        <div className="redact-toolbar">
          <button type="button" className="text-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            前のページ
          </button>
          <span>
            {page} / {upload.pages} ページ
          </span>
          <button type="button" className="text-button" disabled={page >= upload.pages} onClick={() => setPage(page + 1)}>
            次のページ
          </button>
          <label className="redact-white">
            <input type="checkbox" checked={white} onChange={(e) => setWhite(e.target.checked)} />
            白塗りで見る
          </label>
        </div>
        <div className="redact-page" style={words === undefined ? undefined : { aspectRatio: `${String(words.width)} / ${String(words.height)}` }}>
          <img src={api.pageImageUrl(upload.id, page)} alt={`${String(page)} ページ目`} draggable={false} />
          {words !== undefined && (
            <svg
              ref={svg}
              viewBox={`0 0 ${String(words.width)} ${String(words.height)}`}
              onPointerDown={(e) => {
                const p = toPt(e);
                if (p === undefined) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
              }}
              onPointerMove={(e) => {
                const p = toPt(e);
                if (drag !== undefined && p !== undefined) setDrag({ ...drag, x1: p.x, y1: p.y });
              }}
              onPointerUp={() => {
                if (rect !== undefined && picked.length > 0) add(termFromWords(picked));
                setDrag(undefined);
              }}
              onPointerCancel={() => setDrag(undefined)}
              onLostPointerCapture={() => setDrag(undefined)}
            >
              {(matches?.page === page ? (matches.boxes ?? []) : []).map((b, i) => (
                <rect
                  key={i}
                  className={white ? "redact-box-white" : "redact-box"}
                  x={b.x0}
                  y={b.y0}
                  width={b.x1 - b.x0}
                  height={b.y1 - b.y0}
                />
              ))}
              {(matches?.page === page && !white ? (matches.variantBoxes ?? []) : []).map((b, i) => (
                <rect key={`v${String(i)}`} className="redact-variant-box" x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} />
              ))}
              {picked.map((w, i) => (
                <rect key={`p${String(i)}`} className="redact-pick" x={w.x0} y={w.y0} width={w.x1 - w.x0} height={w.y1 - w.y0} />
              ))}
              {rect !== undefined && (
                <rect className="redact-drag" x={rect.x0} y={rect.y0} width={rect.x1 - rect.x0} height={rect.y1 - rect.y0} />
              )}
            </svg>
          )}
        </div>
      </div>
      <div className="redact-list">
        <h3 className="redact-title">伏せ字にする語</h3>
        <p className="redact-summary">
          {enabled.length} 語・{counting ? "数えています…" : `${String(totalHits)} か所`}
        </p>
        {terms.length === 0 ? (
          <p className="form-note redact-empty">ページの画像の上をドラッグして語を選ぶと、ここに足されます。</p>
        ) : (
          <ul className="redact-terms">
            {terms.map((t) => {
              const m = countOf(t.term);
              return (
                <li key={t.term} className="redact-term">
                  <label className="redact-term-label">
                    <input
                      type="checkbox"
                      checked={t.on}
                      onChange={(e) => onChange(terms.map((x) => (x.term === t.term ? { ...x, on: e.target.checked } : x)))}
                    />
                    <span className="redact-term-text">{t.term}</span>
                  </label>
                  <span className="redact-term-count">{t.on ? (m === undefined ? "—" : `${String(m.count)} か所`) : "外す"}</span>
                  <span className="redact-term-nav">
                    <button type="button" className="text-button" disabled={!t.on || (m?.pages.length ?? 0) === 0} onClick={() => jump(m?.pages ?? [], -1)}>
                      前
                    </button>
                    <button type="button" className="text-button" disabled={!t.on || (m?.pages.length ?? 0) === 0} onClick={() => jump(m?.pages ?? [], 1)}>
                      次
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`${t.term} を一覧から除く`}
                      onClick={() => onChange(terms.filter((x) => x.term !== t.term))}
                    >
                      除く
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="redact-add">
          <input
            className="text-input"
            value={input}
            placeholder="語を入力"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(input);
                setInput("");
              }
            }}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => {
              add(input);
              setInput("");
            }}
          >
            足す
          </button>
        </div>
        {!counting && (matches?.unmatched.length ?? 0) > 0 && (
          <div className="redact-variants">
            <p className="redact-variants-title">空白の入り方だけ違って当たらなかった所（伏せ字になりません）</p>
            <ul className="redact-terms">
              {matches!.unmatched.slice(0, MAX_VARIANTS).map((v) => {
                const action = variantAction(v.text, terms);
                return (
                  <li key={v.text} className="redact-term">
                    <span className="redact-term-text">{v.text}</span>
                    <span className="redact-term-count">
                      {v.count} か所（{v.pages.slice(0, 5).map((p) => `p.${String(p)}`).join(", ")}
                      {v.pages.length > 5 ? " ほか" : ""}）
                    </span>
                    <span className="redact-term-nav">
                      <button type="button" className="text-button" onClick={() => jump(v.pages, -1)}>
                        前
                      </button>
                      <button type="button" className="text-button" onClick={() => jump(v.pages, 1)}>
                        次
                      </button>
                      {action === "add" && (
                        <button type="button" className="text-button" onClick={() => add(v.text)}>
                          語に足す
                        </button>
                      )}
                    </span>
                    {action === "same" && (
                      <span className="redact-variant-note">語と同じ形に見えますが、文字の間に見えない文字があるなどで当たりません。語を足しても伏せ字になりません。</span>
                    )}
                    {action === "invalid" && <span className="redact-variant-note">2〜200 文字に収まらないため、語に足せません。</span>}
                    {action === "add" && crossesWords(v.text) && (
                      <span className="redact-variant-note">語の境目をまたいだ偶然の並びかもしれません。足すとこの並びも伏せ字になります。</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {matches!.unmatched.length > MAX_VARIANTS && (
              <p className="form-note">ほか {matches!.unmatched.length - MAX_VARIANTS} 通りの書き方があります。</p>
            )}
          </div>
        )}
        {!counting && mismatch.length > 0 && (
          <p className="error redact-mismatch">
            {mismatch.slice(0, 10).join("・")}
            {mismatch.length > 10 ? " ほか" : ""} ページで、文字と画像の当たりの数が合いません。語をページの文字どおりに直すか外すまで、翻訳を始められません。
          </p>
        )}
        {error !== undefined && <p className="error">{error}</p>}
        <p className="form-note">
          一覧の語は、文書全体の同じ文字列もすべて *** に置き換えてから LLM に渡し、ページの画像では白く塗ります。赤枠が塗られる位置です。図の中の画像の文字は消せません。
        </p>
      </div>
    </section>
  );
}
