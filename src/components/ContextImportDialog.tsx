import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { dayInputTime, dayInputValue, estimateMinutes, importIsBusy, importStep, keptCounts, megabytes } from "@/lib/context-import";
import { AdoptConversations } from "./AdoptConversations";
import { ContextImportReview } from "./ContextImportReview";
import {
  IMPORT_EXPIRES_DAYS, PASTE_MAX_CHARS, UPLOAD_MINUTES,
  type CandidateChange, type CandidatePatch, type ImportEngineChoice, type ImportJobView, type ImportOrigin, type ImportOverview, type ImportSaveResult,
} from "../../shared/context-import";

const PRIMARY = "rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50";
const QUIET = "rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50";
const FIELD = "rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:outline-none disabled:opacity-50";
const POLL_MS = 1_000;

/** What the person has typed or picked that the job does not hold yet. */
export interface ContextImportDraft {
  origin: ImportOrigin;
  fileName: string | null;
  text: string;
  /** Date inputs and the cap field, as typed. Empty means the job's own range. */
  from: string;
  to: string;
  cap: string;
  botId: string;
  busy: boolean;
  error: string;
  copied: boolean;
  /** Set once saved: the dialog's last page. */
  result: ImportSaveResult | null;
}

export interface ContextImportActions {
  pickOrigin(origin: ImportOrigin): void;
  begin(): void;
  chooseFile(file: File | null): void;
  upload(): void;
  setText(text: string): void;
  submitText(): void;
  copyPrompt(): void;
  setRange(range: Partial<Pick<ContextImportDraft, "from" | "to" | "cap">>): void;
  setBot(botId: string): void;
  extract(): void;
  pause(): void;
  resume(): void;
  /** Carry on without the parts the engine failed. */
  resumeSkipping(): void;
  cancel(): void;
  change(change: CandidateChange): void;
  changeMany(changes: CandidateChange[]): void;
  /** Untick whatever of the ticked facts does not fit, keeping the newest. */
  keepWhatFits(): void;
  renameSubject(from: string, to: string): void;
  save(): void;
  close(): void;
}

const SOURCES: ReadonlyArray<{ origin: ImportOrigin; label: "contextImport.source.chatgpt" | "contextImport.source.claude" | "contextImport.source.paste"; hint: "contextImport.source.chatgptHint" | "contextImport.source.claudeHint" | "contextImport.source.pasteHint" }> = [
  { origin: "chatgpt", label: "contextImport.source.chatgpt", hint: "contextImport.source.chatgptHint" },
  { origin: "claude", label: "contextImport.source.claude", hint: "contextImport.source.claudeHint" },
  { origin: "paste", label: "contextImport.source.paste", hint: "contextImport.source.pasteHint" },
];

/** The dialog's content for one job and one draft: no state of its own, so
 * every step renders in a test. */
