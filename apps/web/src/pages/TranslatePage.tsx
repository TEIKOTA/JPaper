import { useEffect, useRef, useState } from "react";
import {
  api,
  JOB_PHASE_LABEL,
  JOB_STATE_LABEL,
  largePdfOf,
  providerLabel,
  type Job,
  type LargePdf,
  type SettingsResponse,
  type StartJob,
  type Upload,
} from "../api.js";
import { errorText, useLoad, usePoll } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";
import { RedactPanel, validTerm, type RedactTerm } from "./RedactPanel.js";

const POLL_MS = 2000;

export function TranslatePage(props: { id?: string; title?: string }) {
  const [settings, reloadSettings] = useLoad(() => api.settings(), [], { keepOnError: true });
  const [jobs, reloadJobs] = usePoll(() => api.jobs(), POLL_MS);
  return (
    <>
      <h1 className="page-title">翻訳</h1>
      {settings.state !== "ok" ? (
        <Status loaded={settings} />
      ) : (
        <TranslateForm
          key={`${props.id ?? ""}/${props.title ?? ""}`}
          settings={settings.data}
          id={props.id}
          title={props.title}
          onStarted={() => {
            reloadJobs();
            reloadSettings();
          }}
        />
      )}
      <h2 className="section-title">ジョブ</h2>
      {jobs.state !== "ok" ? <Status loaded={jobs} /> : <JobList jobs={jobs.data} onChange={reloadJobs} />}
    </>
  );
}

type Source = "arxiv" | "pdf";

// アップロードの上限（API の MAX_UPLOAD_BYTES と同じ）。契約付録 §9
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// PDF を読める provider（CLI の IMAGE_PROVIDERS と同じ）。契約付録 §8
const PDF_PROVIDERS = new Set(["claude", "codex"]);

