import { useState } from "react";
import { api, DB_LABEL, RENDERING_LABEL, type BackupInfo } from "../api.js";
import { includesFold, useLoad } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

export function PaperPage(props: { id: string }) {
  const [paper, reload] = useLoad(() => api.paper(props.id), [props.id]);
  const [q, setQ] = useState("");
  if (paper.state !== "ok") return <Status loaded={paper} />;
  const p = paper.data;
  const terms = p.terms.filter((t) => q.trim() === "" || includesFold(t.src, q) || includesFold(t.ja, q));
  return (
    <>
      <nav className="breadcrumb">
        <a href={href.papers()}>論文</a>
        <span aria-hidden="true">/</span>
        <span>{p.id}</span>
      </nav>
      <h1 className="paper-heading">{p.titleJa ?? p.titleEn ?? p.id}</h1>
      {p.titleEn !== undefined && <p className="paper-subtitle">{p.titleEn}</p>}
      <div className="paper-actions paper-actions-end">
        <input
          className="search search-narrow"
          type="search"
          placeholder="用語を検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {p.backup !== null && <UndoBar id={p.id} backup={p.backup} onDone={reload} />}
      <table className="table terms">
        <thead>
          <tr>
            <th>原語</th>
            <th>訳語</th>
            <th>表記</th>
            <th className="num">出現数</th>
            <th>全体 DB</th>
          </tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr
              key={t.src}
              className={t.editable ? "clickable" : "fixed"}
              onClick={() => {
                if (t.editable) window.location.hash = href.term(p.id, t.src);
              }}
            >
              <td>
                {t.editable ? <a href={href.term(p.id, t.src)}>{t.src}</a> : t.src}
              </td>
              <td>{t.ja}</td>
              <td>{RENDERING_LABEL[t.rendering] ?? t.rendering}</td>
              <td className="num">{t.count}</td>
              <td>{DB_LABEL[t.db]}</td>
            </tr>
          ))}
          {terms.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                該当する用語がありません。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getMonth() + 1)}/${String(d.getDate())} ${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
      ).padStart(2, "0")}`;
}

function UndoBar(props: { id: string; backup: BackupInfo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const b = props.backup;
  return (
    <div className="notice">
      <span>
        直前の適用（{formatTime(b.createdAt)}）: {b.src} {b.oldForm} → {b.newForm}
        {b.registerGlobal && "（全体の用語 DB への登録は元に戻しません）"}
      </span>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          api.undo(props.id).then(
            () => props.onDone(),
            (e: unknown) => {
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      >
        {busy ? "戻しています…" : "元に戻す"}
      </button>
      {error !== undefined && <span className="error">{error}</span>}
    </div>
  );
}
