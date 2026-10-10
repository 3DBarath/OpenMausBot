import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { AdoptConversations } from "./AdoptConversations";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ImportOverview } from "../../shared/context-import";
import type { SharedNoteDoc, SharedNoteInfo } from "../../shared/shared-notes";

const QUIET = "rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

export interface ImportedNotesActions {
  open(name: string): void;
  close(): void;
  edit(text: string): void;
  save(): void;
  remove(name: string): void;
  askDeleteImported(): void;
}

/** The list alone: no state of its own, so it renders in a test. `open` is
 * the note being edited, with the text as typed. */
export function ImportedNotesPanel({ notes, open, canDeleteImported, busy, error, actions }: {
  notes: readonly SharedNoteInfo[];
  open: { name: string; text: string } | null;
  canDeleteImported: boolean;
  busy: boolean;
  error: boolean;
  actions: ImportedNotesActions;
}) {
  if (!notes.length && !canDeleteImported) return null;
  return (
    <div className="mt-1 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="text-[13px] font-medium text-ink">{t("settings.profile.imported.title")}</div>
      <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.profile.imported.hint")}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {notes.map((note) => (
          <li key={note.name} className="text-[13px] text-ink">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                {note.title}{" "}
                <span className="text-[12px] text-ink-secondary">{t("settings.profile.imported.count", { entries: note.entries, imported: note.imported })}</span>
              </span>
              <button type="button" disabled={busy} className={QUIET} onClick={() => (open?.name === note.name ? actions.close() : actions.open(note.name))}>
                {open?.name === note.name ? t("common.close") : t("settings.profile.imported.open")}
              </button>
              <button type="button" disabled={busy} className={QUIET} aria-label={t("settings.profile.imported.deleteAria", { title: note.title })} onClick={() => actions.remove(note.name)}>
                {t("common.delete")}
              </button>
            </div>
            {open?.name === note.name && (
              <div className="mt-2 flex flex-col gap-2">
                <textarea value={open.text} rows={8} disabled={busy} aria-label={t("settings.profile.imported.editAria", { title: note.title })}
                  onChange={(event) => actions.edit(event.target.value)}
                  className="min-h-[140px] w-full resize-y rounded-lg border border-hairline/40 bg-panel px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none" />
                <div className="flex justify-end">
                  <button type="button" disabled={busy} onClick={actions.save} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50">{t("common.save")}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {/* notes are only recalled where the lines are known to be the owner's: this is how older conversations get there */}
      {notes.length > 0 && <AdoptConversations />}
      {canDeleteImported && (
        <button type="button" disabled={busy} onClick={actions.askDeleteImported} className="mt-3 rounded-md px-2 py-1 text-[12.5px] text-danger hover:bg-control disabled:opacity-50">
          {t("settings.profile.imported.deleteAll")}
        </button>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{t("settings.profile.imported.error")}</div>}
    </div>
  );
}

/** Shared notes in Settings: open, edit and delete each subject, and take
 * back everything an import wrote, here and in About me. `refresh` changes
 * when an import has just saved. */
export function ImportedNotes({ refresh, onAboutMeChanged }: { refresh: number; onAboutMeChanged: (aboutMe: string) => void }) {
  const [notes, setNotes] = useState<SharedNoteInfo[]>([]);
  const [imports, setImports] = useState(0);
  const [open, setOpen] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ notes: SharedNoteInfo[] }>("/api/shared-notes").then((answer) => { if (alive) setNotes(answer.notes); }).catch(() => undefined);
    api<ImportOverview>("/api/context-import").then((answer) => { if (alive) setImports(answer.imports.length); }).catch(() => undefined);
    return () => { alive = false; };
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await work();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const path = (name: string) => `/api/shared-notes/${encodeURIComponent(name)}`;

  const actions: ImportedNotesActions = {
    open: (name) => void run(async () => {
      const note = await api<SharedNoteDoc>(path(name));
      setOpen({ name, text: note.text });
    }),
    close: () => setOpen(null),
    edit: (text) => setOpen((current) => (current ? { ...current, text } : current)),
    save: () => void run(async () => {
      if (!open) return;
      const saved = await api<SharedNoteDoc>(path(open.name), { method: "PUT", body: JSON.stringify({ text: open.text }) });
      const { text: _text, ...info } = saved;
      setNotes((current) => current.map((note) => (note.name === info.name ? info : note)));
      setOpen(null);
    }),
    remove: (name) => void run(async () => {
      const answer = await api<{ notes: SharedNoteInfo[] }>(path(name), { method: "DELETE" });
      setNotes(answer.notes);
      if (open?.name === name) setOpen(null);
    }),
    askDeleteImported: () => setConfirming(true),
  };

  const deleteImported = () => void run(async () => {
    const answer = await api<{ notes: SharedNoteInfo[]; aboutMeText: string }>("/api/shared-notes?imported=1", { method: "DELETE" });
    setNotes(answer.notes);
    setImports(0);
    setOpen(null);
    setConfirming(false);
    onAboutMeChanged(answer.aboutMeText);
  });

  return <>
    <ImportedNotesPanel notes={notes} open={open} busy={busy} error={error} actions={actions}
      canDeleteImported={imports > 0 || notes.some((note) => note.imported > 0)} />
    <ConfirmDialog open={confirming} title={t("settings.profile.imported.deleteAllTitle")} body={t("settings.profile.imported.deleteAllBody")}
      confirmLabel={t("settings.profile.imported.deleteAll")} pending={busy} onCancel={() => setConfirming(false)} onConfirm={deleteImported} />
  </>;
}
