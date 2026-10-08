import { Fragment, useEffect, useState } from "react";
import { api, type ApplyResult, type Piece, type Preview, type PreviewItem } from "../api.js";
import { useLoad } from "../load.js";
import { href } from "../router.js";
import { PdfLink } from "./PapersPage.js";
import { Status } from "./Status.js";

type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; data: Preview };

export function TermPage(props: { id: string; src: string; initialJa?: string }) {
  const [paper] = useLoad(() => api.paper(props.id), [props.id]);
  const [ja, setJa] = useState(props.initialJa ?? "");
  const [register, setRegister] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [result, setResult] = useState<ApplyResult>();

  useEffect(() => {
    if (ja.trim() === "") {
      setPreview({ state: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setPreview({ state: "loading" });
    const timer = setTimeout(() => {
      api.preview(props.id, props.src, ja, ctrl.signal).then(
        (data) => setPreview({ state: "ok", data }),
        (e: unknown) => {
          if (!ctrl.signal.aborted) setPreview({ state: "error", message: e instanceof Error ? e.message : String(e) });
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [props.id, props.src, ja]);

  if (paper.state !== "ok") return <Status loaded={paper} />;
  const row = paper.data.terms.find((t) => t.src === props.src);
  if (row === undefined) return <p className="status error">用語集に {props.src} がありません。</p>;
  if (result !== undefined) return <Done id={props.id} src={props.src} result={result} />;

  const p = preview.state === "ok" ? preview.data : undefined;
  const apply = () => {
    if (p === undefined) return;
    setApplying(true);
    setApplyError(undefined);
    api.apply(props.id, props.src, ja, register).then(
      (r) => {
        setApplying(false);
        setResult(r);
        window.scrollTo(0, 0);
      },
      (e: unknown) => {
        setApplying(false);
        setApplyError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  return (
    <div className="term-page">
      <nav className="breadcrumb">
        <a href={href.papers()}>論文</a>
        <span aria-hidden="true">/</span>
        <a href={href.paper(props.id)}>{props.id}</a>
      </nav>
      <h1 className="term-heading">{props.src}</h1>
      <p className="term-current">現在の訳語: {row.ja}</p>
      {!row.editable ? (
        <p className="status">原語のまま扱う語なので訳語を編集できません。</p>
      ) : (
        <>
          <label className="field-label" htmlFor="new-ja">
            新しい訳語
          </label>
          <div className="edit-row">
            <input
              id="new-ja"
              className="text-input"
              value={ja}
              autoFocus
              disabled={applying}
              onChange={(e) => setJa(e.target.value)}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={register}
                disabled={applying}
                onChange={(e) => setRegister(e.target.checked)}
              />
              <span>全体の用語 DB にも登録する</span>
            </label>
          </div>
          {preview.state === "error" && <p className="field-error">{preview.message}</p>}
          {p !== undefined && <PreviewNotes preview={p} />}
          <h2 className="section-title">
            出現箇所 {p === undefined ? "–" : p.replaced} 件
          </h2>
          {preview.state === "idle" && <p className="muted">新しい訳語を入力すると、置き換える箇所をここに並べます。</p>}
          {preview.state === "loading" && <p className="muted">出現箇所を探しています…</p>}
          {p !== undefined && (
            <>
              <ol className="occurrences">
                {p.items.map((it, i) => (
                  <Occurrence key={i} item={it} shields={p.shields} />
                ))}
              </ol>
              {p.contextItems.length > 0 && (
                <details className="context">
                  <summary>本文以外の書き換え {p.contextItems.reduce((n, it) => n + it.replaced, 0)} 件（用語集の訳注・文書ブリーフ・評価の訳注）</summary>
                  <ol className="occurrences">
                    {p.contextItems.map((it, i) => (
                      <Occurrence key={i} item={it} shields={p.shields} />
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
          <div className="footer-spacer" />
          <footer className="action-bar">
            <div className="container action-inner">
              <span className={applyError === undefined ? "" : "error"}>
                {applyError ??
                  (applying
                    ? "置換して組み直しています…（組版に 1 分ほどかかります）"
                    : p === undefined
                      ? "新しい訳語を入力してください"
                      : `${String(p.replaced)} 件を置換し、和訳 PDF と対訳 PDF を組み直します`)}
              </span>
              <span className="actions">
                <a className="link" href={href.paper(props.id)}>
                  キャンセル
                </a>
                <button className="primary" disabled={p === undefined || applying} onClick={apply}>
                  {applying ? "適用中…" : "置換を適用"}
                </button>
              </span>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function PreviewNotes(props: { preview: Preview }) {
  const p = props.preview;
  const notes: string[] = [];
  if (p.rendering === "bilingual") notes.push(`初出は「${p.newForm}」、以降は「${p.newJa}」になります。`);
  for (const s of p.shields) {
    notes.push(`「${s.ja}」は別の語（${s.src}）の訳語なので、その中の「${p.oldJa}」は置き換えません（印の箇所）。`);
  }
  if (p.sameJa.length > 0) notes.push(`別の語（${p.sameJa.join("、")}）も同じ訳語「${p.oldJa}」です。その語の出現も置き換わります。`);
  if (p.migrated) {
    notes.push("この論文の checkpoint は別の版の JPaper で作られています。訳文をそのまま引き継いで、今の版の鍵で署名し直します。");
  }
  return (
    <ul className="preview-notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function Pieces(props: { pieces: Piece[] }) {
  return (
    <>
      {props.pieces.map((pc, i) =>
        pc.mark === undefined ? (
          <Fragment key={i}>{pc.text}</Fragment>
        ) : (
          <span key={i} className={`mark-${pc.mark}`}>
            {pc.text}
          </span>
        ),
      )}
    </>
  );
}

function Occurrence(props: { item: PreviewItem; shields: Preview["shields"] }) {
  const it = props.item;
  const shieldJa = it.shieldedBy.map((s) => props.shields.find((x) => x.src === s)?.ja ?? s);
  return (
    <li className="occurrence">
      <div className="occ-meta">
        {it.where}
        {it.label !== "" && ` ・ ${it.label}`}
        {it.shieldedBy.length > 0 && (
          <span className="occ-shield">印: 「{shieldJa.join("」「")}」の一部（置換しない）</span>
        )}
      </div>
      {it.source !== undefined && (
        <p className="occ-source">
          <Pieces pieces={it.source} />
        </p>
      )}
      {it.prev !== undefined && <p className="occ-context">{it.prev}</p>}
      <p className="occ-line">
        <Pieces pieces={it.before} />
      </p>
      <p className="occ-line">
        <Pieces pieces={it.after} />
      </p>
      {it.next !== undefined && <p className="occ-context">{it.next}</p>}
    </li>
  );
}

function Done(props: { id: string; src: string; result: ApplyResult }) {
  const r = props.result;
  const [undo, setUndo] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string>();
  return (
    <div className="term-page">
      <nav className="breadcrumb">
        <a href={href.papers()}>論文</a>
        <span aria-hidden="true">/</span>
        <a href={href.paper(props.id)}>{props.id}</a>
      </nav>
      <h1 className="term-heading">{props.src}</h1>
      {undo === "done" ? (
        <p className="result-lead">元に戻しました。訳語は「{r.oldForm}」です。</p>
      ) : (
        <>
          <p className="result-lead">
            「{r.oldForm}」を「{r.newForm}」に直し、訳文の {r.replaced} 件を置換して
            {r.bilingualStatus === "ok" ? "和訳 PDF と対訳 PDF を組み直しました。" : "和訳 PDF を組み直しました。対訳 PDF は組めませんでした。"}
          </p>
          <div className="paper-links result-links">
            <PdfLink id={props.id} kind="ja" on={r.pdf.ja} label="和訳 PDF" />
            <span className="sep" aria-hidden="true" />
            <PdfLink id={props.id} kind="bilingual" on={r.pdf.bilingual} label="対訳 PDF" />
          </div>
          {r.registered && <p>全体の用語 DB に承認済みとして登録しました。今後訳す論文に効きます。</p>}
          {r.notices.length > 0 && (
            <ul className="preview-notes">
              {r.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {r.registered && (
            <>
              <h2 className="section-title">影響あり {r.affected.length} 本</h2>
              {r.affected.length === 0 ? (
                <p className="muted">既に訳したほかの論文に、違う訳語の「{props.src}」はありません。</p>
              ) : (
                <>
                  <p className="muted">既に訳したほかの論文で訳語が違います。反映は 1 本ずつ選んでください。</p>
                  <ul className="affected">
                    {r.affected.map((a) => (
                      <li key={a.id}>
                        <span className="affected-title">{a.titleJa ?? a.id}</span>
                        <span className="muted">
                          {a.id} ・ 今の訳語「{a.currentJa}」
                        </span>
                        <a className="link" href={href.term(a.id, props.src, r.newForm)}>
                          この論文に反映する
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
      <div className="result-actions">
        <a className="link" href={href.paper(props.id)}>
          用語集へ戻る
        </a>
        {undo !== "done" && (
          <button
            className="secondary"
            disabled={undo === "busy"}
            onClick={() => {
              setUndo("busy");
              api.undo(props.id).then(
                () => setUndo("done"),
                (e: unknown) => {
                  setUndo("idle");
                  setError(e instanceof Error ? e.message : String(e));
                },
              );
            }}
          >
            {undo === "busy" ? "戻しています…" : "元に戻す"}
          </button>
        )}
        {error !== undefined && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
