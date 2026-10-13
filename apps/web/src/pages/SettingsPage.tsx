import { useState } from "react";
import { api, providerLabel, type ProviderDefaults, type SettingsResponse } from "../api.js";
import { errorText, useLoad } from "../load.js";
import { Status } from "./Status.js";

export function SettingsPage() {
  const [loaded] = useLoad(() => api.settings(), []);
  return (
    <>
      <h1 className="page-title">設定</h1>
      {loaded.state !== "ok" ? <Status loaded={loaded} /> : <SettingsForm initial={loaded.data} />}
    </>
  );
}

function SettingsForm(props: { initial: SettingsResponse }) {
  const { providers, maxConcurrency } = props.initial;
  const [provider, setProvider] = useState(props.initial.settings.provider ?? "");
  const [defaults, setDefaults] = useState<Record<string, ProviderDefaults | undefined>>(
    props.initial.settings.providers,
  );
  const [concurrency, setConcurrency] = useState(props.initial.settings.concurrency);
  const [history, setHistory] = useState(props.initial.settings.history);
  const [historyMessage, setHistoryMessage] = useState<{ ok: boolean; text: string }>();
  const used = providers.filter((p) => {
    const h = history[p.name];
    return h !== undefined && (h.models.length > 0 || h.efforts.length > 0);
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const edit = (name: string, key: keyof ProviderDefaults, value: string) => {
    setMessage(undefined);
    setDefaults((d) => ({ ...d, [name]: { ...d[name], [key]: value } }));
  };
  const counts = Array.from({ length: maxConcurrency }, (_, i) => i + 1);

  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api
          .saveSettings({
            ...(provider === "" ? {} : { provider }),
            providers: defaults,
            concurrency,
          })
          .then(
            (r) => {
              setBusy(false);
              setDefaults(r.settings.providers);
              setMessage({ ok: true, text: "保存しました。" });
            },
            (err: unknown) => {
              setBusy(false);
              setMessage({ ok: false, text: errorText(err) });
            },
          );
      }}
    >
      <h2 className="section-title">翻訳フォームの初期値</h2>
      <p className="form-note">
        翻訳を始めるたびにフォームで指定します。ここで決めた値がフォームの初期値になります。空のままにした項目は、フォームでも空で始まります。
      </p>
      <label className="field">
        <span className="field-label">provider</span>
        <select
          className="select"
          value={provider}
          onChange={(e) => {
            setMessage(undefined);
            setProvider(e.target.value);
          }}
        >
          <option value="">未選択</option>
          {providers.map((p) => (
            <option key={p.name} value={p.name}>
              {providerLabel(p.name)}
            </option>
          ))}
        </select>
      </label>
      <table className="table settings-table">
        <thead>
          <tr>
            <th>provider</th>
            <th>model</th>
            <th>effort</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.name}>
              <td>{providerLabel(p.name)}</td>
              <td>
                <input
                  className="text-input input-mid"
                  value={defaults[p.name]?.model ?? ""}
                  placeholder="未指定"
                  onChange={(e) => edit(p.name, "model", e.target.value)}
                />
              </td>
              <td>
                {p.effort ? (
                  <input
                    className="text-input input-short"
                    value={defaults[p.name]?.effort ?? ""}
                    placeholder="未指定"
                    onChange={(e) => edit(p.name, "effort", e.target.value)}
                  />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="section-title">実行</h2>
      <label className="field">
        <span className="field-label">同時に走らせる翻訳の本数</span>
        <select
          className="select"
          value={concurrency}
          onChange={(e) => {
            setMessage(undefined);
            setConcurrency(Number(e.target.value));
          }}
        >
          {counts.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 本ずつ" : `${String(n)} 本まで並行`}
            </option>
          ))}
        </select>
      </label>

      <div className="form-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "保存しています…" : "保存"}
        </button>
        {message !== undefined && <span className={message.ok ? "" : "error"}>{message.text}</span>}
      </div>

      <h2 className="section-title">model・effort の候補</h2>
      <p className="form-note">翻訳を始めたときの model・effort を provider ごとに新しい順に 10 件まで覚え、翻訳フォームの候補に出します。</p>
      {used.length === 0 ? (
        <p className="empty">候補はありません。</p>
      ) : (
        <table className="table settings-table">
          <thead>
            <tr>
              <th>provider</th>
              <th>model</th>
              <th>effort</th>
            </tr>
          </thead>
          <tbody>
            {used.map((p) => (
              <tr key={p.name}>
                <td>{providerLabel(p.name)}</td>
                <td>{history[p.name]?.models.join(", ") || <span className="muted">—</span>}</td>
                <td>{history[p.name]?.efforts.join(", ") || <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-actions">
        <button
          className="secondary"
          type="button"
          disabled={busy || used.length === 0}
          onClick={() => {
            setBusy(true);
            setHistoryMessage(undefined);
            api.clearHistory().then(
              (r) => {
                setBusy(false);
                setHistory(r.settings.history);
                setHistoryMessage({ ok: true, text: "候補を消しました。" });
              },
              (err: unknown) => {
                setBusy(false);
                setHistoryMessage({ ok: false, text: errorText(err) });
              },
            );
          }}
        >
          候補を消す
        </button>
        {historyMessage !== undefined && (
          <span className={historyMessage.ok ? "" : "error"}>{historyMessage.text}</span>
        )}
      </div>
    </form>
  );
}