export function ContextImportPanel({ job, engines, draft, actions }: {
  job: ImportJobView | null;
  engines: readonly ImportEngineChoice[];
  draft: ContextImportDraft;
  actions: ContextImportActions;
}) {
  const heading = (title: string, hint?: string) => <>
    <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
    {hint && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{hint}</p>}
  </>;
  const error = draft.error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{draft.error}</p>;
  const cancel = <button type="button" className={QUIET} disabled={draft.busy} title={t("contextImport.cancelHint")} onClick={actions.cancel}>{t("contextImport.cancel")}</button>;
  const number = (value: number) => value.toLocaleString("en-US");
  /** What the import's own screen left out of the proposed facts, when it left anything out. */
  const dropped = (progress: ImportJobView["progress"]) => progress && progress.droppedSecrets + progress.droppedInstructions > 0
    && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.progress.dropped", { secrets: number(progress.droppedSecrets), instructions: number(progress.droppedInstructions) })}</p>;
  const expires = <p className="mt-3 text-[12px] text-ink-secondary">{t("contextImport.expires", { days: IMPORT_EXPIRES_DAYS })}</p>;

  if (draft.result) {
    const result = draft.result;
    return <div>
      {heading(t("contextImport.done.title"), t("contextImport.done.saved", { aboutMe: result.aboutMe, entries: result.entries }))}
      <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-ink-secondary">
        {result.overflowed > 0 && <li>{t("contextImport.done.overflowed", { count: result.overflowed })}</li>}
        {result.full.map((full) => <li key={full.subject}>{t("contextImport.done.full", { subject: full.subject, count: full.dropped })}</li>)}
        {result.duplicates > 0 && <li>{t("contextImport.done.duplicates", { count: result.duplicates })}</li>}
        {result.notDeleted
          ? <li role="alert" className="text-danger">{t("contextImport.done.notDeleted", { path: result.notDeleted })}</li>
          : <li>{t("contextImport.done.deleted")}</li>}
      </ul>
      <AdoptConversations />
      <div className="mt-5 flex justify-end"><button type="button" className={PRIMARY} onClick={actions.close}>{t("contextImport.done.done")}</button></div>
    </div>;
  }

  const step = importStep(job);
  if (step === "source") {
    return <div>
      {heading(t("contextImport.source.title"))}
      <div role="radiogroup" aria-label={t("contextImport.source.title")} className="mt-3 flex flex-col gap-2">
        {SOURCES.map((source) => {
          const selected = draft.origin === source.origin;
          return <button key={source.origin} type="button" role="radio" aria-checked={selected} onClick={() => actions.pickOrigin(source.origin)}
            className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left ${selected ? "border-accent/70 bg-accent/10" : "border-hairline/50 hover:bg-raised"}`}>
            <span aria-hidden="true" className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${selected ? "border-accent bg-accent" : "border-hairline"}`} />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium text-ink">{t(source.label)}</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-secondary">{t(source.hint)}</span>
            </span>
          </button>;
        })}
      </div>
      {error}
      <div className="mt-5 flex justify-end"><button type="button" className={PRIMARY} disabled={draft.busy} onClick={actions.begin}>{t("contextImport.source.continue")}</button></div>
    </div>;
  }

  if (step === "provide" && job!.origin === "paste") {
    return <div>
      {heading(t("contextImport.paste.title"), t("contextImport.paste.hint"))}
      <blockquote className="mt-2 rounded-lg border border-hairline/40 bg-inset p-3 text-[12.5px] leading-relaxed text-ink">{t("contextImport.paste.prompt")}</blockquote>
      <button type="button" className={`${QUIET} mt-1`} onClick={actions.copyPrompt}>{draft.copied ? t("contextImport.paste.copied") : t("contextImport.paste.copy")}</button>
      <textarea value={draft.text} rows={8} maxLength={PASTE_MAX_CHARS} aria-label={t("contextImport.paste.aria")} disabled={draft.busy}
        onChange={(event) => actions.setText(event.target.value)} className={`${FIELD} mt-3 min-h-[160px] w-full resize-y`} />
      <p className="mt-1 text-[12px] text-ink-secondary">{t("contextImport.paste.count", { count: number(draft.text.length) })}</p>
      {error}
      <div className="mt-5 flex justify-between gap-2">{cancel}<button type="button" className={PRIMARY} disabled={draft.busy || !draft.text.trim()} onClick={actions.submitText}>{t("contextImport.paste.continue")}</button></div>
    </div>;
  }

  if (step === "provide") {
    return <div>
      {heading(t("contextImport.file.title"), t("contextImport.file.hint"))}
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.file.limit")}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.file.time", { minutes: UPLOAD_MINUTES })}</p>
      <input type="file" accept=".zip,.json,application/zip,application/json" aria-label={t("contextImport.file.aria")} disabled={draft.busy}
        onChange={(event) => actions.chooseFile(event.target.files?.[0] ?? null)} className="mt-3 block w-full text-[13px] text-ink" />
      {error}
      <div className="mt-5 flex justify-between gap-2">{cancel}<button type="button" className={PRIMARY} disabled={draft.busy || !draft.fileName} onClick={actions.upload}>{t("contextImport.file.upload")}</button></div>
    </div>;
  }

  if (step === "waiting") {
    return <div>
      {heading(t("contextImport.file.title"))}
      <p role="status" className="mt-3 text-[13px] text-ink-secondary">
        {job!.status === "uploading" ? t("contextImport.file.uploading", { done: megabytes(job!.uploadedBytes ?? 0) }) : t("contextImport.file.scanning")}
      </p>
      <progress className="mt-3 w-full accent-accent" aria-label={t("contextImport.progress.aria")} />
      <div className="mt-5 flex justify-start">{cancel}</div>
    </div>;
  }

  if (step === "scan") {
    const scan = job!.scan!;
    const estimate = job!.estimate;
    const minutes = estimate ? estimateMinutes(estimate) : null;
    const paste = job!.origin === "paste";
    const nothing = !estimate || estimate.conversations === 0;
    return <div>
      {heading(t("contextImport.scan.title"))}
      <ul className="mt-2 flex flex-col gap-1 text-[12.5px] leading-relaxed text-ink-secondary">
        {paste
          ? <li>{t("contextImport.scan.pasteFound", { chars: number(scan.ownChars) })}</li>
          : <li>{t("contextImport.scan.found", { conversations: number(scan.conversations), withOwn: number(scan.withOwnMessages), chars: number(scan.ownChars) })}</li>}
        {!paste && scan.oldest !== null && scan.newest !== null && <li>{t("contextImport.scan.range", { oldest: dayInputValue(scan.oldest), newest: dayInputValue(scan.newest) })}</li>}
        {scan.alreadyRead > 0 && <li>{t("contextImport.scan.alreadyRead", { count: number(scan.alreadyRead) })}</li>}
        {scan.skipped.conversations + scan.skipped.oversized > 0 && <li>{t("contextImport.scan.skipped", { count: number(scan.skipped.conversations + scan.skipped.oversized) })}</li>}
        {scan.skipped.entries.map((entry) => <li key={entry}>{t("contextImport.scan.refused", { entry })}</li>)}
        {scan.skipped.secrets > 0 && <li>{t("contextImport.scan.secretsCut", { count: number(scan.skipped.secrets) })}</li>}
        {scan.skipped.overLimit > 0 && <li>{t("contextImport.scan.overLimit", { count: number(scan.skipped.overLimit) })}</li>}
        {scan.truncated && <li>{t("contextImport.scan.truncated")}</li>}
      </ul>
      {!paste && <>
        <h4 className="mt-4 text-[13px] font-medium text-ink">{t("contextImport.scan.readTitle")}</h4>
        <div className="mt-2 flex flex-wrap items-end gap-3 text-[12.5px] text-ink-secondary">
          <label className="flex flex-col gap-1">{t("contextImport.scan.from")}
            <input type="date" value={draft.from || (job!.slice ? dayInputValue(job!.slice.from) : "")} disabled={draft.busy} onChange={(event) => actions.setRange({ from: event.target.value })} className={FIELD} /></label>
          <label className="flex flex-col gap-1">{t("contextImport.scan.to")}
            <input type="date" value={draft.to || (job!.slice ? dayInputValue(job!.slice.to) : "")} disabled={draft.busy} onChange={(event) => actions.setRange({ to: event.target.value })} className={FIELD} /></label>
          <label className="flex flex-col gap-1">{t("contextImport.scan.cap")}
            <span className="flex items-center gap-2"><input type="number" min={1} max={2000} value={draft.cap || String(job!.slice?.cap ?? "")} disabled={draft.busy} onChange={(event) => actions.setRange({ cap: event.target.value })} className={`${FIELD} w-24`} />{t("contextImport.scan.capUnit")}</span></label>
        </div>
      </>}
      <p role="status" className="mt-3 text-[13px] text-ink">
        {nothing ? t("contextImport.scan.nothing") : t("contextImport.scan.estimate", { conversations: number(estimate.conversations), calls: number(estimate.calls), min: minutes!.min, max: minutes!.max })}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
        {!nothing && <>{t("contextImport.scan.estimateMax", { max: number(estimate.maxCalls ?? estimate.calls) })} </>}{t("contextImport.scan.estimateNote")} {t("contextImport.scan.sent")}
      </p>
      <label className="mt-4 flex flex-col gap-1 text-[12.5px] text-ink-secondary">{t("contextImport.engine.label")}
        <select value={draft.botId} disabled={draft.busy} onChange={(event) => actions.setBot(event.target.value)} className={FIELD}>
          <option value="">{t("contextImport.engine.choose")}</option>
          {engines.map((engine) => <option key={engine.botId} value={engine.botId} disabled={!engine.available}>
            {engine.available ? engine.name : t("contextImport.engine.unavailable", { name: engine.name })}
          </option>)}
        </select>
        <span className="text-[12px]">{t("contextImport.engine.hint")}</span>
      </label>
      {expires}
      {error}
      <div className="mt-5 flex justify-between gap-2">{cancel}
        <button type="button" className={PRIMARY} disabled={draft.busy || nothing || !draft.botId} onClick={actions.extract}>
          {t("contextImport.scan.start")}
        </button>
      </div>
    </div>;
  }

  if (step === "progress") {
    const progress = job!.progress;
    const paused = job!.status === "paused";
    return <div>
      {heading(t("contextImport.progress.title"))}
      <p role="status" className="mt-3 text-[13px] text-ink">
        {job!.status === "consolidating" ? t("contextImport.progress.consolidating")
          : progress ? t("contextImport.progress.batches", { done: progress.done, total: progress.batches, found: number(progress.candidates) })
          : t("contextImport.progress.preparing")}
      </p>
      <progress className="mt-3 w-full accent-accent" aria-label={t("contextImport.progress.aria")} {...(progress ? { max: progress.batches, value: progress.done } : {})} />
      {progress && progress.skipped > 0 && <p className="mt-2 text-[12.5px] text-ink-secondary">{t("contextImport.progress.skipped", { count: progress.skipped })}</p>}
      {dropped(progress)}
      {paused && <p className="mt-2 text-[12.5px] text-ink">{job!.pausedBy === "restart" ? t("contextImport.progress.pausedRestart") : t("contextImport.progress.paused")}</p>}
      {job!.note && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{job!.note}</p>}
      {paused && job!.failedBatches ? <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.progress.skipFailedHint", { count: job!.failedBatches })}</p> : null}
      {!paused && <p className="mt-2 text-[12px] text-ink-secondary">{t("contextImport.progress.background")}</p>}
      {paused && expires}
      {error}
      <div className="mt-5 flex flex-wrap justify-between gap-2">{cancel}
        {paused
          ? <span className="flex flex-wrap items-center gap-2">
              {job!.failedBatches ? <button type="button" className="ui-button" disabled={draft.busy} onClick={actions.resumeSkipping}>{t("contextImport.progress.skipFailed", { count: job!.failedBatches })}</button> : null}
              <button type="button" className={PRIMARY} disabled={draft.busy} onClick={actions.resume}>{t("contextImport.progress.resume")}</button>
            </span>
          : <button type="button" className="ui-button" disabled={draft.busy || job!.status === "preparing"} onClick={actions.pause}>{t("contextImport.progress.pause")}</button>}
      </div>
    </div>;
  }

  if (step === "failed") {
    return <div>
      {heading(t("contextImport.failed.title"), job!.error)}
      {error}
      <div className="mt-5 flex justify-end"><button type="button" className={PRIMARY} disabled={draft.busy} onClick={actions.cancel}>{t("contextImport.failed.startAgain")}</button></div>
    </div>;
  }

  const candidates = job!.candidates ?? [];
  const kept = keptCounts(candidates);
  const fit = job!.fit ?? [];
  return <div>
    {heading(t("contextImport.review.title"), t("contextImport.review.hint"))}
    {job!.note && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{job!.note}</p>}
    {job!.unreadAtLimit !== undefined && <p className="mt-2 text-[12.5px] leading-relaxed text-ink">{t("contextImport.review.atLimit", { count: number(job!.unreadAtLimit) })}</p>}
    {job!.progress && job!.progress.skipped > 0 && <p className="mt-2 text-[12.5px] text-ink-secondary">{t("contextImport.progress.skipped", { count: job!.progress.skipped })}</p>}
    {dropped(job!.progress)}
    {candidates.length > 0 && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.review.checkSecrets")}</p>}
    <div className="mt-3"><ContextImportReview candidates={candidates} busy={draft.busy} onChange={actions.change} onChangeMany={actions.changeMany} onRenameSubject={actions.renameSubject} /></div>
    {fit.length > 0 && <div role="alert" className="mt-3 rounded-lg border border-danger/40 p-3 text-[12.5px] leading-relaxed text-ink">
      <p className="font-medium">{t("contextImport.review.fitTitle")}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {fit.map((problem) => problem.kind === "files"
          ? <li key="files">{t("contextImport.review.fitFiles", { needed: number(problem.needed), room: number(problem.room) })}</li>
          : <li key={problem.subject}>{t("contextImport.review.fitBytes", { subject: problem.subject, over: number(problem.over) })}</li>)}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="ui-button" disabled={draft.busy} onClick={actions.keepWhatFits}>{t("contextImport.review.keepWhatFits")}</button>
        <span className="text-[12px] text-ink-secondary">{t("contextImport.review.keepWhatFitsHint")}</span>
      </div>
    </div>}
    {expires}
    {error}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">{cancel}
      <span className="flex items-center gap-3">
        <span className="text-[12.5px] text-ink-secondary">{t("contextImport.review.summary", { core: kept.core, subjects: kept.subjects })}</span>
        <button type="button" className={PRIMARY} disabled={draft.busy || fit.length > 0} onClick={actions.save}>{draft.busy ? t("contextImport.review.saving") : t("contextImport.review.save")}</button>
      </span>
    </div>
  </div>;
}

const EMPTY: ContextImportDraft = { origin: "chatgpt", fileName: null, text: "", from: "", to: "", cap: "", botId: "", busy: false, error: "", copied: false, result: null };

/** The import, from choosing a source to the saved facts. Closing the
 * window does not stop a job: it keeps going on the server and this dialog
 * picks it up again the next time it opens. */
export function ContextImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (result: ImportSaveResult) => void }) {
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [engines, setEngines] = useState<ImportEngineChoice[]>([]);
  const [draft, setDraft] = useState<ContextImportDraft>(EMPTY);
  const file = useRef<File | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const edit = useCallback((patch: Partial<ContextImportDraft>) => setDraft((current) => ({ ...current, ...patch })), []);
  const failed = (error: unknown) => edit({ busy: false, error: error instanceof Error && error.message ? error.message : t("contextImport.loadError") });

  // the range as the server should price it: what was typed, else the job's own
  const rangeQuery = () => {
    const query = new URLSearchParams();
    const from = dayInputTime(draft.from, false);
    const to = dayInputTime(draft.to, true);
    if (from !== null) query.set("from", String(from));
    if (to !== null) query.set("to", String(to));
    if (draft.cap.trim() && Number.isFinite(Number(draft.cap))) query.set("cap", draft.cap.trim());
    return query;
  };

  useEffect(() => {
    let alive = true;
    api<ImportOverview>("/api/context-import")
      .then((overview) => {
        if (!alive) return;
        setJob(overview.job);
        setEngines(overview.engines);
        edit({ botId: overview.job?.botId ?? overview.engines.find((engine) => engine.available)?.botId ?? "", ...(overview.job ? { origin: overview.job.origin } : {}) });
      })
      .catch((error: unknown) => { if (alive) failed(error); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the dialog opens
  }, []);

  // While the server works by itself, and while a range is being priced, ask again.
  const id = job?.id;
  const busy = importIsBusy(job);
  const scanned = job?.status === "scanned";
  const range = scanned ? rangeQuery().toString() : "";
  useEffect(() => {
    if (!id || (!busy && !scanned)) return;
    let alive = true;
    const read = () => api<{ job: ImportJobView }>(`/api/context-import/${id}${range ? `?${range}` : ""}`)
      .then((answer) => { if (alive) setJob(answer.job); })
      .catch(() => undefined);
    if (scanned) {
      const timer = setTimeout(() => void read(), 250);
      return () => { alive = false; clearTimeout(timer); };
    }
    const timer = setInterval(() => void read(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [id, busy, scanned, range]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);

  const send = async (path: string, method: string, body?: unknown): Promise<void> => {
    edit({ busy: true, error: "" });
    try {
      const answer = await api<{ job?: ImportJobView }>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (answer.job) setJob(answer.job);
      edit({ busy: false });
    } catch (error) {
      failed(error);
    }
  };
  const patch = (body: CandidatePatch) => send(`/api/context-import/${job!.id}/candidates`, "PATCH", body);

  const actions: ContextImportActions = {
    pickOrigin: (origin) => edit({ origin }),
    begin: () => void send("/api/context-import", "POST", { source: draft.origin }),
    chooseFile: (picked) => { file.current = picked; edit({ fileName: picked?.name ?? null, error: "" }); },
    upload: () => {
      if (!file.current || !job) return;
      edit({ busy: true, error: "" });
      // shown as uploading at once; the poll then reads how far it is
      setJob({ ...job, status: "uploading", uploadedBytes: 0 });
      void fetch(`/api/context-import/${job.id}/file`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file.current })
        .then(async (response) => {
          const answer = await response.json().catch(() => ({})) as { job?: ImportJobView; error?: string };
          if (!response.ok || !answer.job) throw new Error(answer.error ?? "");
          setJob(answer.job);
          edit({ busy: false });
        })
        .catch((error: unknown) => { setJob({ ...job, status: "created" }); failed(error); });
    },
    setText: (text) => edit({ text }),
    submitText: () => void send(`/api/context-import/${job!.id}/text`, "POST", { text: draft.text }),
    copyPrompt: () => { void copyText(t("contextImport.paste.prompt")).then((result) => edit(result === "copied" ? { copied: true, error: "" } : { copied: false, error: t("common.copyFailed") })); },
    setRange: (next) => edit(next),
    setBot: (botId) => edit({ botId }),
    extract: () => {
      const query = rangeQuery();
      const slice = Object.fromEntries([...query.entries()].map(([key, value]) => [key, Number(value)]));
      void send(`/api/context-import/${job!.id}/extract`, "POST", { botId: draft.botId, ...slice });
    },
    pause: () => void send(`/api/context-import/${job!.id}/pause`, "POST"),
    resume: () => void send(`/api/context-import/${job!.id}/resume`, "POST"),
    resumeSkipping: () => void send(`/api/context-import/${job!.id}/resume`, "POST", { skipFailed: true }),
    cancel: () => {
      edit({ busy: true, error: "" });
      void api(`/api/context-import/${job!.id}/cancel`, { method: "POST" })
        .then(() => { file.current = null; setJob(null); setDraft({ ...EMPTY, botId: draft.botId }); })
        .catch(failed);
    },
    change: (change) => void patch({ changes: [change] }),
    changeMany: (changes) => { if (changes.length) void patch({ changes }); },
    keepWhatFits: () => void patch({ keepWhatFits: true }),
    renameSubject: (from, to) => void patch({ renameSubject: { from, to } }),
    save: () => {
      edit({ busy: true, error: "" });
      void api<{ result: ImportSaveResult }>(`/api/context-import/${job!.id}/save`, { method: "POST" })
        .then(({ result }) => { setJob(null); edit({ busy: false, result }); onSaved(result); })
        .catch(failed);
    },
    close: onClose,
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="context-import-title" tabIndex={-1}
        className="animate-pop-in flex max-h-[min(820px,calc(100dvh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none">
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6">
          <div className="min-w-0">
            <h2 id="context-import-title" className="text-[18px] font-semibold text-ink">{t("contextImport.title")}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("contextImport.subtitle")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"><X size={19} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <ContextImportPanel job={job} engines={engines} draft={draft} actions={actions} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
