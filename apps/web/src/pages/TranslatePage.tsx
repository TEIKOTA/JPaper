import { useEffect, useState } from "react";
import { api, JOB_PHASE_LABEL, JOB_STATE_LABEL, providerLabel, type Job, type SettingsResponse } from "../api.js";
import { errorText, useLoad, usePoll } from "../load.js";
import { href } from "../router.js";
import { Status } from "./Status.js";

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

function TranslateForm(props: {
  settings: SettingsResponse;
  id: string | undefined;
  title: string | undefined;
  onStarted: () => void;
}) {
  const { settings, providers } = props.settings;
  const defaultsFor = (p: string) => settings.providers[p] ?? {};
  const [arxivId, setArxivId] = useState(props.id ?? "");
  const [provider, setProvider] = useState(settings.provider ?? "");
  const [model, setModel] = useState(defaultsFor(settings.provider ?? "").model ?? "");
  const [effort, setEffort] = useState(defaultsFor(settings.provider ?? "").effort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState<string>();
  const history = settings.history;
  const acceptsEffort = providers.find((p) => p.name === provider)?.effort === true;
  const title = props.title !== undefined && arxivId.trim() === props.id ? props.title : undefined;

  useEffect(() => setError(undefined), [arxivId, provider, model, effort]);

  return (
    <form
      className="translate-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setStarted(undefined);
        api
          .startJob({
            arxivId: arxivId.trim(),
            provider,
            ...(model.trim() === "" ? {} : { model: model.trim() }),
            ...(acceptsEffort && effort.trim() !== "" ? { effort: effort.trim() } : {}),
            ...(title === undefined ? {} : { title }),
          })
          .then(
            (r) => {
              setBusy(false);
              setStarted(`${r.job.arxivId} を${JOB_STATE_LABEL[r.job.state]}のジョブに加えました。`);
              setArxivId("");
              if (props.id !== undefined) window.history.replaceState(null, "", href.translate());
              props.onStarted();
            },
            (err: unknown) => {
              setBusy(false);
              setError(errorText(err));
            },
          );
      }}
    >
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
              <option key={p.name} value={p.name}>
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
        <button className="primary" type="submit" disabled={busy || provider === "" || arxivId.trim() === ""}>
          {busy ? "加えています…" : "翻訳を始める"}
        </button>
        {error !== undefined && <span className="error">{error}</span>}
        {started !== undefined && <span>{started}</span>}
      </div>
      <p className="form-note">
        初期値は<a className="link" href={href.settings()}>設定</a>で決められます。訳したい論文は
        <a className="link" href={href.search()}>探す</a>から選べます。
      </p>
    </form>
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
            {j.title ?? j.arxivId}
          </a>
        ) : (
          <span className="job-title">{j.title ?? j.arxivId}</span>
        )}
        <div className="job-meta">
          {j.title !== undefined && (
            <>
              <span>{j.arxivId}</span>
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
