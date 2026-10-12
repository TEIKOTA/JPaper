import { useEffect, useState } from "react";
import { api, JOB_STATE_LABEL, type ArxivEntry } from "../api.js";
import { errorText, includesFold, useLoad, type Loaded } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

type ArxivLoaded = { state: "idle" } | Loaded<{ total?: number; entries: ArxivEntry[] }>;

export function SearchPage(props: { q?: string }) {
  const q = props.q ?? "";
  const [input, setInput] = useState(q);
  const [papers] = useLoad(() => api.papers(), []);
  const [arxiv, setArxiv] = useState<ArxivLoaded>({ state: "idle" });

  useEffect(() => {
    if (q.trim() === "") {
      setArxiv({ state: "idle" });
      return;
    }
    const ac = new AbortController();
    setArxiv({ state: "loading" });
    api.arxiv(q, ac.signal).then(
      (data) => setArxiv({ state: "ok", data }),
      (e: unknown) => {
        if (!ac.signal.aborted) setArxiv({ state: "error", message: errorText(e) });
      },
    );
    return () => ac.abort();
  }, [q]);

  const needle = input.trim();
  const local =
    papers.state === "ok" && needle !== ""
      ? papers.data.filter((p) => [p.id, p.titleJa, p.titleEn].some((s) => includesFold(s, needle)))
      : [];

  return (
    <>
      <h1 className="page-title">探す</h1>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          window.location.hash = href.search(input.trim());
        }}
      >
        <input
          className="search search-wide"
          type="search"
          placeholder="論文名・キーワード・arXiv ID"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="primary" type="submit" disabled={needle === ""}>
          arXiv も検索
        </button>
      </form>

      {needle !== "" && (
        <section className="result-section">
          <h2 className="section-title">手元の論文</h2>
          {papers.state !== "ok" ? (
            <Status loaded={papers} />
          ) : (
            <ul className="paper-list paper-list-flat">
              {local.map((p) => (
                <li key={p.id} className="paper-row">
                  <a className="paper-titles" href={href.paper(p.id)}>
                    <span className="paper-title-ja">{p.titleJa ?? p.titleEn ?? p.id}</span>
                    {p.titleEn !== undefined && <span className="paper-title-en">{p.titleEn}</span>}
                  </a>
                  <div className="paper-meta">
                    <span>{p.id}</span>
                  </div>
                  <div className="paper-links">
                    <span className="muted">{p.pdf.ja ? "訳済み" : "途中まで"}</span>
                  </div>
                </li>
              ))}
              {local.length === 0 && <li className="empty">手元に該当する論文はありません。</li>}
            </ul>
          )}
        </section>
      )}

      <section className="result-section">
        <h2 className="section-title">
          arXiv
          {arxiv.state === "ok" && arxiv.data.total !== undefined && (
            <span className="section-count">
              {arxiv.data.total} 件中 {arxiv.data.entries.length} 件
            </span>
          )}
        </h2>
        {arxiv.state === "idle" ? (
          <p className="status">検索語を入れて「arXiv も検索」を押すと、arXiv の論文を出します。arXiv ID でも探せます。</p>
        ) : arxiv.state !== "ok" ? (
          arxiv.state === "loading" ? (
            <p className="status">arXiv に問い合わせています…</p>
          ) : (
            <p className="status error">{arxiv.message}</p>
          )
        ) : (
          <ul className="paper-list paper-list-flat">
            {arxiv.data.entries.map((e) => (
              <ArxivRow key={e.id} entry={e} />
            ))}
            {arxiv.data.entries.length === 0 && <li className="empty">arXiv に該当する論文はありません。</li>}
          </ul>
        )}
      </section>
    </>
  );
}

function authorsText(authors: string[]): string {
  return authors.length <= 3 ? authors.join(", ") : `${authors.slice(0, 3).join(", ")} ほか`;
}

function ArxivRow(props: { entry: ArxivEntry }) {
  const e = props.entry;
  return (
    <li className="paper-row result-row">
      <div className="paper-titles">
        <a className="result-title" href={`https://arxiv.org/abs/${e.id}`} target="_blank" rel="noreferrer">
          {e.title}
        </a>
        <span className="paper-title-en">
          {authorsText(e.authors)}
          {e.published !== "" && `（${e.published.slice(0, 10)}）`}
        </span>
        <p className="result-summary">{e.summary}</p>
      </div>
      <div className="paper-meta">
        <span>{e.id}</span>
      </div>
      <div className="paper-links">
        {e.local?.pdf === true ? (
          <a className="link" href={href.paper(e.paperId)}>
            訳済み
          </a>
        ) : e.job !== null ? (
          <a className="link" href={href.translate()}>
            {JOB_STATE_LABEL[e.job]}
          </a>
        ) : (
          <>
            {e.local !== null && <span className="muted">途中まで</span>}
            <a className="secondary small" href={href.translate(e.id, e.title)}>
              翻訳する
            </a>
          </>
        )}
      </div>
    </li>
  );
}
