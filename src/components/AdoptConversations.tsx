import { useState } from "react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { AdoptionResult, AdoptionSkipReason } from "../../shared/shared-notes";

const REASONS: ReadonlyArray<{ reason: AdoptionSkipReason; label: `sharedNotes.adopt.skipped.${AdoptionSkipReason}` }> = [
  { reason: "room", label: "sharedNotes.adopt.skipped.room" },
  { reason: "routine", label: "sharedNotes.adopt.skipped.routine" },
  { reason: "relayed", label: "sharedNotes.adopt.skipped.relayed" },
  { reason: "sender", label: "sharedNotes.adopt.skipped.sender" },
  { reason: "card", label: "sharedNotes.adopt.skipped.card" },
  { reason: "later", label: "sharedNotes.adopt.skipped.later" },
  { reason: "restored", label: "sharedNotes.adopt.skipped.restored" },
  { reason: "lost", label: "sharedNotes.adopt.skipped.lost" },
];

/** The button, the sentence that says what pressing it claims, and what the
 * last run did. No state of its own, so it renders in a test. */
export function AdoptConversationsPanel({ busy, result, error, onAdopt }: {
  busy: boolean;
  result: AdoptionResult | null;
  error: boolean;
  onAdopt: () => void;
}) {
  const left = result ? REASONS.reduce((total, { reason }) => total + result.skipped[reason], 0) : 0;
  return (
    <div className="mt-3 flex flex-col items-start gap-1.5">
      <button type="button" disabled={busy} onClick={onAdopt} className="ui-button">{t("sharedNotes.adopt.button")}</button>
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("sharedNotes.adopt.hint")}</p>
      {result && <div role="status" className="text-[12.5px] leading-relaxed text-ink">
        <p>{t("sharedNotes.adopt.done", { adopted: result.adopted, already: result.already })}</p>
        {left > 0 && <>
          <p className="mt-1">{t("sharedNotes.adopt.left", { count: left })}</p>
          <ul className="mt-0.5 flex flex-col gap-0.5 text-ink-secondary">
            {REASONS.filter(({ reason }) => result.skipped[reason] > 0).map(({ reason, label }) => <li key={reason}>{t(label, { count: result.skipped[reason] })}</li>)}
          </ul>
        </>}
      </div>}
      {error && <p role="alert" className="text-[12px] text-danger">{t("sharedNotes.adopt.error")}</p>}
    </div>
  );
}

/** "Use my notes in my existing conversations". A conversation from before
 * this version recalls no shared note, because nothing recorded whose lines
 * they were. Pressing this is the owner saying they wrote them: the server
 * adopts every conversation it can and says how many it left and why
 * (server/shared-notes-adopt.ts). It can be pressed again later; what was
 * adopted stays adopted, and nothing is ever adopted without this click. */
export function AdoptConversations() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdoptionResult | null>(null);
  const [error, setError] = useState(false);
  const adopt = () => {
    setBusy(true);
    setError(false);
    api<AdoptionResult & { ok: boolean }>("/api/shared-notes/adopt", { method: "POST", body: "{}" })
      .then((answer) => setResult({ adopted: answer.adopted, already: answer.already, empty: answer.empty, skipped: answer.skipped }))
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };
  return <AdoptConversationsPanel busy={busy} result={result} error={error} onAdopt={adopt} />;
}
