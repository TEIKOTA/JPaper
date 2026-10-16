import { useState } from "react";
import { api, type PaperSummary } from "../api.js";
import { includesFold, useLoad } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

export const PAPER_ORDERS = {
  "updated-desc": "更新日の新しい順",
  "updated-asc": "更新日の古い順",
  "created-desc": "作成日の新しい順",
  "created-asc": "作成日の古い順",
  title: "タイトル順",
} as const;

export type PaperOrder = keyof typeof PAPER_ORDERS;

function titleOf(p: PaperSummary): string {
  return p.titleJa ?? p.titleEn ?? p.id;
}

// 契約付録 §9「論文の一覧」。同じ日時・タイトルは ID の順。
export function sortPapers(papers: readonly PaperSummary[], order: PaperOrder): PaperSummary[] {
  const byId = (a: PaperSummary, b: PaperSummary) => a.id.localeCompare(b.id);
  const cmp: Record<PaperOrder, (a: PaperSummary, b: PaperSummary) => number> = {
    "updated-desc": (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    "updated-asc": (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    "created-desc": (a, b) => b.createdAt.localeCompare(a.createdAt),
    "created-asc": (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => titleOf(a).localeCompare(titleOf(b), "ja"),
  };
  return [...papers].sort((a, b) => cmp[order](a, b) || byId(a, b));
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function PapersPage() {
  const [papers] = useLoad(() => api.papers(), []);
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<PaperOrder>("updated-desc");
  const dateKey = order.startsWith("created") ? "createdAt" : "updatedAt";
  return (
    <>
      <h1 className="page-title">論文</h1>
      <div className="paper-tools">
        <input
          className="search search-wide"
          type="search"
          placeholder="論文名・arXiv ID で探す"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="select"
          aria-label="並び順"
          value={order}
          onChange={(e) => setOrder(e.target.value as PaperOrder)}
        >
          {Object.entries(PAPER_ORDERS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {papers.state !== "ok" ? (
        <Status loaded={papers} />
      ) : (
        <ul className="paper-list">
          {sortPapers(papers.data, order)
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
                  <span className="sep" aria-hidden="true" />
                  <span>
                    {dateKey === "createdAt" ? "作成" : "更新"} {formatDate(p[dateKey])}
                  </span>
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
