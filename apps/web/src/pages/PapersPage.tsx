import { useState } from "react";
import { api } from "../api.js";
import { includesFold, useLoad } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

export function PapersPage() {
  const [papers] = useLoad(() => api.papers(), []);
  const [q, setQ] = useState("");
  return (
    <>
      <h1 className="page-title">論文</h1>
      <input
        className="search search-wide"
        type="search"
        placeholder="論文名・arXiv ID で探す"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {papers.state !== "ok" ? (
        <Status loaded={papers} />
      ) : (
        <ul className="paper-list">
          {papers.data
            .filter((p) => q.trim() === "" || [p.id, p.titleJa, p.titleEn].some((s) => includesFold(s, q)))
            .map((p) => (
              <li key={p.id} className="paper-row">
                <a className="paper-titles" href={href.paper(p.id)}>
                  <span className="paper-title-ja">{p.titleJa ?? p.titleEn ?? p.id}</span>
                  {p.titleEn !== undefined && <span className="paper-title-en">{p.titleEn}</span>}
                </a>
                <div className="paper-meta">
                  <span>{p.id}</span>
                  <span className="sep" aria-hidden="true" />
                  <span>用語 {p.termCount}</span>
                </div>
                <div className="paper-links">
                  <PdfLink id={p.id} kind="ja" on={p.pdf.ja} label="和訳 PDF" />
                  <span className="sep" aria-hidden="true" />
                  <PdfLink id={p.id} kind="bilingual" on={p.pdf.bilingual} label="対訳 PDF" />
                </div>
              </li>
            ))}
          {papers.data.length === 0 && (
            <li className="empty">
              article/ に訳した論文がありません。
              <a className="link" href={href.search()}>
                探す
              </a>
              から翻訳を始められます。
            </li>
          )}
        </ul>
      )}
    </>
  );
}

export function PdfLink(props: { id: string; kind: "ja" | "bilingual"; on: boolean; label: string }) {
  if (!props.on) return <span className="muted">{props.label}なし</span>;
  return (
    <a className="link" href={api.pdfUrl(props.id, props.kind)} target="_blank" rel="noreferrer">
      {props.label}
    </a>
  );
}
