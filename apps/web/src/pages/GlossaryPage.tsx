import { useState } from "react";
import { api, RENDERING_LABEL } from "../api.js";
import { includesFold, useLoad } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

const STATUS_LABEL = { confirmed: "承認済み", proposed: "提案" } as const;

export function GlossaryPage() {
  const [terms] = useLoad(() => api.glossary(), []);
  const [q, setQ] = useState("");
  const [onlyConfirmed, setOnlyConfirmed] = useState(true);
  return (
    <>
      <h1 className="page-title">全体の用語 DB</h1>
      <div className="paper-actions">
        <label className="check">
          <input type="checkbox" checked={onlyConfirmed} onChange={(e) => setOnlyConfirmed(e.target.checked)} />
          <span>承認済みだけを表示</span>
        </label>
        <input
          className="search search-narrow"
          type="search"
          placeholder="原語・訳語で探す"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {terms.state !== "ok" ? (
        <Status loaded={terms} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>原語</th>
              <th>訳語</th>
              <th>表記</th>
              <th>状態</th>
              <th>出典</th>
              <th>影響あり</th>
            </tr>
          </thead>
          <tbody>
            {terms.data
              .filter((t) => !onlyConfirmed || t.status === "confirmed")
              .filter((t) => q.trim() === "" || includesFold(t.src, q) || includesFold(t.ja, q))
              .map((t, i) => (
                <tr key={`${t.src}-${String(i)}`}>
                  <td>{t.src}</td>
                  <td>{t.ja ?? "—"}</td>
                  <td>{RENDERING_LABEL[t.rendering] ?? t.rendering}</td>
                  <td>{STATUS_LABEL[t.status]}</td>
                  <td>{t.source ?? "—"}</td>
                  <td>
                    {t.affected.length === 0
                      ? "—"
                      : t.affected.map((a) => (
                          <a key={a.id} className="link affected-link" href={href.term(a.id, t.src, t.ja ?? undefined)}>
                            {a.id}（{a.currentJa}）
                          </a>
                        ))}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </>
  );
}
