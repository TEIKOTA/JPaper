// 契約付録 §9（Web アプリ）。API の型と呼び出し。

export type PdfKind = "ja" | "bilingual";

export interface PaperSummary {
  id: string;
  titleJa?: string;
  titleEn?: string;
  termCount: number;
  pdf: Record<PdfKind, boolean>;
}

export type DbStatus = "confirmed" | "confirmed-other" | "none";

export interface TermRow {
  src: string;
  form: string;
  ja: string;
  class: string;
  rendering: string;
  note?: string;
  count: number;
  editable: boolean;
  db: DbStatus;
}

export interface BackupInfo {
  src: string;
  oldForm: string;
  newForm: string;
  registerGlobal: boolean;
  createdAt: string;
}

export interface PaperDetail {
  id: string;
  titleJa?: string;
  titleEn?: string;
  pdf: Record<PdfKind, boolean>;
  terms: TermRow[];
  backup: BackupInfo | null;
}

export type PieceMark = "old" | "new" | "shield" | "src";

export interface Piece {
  text: string;
  mark?: PieceMark;
}

export interface PreviewItem {
  where: string;
  label: string;
  source?: Piece[];
  before: Piece[];
  after: Piece[];
  prev?: string;
  next?: string;
  replaced: number;
  shieldedBy: string[];
}

export interface Preview {
  src: string;
  rendering: string;
  oldForm: string;
  newForm: string;
  oldJa: string;
  newJa: string;
  shields: { src: string; ja: string }[];
  sameJa: string[];
  replaced: number;
  shielded: number;
  items: PreviewItem[];
  contextItems: PreviewItem[];
  migrated: boolean;
}

export interface AffectedPaper {
  id: string;
  titleJa?: string;
  currentJa: string;
}

export interface ApplyResult {
  replaced: number;
  shielded: number;
  oldForm: string;
  newForm: string;
  registered: boolean;
  bilingualStatus: string;
  pdf: Record<PdfKind, boolean>;
  notices: string[];
  affected: AffectedPaper[];
}

export interface GlobalTerm {
  src: string;
  ja: string | null;
  class: string;
  rendering: string;
  status: "confirmed" | "proposed";
  source: string | null;
  affected: AffectedPaper[];
}

export interface ProviderInfo {
  name: string;
  effort: boolean;
}

export interface ProviderDefaults {
  model?: string;
  effort?: string;
}

export interface WebSettings {
  provider?: string;
  providers: Record<string, ProviderDefaults | undefined>;
  concurrency: number;
}

export interface SettingsResponse {
  settings: WebSettings;
  providers: ProviderInfo[];
  maxConcurrency: number;
}

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";
export type JobPhase = "ingest" | "context" | "translate" | "typeset";

export interface TranslateOptions {
  provider: string;
  model?: string;
  effort?: string;
}

export interface Job {
  id: string;
  arxivId: string;
  paperId: string;
  title?: string;
  options: TranslateOptions;
  state: JobState;
  phase?: JobPhase;
  section?: { done: number; total: number };
  costUsd: number | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  log: string[];
}

export interface ArxivEntry {
  id: string;
  version?: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  paperId: string;
  local: { pdf: boolean } | null;
  job: JobState | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `エラーが発生しました（${String(res.status)}）`, res.status);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const paper = (id: string) => `/api/papers/${encodeURIComponent(id)}`;

export const api = {
  papers: () => call<{ papers: PaperSummary[] }>("/api/papers").then((r) => r.papers),
  paper: (id: string) => call<PaperDetail>(paper(id)),
  preview: (id: string, src: string, ja: string, signal?: AbortSignal) =>
    call<Preview>(`${paper(id)}/preview`, { ...post({ src, ja }), signal }),
  apply: (id: string, src: string, ja: string, registerGlobal: boolean) =>
    call<ApplyResult>(`${paper(id)}/apply`, post({ src, ja, registerGlobal })),
  undo: (id: string) => call<{ undone: BackupInfo }>(`${paper(id)}/undo`, post({})),
  glossary: () => call<{ terms: GlobalTerm[] }>("/api/glossary").then((r) => r.terms),
  pdfUrl: (id: string, kind: PdfKind) => `${paper(id)}/pdf/${kind}`,
  settings: () => call<SettingsResponse>("/api/settings"),
  saveSettings: (settings: WebSettings) => call<{ settings: WebSettings }>("/api/settings", post(settings)),
  arxiv: (q: string, signal?: AbortSignal) =>
    call<{ total?: number; entries: ArxivEntry[] }>(`/api/arxiv?q=${encodeURIComponent(q)}`, { signal }),
  jobs: () => call<{ jobs: Job[] }>("/api/jobs").then((r) => r.jobs),
  startJob: (body: { arxivId: string; title?: string } & TranslateOptions) => call<{ job: Job }>("/api/jobs", post(body)),
  cancelJob: (id: string) => call<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, post({})),
};

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "待機中",
  running: "実行中",
  done: "完了",
  failed: "失敗",
  canceled: "取り消し",
};

export const JOB_PHASE_LABEL: Record<JobPhase, string> = {
  ingest: "取り込み",
  context: "文脈",
  translate: "翻訳",
  typeset: "組版",
};

// 画面に出す provider の名前。API・CLI の値は変えない。契約付録 §9
const PROVIDER_LABEL: Record<string, string> = {
  codex: "GPT",
};

export function providerLabel(name: string): string {
  return Object.hasOwn(PROVIDER_LABEL, name) ? PROVIDER_LABEL[name]! : name;
}

export const RENDERING_LABEL: Record<string, string> = {
  bilingual: "初出のみ併記",
  translate: "訳す",
  "keep-original": "原語のまま",
};

export const DB_LABEL: Record<DbStatus, string> = {
  confirmed: "承認済み",
  "confirmed-other": "別の訳で承認済み",
  none: "未登録",
};
