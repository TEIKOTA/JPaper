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

// この幅（pt）未満の隙間で縦に重なる隣の語は空白なしで、行末（段の最後の行を除く。eol）が - の語は - を落として次の語へ空白なしでつなぐ。
// ⚠ CLI の src/ingest/pdf/redact-pdf.ts の JOIN_GAP・spaceBetween・hyphenated と同じ規則（RedactPanel.test.ts で突き合わせる）。
export const JOIN_GAP = 0.25;

export function spaceBetween(a: WordBox, b: WordBox): boolean {
  return !(b.x0 - a.x1 < JOIN_GAP && b.x0 >= a.x0 && b.y1 > a.y0 && b.y0 < a.y1);
}

export function hyphenated(w: { text: string; eol?: boolean }): boolean {
  return w.eol === true && w.text.endsWith("-");
}

// 選んだ語をテキスト層と同じようにつないだ文字列から、前後の句読点・括弧を落とす。
export function termFromWords(words: readonly (WordBox & { text: string; eol?: boolean })[]): string {
  return words
    .map((w, i) => {
      const prev = words[i - 1];
      const sep = prev !== undefined && !hyphenated(prev) && spaceBetween(prev, w) ? " " : "";
      return sep + (hyphenated(w) && i < words.length - 1 ? w.text.slice(0, -1) : w.text);
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

  const jump = (term: string, dir: 1 | -1): void => {
    const pages = countOf(term)?.pages ?? [];
    if (pages.length === 0) return;
    const next = dir === 1 ? (pages.find((p) => p > page) ?? pages[0]!) : ([...pages].reverse().find((p) => p < page) ?? pages[pages.length - 1]!);
    setPage(next);
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
                    <button type="button" className="text-button" disabled={!t.on || (m?.pages.length ?? 0) === 0} onClick={() => jump(t.term, -1)}>
                      前
                    </button>
                    <button type="button" className="text-button" disabled={!t.on || (m?.pages.length ?? 0) === 0} onClick={() => jump(t.term, 1)}>
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