function TranslateForm(props: {
  settings: SettingsResponse;
  id: string | undefined;
  title: string | undefined;
  onStarted: () => void;
}) {
  const { settings, providers } = props.settings;
  const defaultsFor = (p: string) => settings.providers[p] ?? {};
  const [source, setSource] = useState<Source>("arxiv");
  const [arxivId, setArxivId] = useState(props.id ?? "");
  const [upload, setUpload] = useState<Upload>();
  const [uploading, setUploading] = useState(false);
  // ジョブを加えたらファイルの選択欄を作り直して空にする。
  const [fileKey, setFileKey] = useState(0);
  // 最後に選んだファイルの送信の番号。古い送信の応答は捨てる。
  const uploadSeq = useRef(0);
  const [pages, setPages] = useState("");
  // 伏せ字の語（PDF は画面で選ぶ、arXiv はファイルから読む）。契約付録 §9
  const [redact, setRedact] = useState<RedactTerm[]>([]);
  const [large, setLarge] = useState<LargePdf>();
  const [provider, setProvider] = useState(settings.provider ?? "");
  const [model, setModel] = useState(defaultsFor(settings.provider ?? "").model ?? "");
  const [effort, setEffort] = useState(defaultsFor(settings.provider ?? "").effort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState<string>();
  const history = settings.history;
  const acceptsEffort = providers.find((p) => p.name === provider)?.effort === true;
  const title = props.title !== undefined && arxivId.trim() === props.id ? props.title : undefined;
  const ready = source === "arxiv" ? arxivId.trim() !== "" : upload !== undefined && !uploading;

  useEffect(() => setError(undefined), [source, arxivId, pages, provider, model, effort]);

  const redactOn = redact.filter((t) => t.on).map((t) => t.term);
  const options = {
    provider,
    ...(model.trim() === "" ? {} : { model: model.trim() }),
    ...(acceptsEffort && effort.trim() !== "" ? { effort: effort.trim() } : {}),
    ...(redactOn.length === 0 ? {} : { redact: redactOn }),
  };

  const start = (body: StartJob) => {
    setBusy(true);
    setStarted(undefined);
    api.startJob(body).then(
      (r) => {
        setBusy(false);
        setLarge(undefined);
        setStarted(`${r.job.label} を${JOB_STATE_LABEL[r.job.state]}のジョブに加えました。`);
        setArxivId("");
        setUpload(undefined);
        setPages("");
        setRedact([]);
        setFileKey((k) => k + 1);
        if (props.id !== undefined) window.history.replaceState(null, "", href.translate());
        props.onStarted();
      },
      (err: unknown) => {
        setBusy(false);
        const big = largePdfOf(err);
        if (big !== undefined) setLarge(big);
        else {
          setLarge(undefined);
          setError(errorText(err));
        }
      },
    );
  };

  const startPdf = (range: string, confirmLarge: boolean) => {
    if (upload === undefined) return;
    start({
      upload: upload.id,
      name: upload.name,
      ...(range.trim() === "" ? {} : { pages: range.trim() }),
      ...(confirmLarge ? { confirmLarge: true } : {}),
      ...options,
    });
  };

  return (
    <>
      <form
        className="translate-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (source === "pdf") startPdf(pages, false);
          else start({ arxivId: arxivId.trim(), ...options, ...(title === undefined ? {} : { title }) });
        }}
      >
        <div className="source-switch" role="radiogroup" aria-label="入力">
          {(
            [
              ["arxiv", "arXiv ID"],
              ["pdf", "PDF"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={`source-option${source === value ? " is-on" : ""}`}>
              <input type="radio" name="source" value={value} checked={source === value} onChange={() => {
                  setSource(value);
                  setRedact([]);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {source === "arxiv" ? (
          <>
            <label className="field">
              <span className="field-label">arXiv ID</span>
              <input
                className="text-input input-id"
                value={arxivId}
                placeholder="例 2601.20627"
                onChange={(e) => setArxivId(e.target.value)}
              />
            </label>
            {title !== undefined && <p className="form-title">{title}</p>}
            <label className="field">
              <span className="field-label">伏せ字の語のファイル（任意。1 行 1 語）</span>
              <input
                key={fileKey}
                className="file-input"
                type="file"
                accept=".txt,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setRedact([]);
                  if (file === undefined) return;
                  void file.text().then((text) => {
                    const terms = parseTermLines(text);
                    if (terms === undefined) setError("伏せ字の語は 1 行 1 語、2〜200 文字にしてください");
                    else setRedact(terms.map((term) => ({ term, on: true })));
                  });
                }}
              />
              <span className="file-status">{redact.length > 0 ? `${String(redact.length)} 語を伏せ字にします` : ""}</span>
            </label>
          </>
        ) : (
          <div className="form-row">
            <label className="field">
              <span className="field-label">PDF</span>
              <input
                key={fileKey}
                className="file-input"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  const seq = ++uploadSeq.current;
                  setUpload(undefined);
                  setUploading(false);
                  setRedact([]);
                  if (file === undefined) return;
                  if (file.size > MAX_UPLOAD_BYTES) {
                    setError(`PDF が上限 ${String(MAX_UPLOAD_BYTES / 1024 / 1024)}MiB を超えています`);
                    return;
                  }
                  setUploading(true);
                  api.uploadPdf(file).then(
                    (u) => {
                      if (seq !== uploadSeq.current) return;
                      setUploading(false);
                      setUpload(u);
                      setError(undefined);
                    },
                    (err: unknown) => {
                      if (seq !== uploadSeq.current) return;
                      setUploading(false);
                      setError(errorText(err));
                    },
                  );
                }}
              />
              <span className="file-status">
                {uploading ? "送っています…" : upload !== undefined ? `${upload.name}（${String(upload.pages)} ページ）` : ""}
              </span>
            </label>
            <label className="field">
              <span className="field-label">ページの範囲（任意）</span>
              <input
                className="text-input input-short"
                value={pages}
                placeholder="例 1-72"
                onChange={(e) => setPages(e.target.value)}
              />
            </label>
          </div>
        )}
        {source === "pdf" && upload !== undefined && <RedactPanel upload={upload} terms={redact} onChange={setRedact} />}
        <div className="form-row">
          <label className="field">
            <span className="field-label">provider</span>
            <select
              className="select"
              value={provider}
              onChange={(e) => {
                const p = e.target.value;
                setProvider(p);
                setModel(defaultsFor(p).model ?? "");
                setEffort(defaultsFor(p).effort ?? "");
              }}
            >
              <option value="">選んでください</option>
              {providers.map((p) => (
                <option key={p.name} value={p.name} disabled={source === "pdf" && !PDF_PROVIDERS.has(p.name)}>
                  {providerLabel(p.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">model</span>
            <input
              className="text-input input-mid"
              value={model}
              placeholder="未指定"
              list="model-history"
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="model-history">
              {(history[provider]?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {acceptsEffort && (
            <label className="field">
              <span className="field-label">effort</span>
              <input
                className="text-input input-short"
                value={effort}
                placeholder="未指定"
                list="effort-history"
                onChange={(e) => setEffort(e.target.value)}
              />
              <datalist id="effort-history">
                {(history[provider]?.efforts ?? []).map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
          )}
        </div>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy || provider === "" || !ready}>
            {busy ? "加えています…" : source === "pdf" && redactOn.length > 0 ? "この内容で翻訳を始める" : "翻訳を始める"}
          </button>
          {error !== undefined && <span className="error">{error}</span>}
          {started !== undefined && <span>{started}</span>}
        </div>
        <p className="form-note">
          {source === "pdf" ? (
            <>PDF はテキスト層のあるものだけを、claude・GPT で読みます。100 ページを超えると、始める前に確認します。</>
          ) : (
            <>
              初期値は<a className="link" href={href.settings()}>設定</a>で決められます。訳したい論文は
              <a className="link" href={href.search()}>探す</a>から選べます。
            </>
          )}
        </p>
      </form>
      {large !== undefined && (
        <LargePdfDialog
          info={large}
          range={pages}
          busy={busy}
          onCancel={() => setLarge(undefined)}
          onContinue={(range) => {
            setPages(range);
            startPdf(range, true);
          }}
        />
      )}
    </>
  );
}

// 伏せ字の語のファイル（CLI の --redact-file と同じ形: 1 行 1 語、空行と # の行は読まない）。形が違えば undefined。
export function parseTermLines(text: string): string[] | undefined {
  const terms = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")))];
  return terms.every(validTerm) ? terms : undefined;
}

// 範囲の指定（"1-72,80"）が選ぶページ数。形が違えば undefined。数えるのは目安の表示のためだけ（検査は API）。
export function countPages(spec: string, total: number): number | undefined {
  if (spec.trim() === "") return total;
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (m === null) return undefined;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b > total) return undefined;
    for (let p = a; p <= b; p++) pages.add(p);
  }
  return pages.size;
}

function LargePdfDialog(props: {
  info: LargePdf;
  range: string;
  busy: boolean;
  onCancel: () => void;
  onContinue: (range: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [range, setRange] = useState(props.range);
  const { info } = props;
  const n = countPages(range, info.total);
  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);
  const usd = n === undefined ? undefined : Math.round(n * info.perPage.usd * 10) / 10;
  const minutes =
    n === undefined ? undefined : Math.max(1, Math.ceil((n * info.perPage.seconds) / Math.max(1, info.perPage.concurrency) / 60));
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="large-pdf-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="large-pdf-title" className="dialog-title">
        ページ数の多い PDF です
      </h2>
      <dl className="dialog-facts">
        <dt>ページ数</dt>
        <dd>
          {info.total} ページ（読むのは {n === undefined ? "—" : n} ページ）
        </dd>
        <dt>読み取りの目安</dt>
        <dd>{usd === undefined ? "—" : `約 $${String(usd)}・約 ${String(minutes)} 分`}</dd>
      </dl>
      <p className="dialog-note">翻訳の費用と時間は、これとは別にかかります。</p>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy && n !== undefined) props.onContinue(range);
        }}
      >
        <label className="field">
          <span className="field-label">ページの範囲（空なら全部）</span>
          <input
            className="text-input input-short"
            value={range}
            placeholder="例 1-72"
            onChange={(e) => setRange(e.target.value)}
          />
          {n === undefined && <span className="error dialog-error">範囲は 1-72・3,5-9 のように 1〜{info.total} で指定してください</span>}
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={props.onCancel}>
            やめる
          </button>
          <button type="submit" className="primary" disabled={props.busy || n === undefined}>
            {props.busy ? "加えています…" : "続ける"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function JobList(props: { jobs: Job[]; onChange: () => void }) {
  const active = props.jobs.filter((j) => j.state === "running" || j.state === "queued");
  const finished = props.jobs.filter((j) => !(j.state === "running" || j.state === "queued")).reverse();
  if (props.jobs.length === 0) return <p className="empty">ジョブはありません。</p>;
  return (
    <ul className="job-list">
      {[...active, ...finished].map((j) => (
        <JobRow key={j.id} job={j} onChange={props.onChange} />
      ))}
    </ul>
  );
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${String(h)}時間${String(m)}分` : m > 0 ? `${String(m)}分${String(sec)}秒` : `${String(sec)}秒`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

function JobRow(props: { job: Job; onChange: () => void }) {
  const j = props.job;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const live = j.state === "running" || j.state === "queued";
  const label =
    j.state === "running" && j.phase !== undefined
      ? `${JOB_STATE_LABEL[j.state]}・${JOB_PHASE_LABEL[j.phase]}`
      : JOB_STATE_LABEL[j.state];
  const opts = [providerLabel(j.options.provider), j.options.model, j.options.effort].filter((s) => s !== undefined).join(" / ");
  return (
    <li className={`job-row job-${j.state}`}>
      <div className="job-main">
        {j.state === "done" ? (
          <a className="job-title link" href={href.paper(j.paperId)}>
            {j.title ?? j.label}
          </a>
        ) : (
          <span className="job-title">{j.title ?? j.label}</span>
        )}
        <div className="job-meta">
          {j.pdf?.pages !== undefined && (
            <>
              <span>p.{j.pdf.pages}</span>
              <span className="sep" aria-hidden="true" />
            </>
          )}
          {j.title !== undefined && (
            <>
              <span>{j.label}</span>
              <span className="sep" aria-hidden="true" />
            </>
          )}
          <span>{opts}</span>
        </div>
        {j.error !== undefined && <p className="job-error error">{j.error}</p>}
        {error !== undefined && <p className="job-error error">{error}</p>}
      </div>
      <div className="job-status">
        <span className="job-state">{label}</span>
        {j.section !== undefined && (
          <span>
            節 {j.section.done}/{j.section.total}
          </span>
        )}
        {j.startedAt !== undefined && <span>費用 {formatCost(j.costUsd)}</span>}
        {j.startedAt !== undefined && <span>経過 {formatElapsed((j.finishedAt ?? Date.now()) - j.startedAt)}</span>}
      </div>
      <div className="job-actions">
        {live && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.cancelJob(j.id).then(
                () => {
                  setBusy(false);
                  props.onChange();
                },
                (e: unknown) => {
                  setBusy(false);
                  setError(errorText(e));
                },
              );
            }}
          >
            {busy ? "取り消しています…" : "取り消す"}
          </button>
        )}
      </div>
      {j.log.length > 0 &&
        (j.state === "running" ? (
          <pre className="job-log">{j.log.slice(-8).join("\n")}</pre>
        ) : (
          <details className="job-log-details">
            <summary>ログ</summary>
            <pre className="job-log">{j.log.join("\n")}</pre>
          </details>
        ))}
    </li>
  );
}
