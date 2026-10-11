import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, FilePlus, LoaderCircle, MessagesSquare, Search, X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { t } from "@/lib/i18n";
import { loadConversationAttachment, recentConversations } from "@/lib/conversation-context";
import { appendDraftAttachments, changeDraftAttachmentPending } from "@/lib/drafts";
import type { ThreadRefCandidate } from "@/lib/thread-refs";

/** Fetch only after an explicit choice. A cancelled/stale request cannot
 * populate another conversation's draft or send anything to an engine. */
export function ComposerAttachmentMenu({ threads, threadId, draftId, onFiles, onClose }: {
  threads: readonly ThreadRefCandidate[];
  threadId: string;
  draftId: string;
  onFiles: () => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const close = () => { request.current?.abort(); onClose(); };
  useModalDialog(dialog, close);
  useEffect(() => () => request.current?.abort(), [draftId]);
  useEffect(() => {
    if (pending) dialog.current?.focus();
    else if (picking) search.current?.focus();
  }, [picking, pending]);
  const choose = async (source: ThreadRefCandidate) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(source.threadId);
    setError(null);
    changeDraftAttachmentPending(draftId, true);
    try {
      const attachment = await loadConversationAttachment(source, controller.signal);
      if (controller.signal.aborted) return;
      appendDraftAttachments(draftId, [attachment]);
      onClose();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("composer.conversation.failed"));
    } finally {
      changeDraftAttachmentPending(draftId, false);
      if (!controller.signal.aborted) { request.current = null; setPending(null); }
    }
  };
  const rows = recentConversations(threads, threadId, query);
  return createPortal(<div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-label={t(picking ? "composer.conversation.title" : "composer.attachMenu")}
      aria-busy={Boolean(pending)} className="flex max-h-[80dvh] w-full max-w-[440px] flex-col rounded-2xl border border-hairline/50 bg-panel p-4 text-ink shadow-2xl">
      <div className="mb-3 flex items-center gap-2">
        {picking && <button type="button" disabled={Boolean(pending)} aria-label={t("composer.conversation.back")} onClick={() => { setPicking(false); setError(null); }}
          className="rounded-lg p-1.5 text-ink-secondary hover:bg-control"><ArrowLeft size={16} /></button>}
        <h2 className="min-w-0 flex-1 text-[15px] font-semibold">{t(picking ? "composer.conversation.title" : "composer.attachMenu")}</h2>
        <button type="button" onClick={close} aria-label={t("common.close")} className="rounded-lg p-1.5 text-ink-secondary hover:bg-control"><X size={16} /></button>
      </div>
      {picking ? <>
        <p className="mb-3 text-[12px] text-ink-secondary">{t("composer.conversation.detail")}</p>
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3 py-2">
          <Search size={14} className="text-ink-secondary" />
          <input ref={search} value={query} disabled={Boolean(pending)} onChange={(event) => setQuery(event.target.value)}
            aria-label={t("composer.conversation.search")} placeholder={t("composer.conversation.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <div className="min-h-0 overflow-y-auto">
          {rows.map((source) => <button type="button" key={source.threadId} disabled={Boolean(pending)} onClick={() => void choose(source)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-control focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
            {pending === source.threadId ? <LoaderCircle size={16} className="shrink-0 animate-spin" /> : <MessagesSquare size={16} className="shrink-0 text-ink-secondary" />}
            <span className="min-w-0"><span className="block truncate text-[13px]">{source.title}</span><span className="block truncate text-[11px] text-ink-secondary">{source.botName}</span></span>
          </button>)}
          {!rows.length && <p className="p-3 text-[12px] text-ink-secondary">{t("composer.conversation.noMatches")}</p>}
        </div>
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
      </> : <div className="space-y-1">
        <button type="button" onClick={() => { onFiles(); onClose(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-[13px] hover:bg-control focus-visible:outline-2 focus-visible:outline-accent"><FilePlus size={17} />{t("composer.attach")}</button>
        <button type="button" onClick={() => setPicking(true)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-[13px] hover:bg-control focus-visible:outline-2 focus-visible:outline-accent"><MessagesSquare size={17} />{t("composer.conversation.title")}</button>
      </div>}
    </div>
  </div>, document.body);
}
