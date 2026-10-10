import { t } from "@/lib/i18n";
import { reviewGroups, type ReviewGroup } from "@/lib/context-import";
import { CORE_MAX, type CandidateChange, type ImportCandidate } from "../../shared/context-import";

const FIELD = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";
const QUIET = "rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

/** Step 5 of an import: every proposed fact, grouped by where it would go.
 * Nothing here saves anything: a change is sent to the job, which keeps the
 * review across a restart. No state of its own. */
export function ContextImportReview({ candidates, busy, onChange, onRenameSubject }: {
  candidates: readonly ImportCandidate[];
  busy: boolean;
  onChange: (change: CandidateChange) => void;
  onRenameSubject: (from: string, to: string) => void;
}) {
  const groups = reviewGroups(candidates);
  if (!groups.length) return <p className="text-[13px] leading-relaxed text-ink-secondary">{t("contextImport.review.empty")}</p>;
  const coreFull = candidates.filter((candidate) => candidate.kind === "core").length >= CORE_MAX;

  const fact = (candidate: ImportCandidate) => (
    <li key={candidate.id} className="flex items-start gap-2">
      <input type="checkbox" checked={candidate.keep} disabled={busy} aria-label={t("contextImport.review.keepAria")}
        onChange={(event) => onChange({ id: candidate.id, keep: event.target.checked })} className="mt-2 accent-accent" />
      <div className="min-w-0 flex-1">
        {/* keyed by the text so a saved edit, or one the server cleaned, shows as the server holds it */}
        <input key={candidate.text} defaultValue={candidate.text} maxLength={300} disabled={busy} aria-label={t("contextImport.review.textAria")}
          onBlur={(event) => { if (event.target.value.trim() && event.target.value !== candidate.text) onChange({ id: candidate.id, text: event.target.value }); }}
          className={FIELD} />
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-secondary">
          <span>{candidate.chatTitle ? t("contextImport.review.from", { title: candidate.chatTitle, date: candidate.date }) : candidate.date}</span>
          {candidate.until && <span>{t("contextImport.review.until", { date: candidate.until })}</span>}
          {candidate.sensitive && <span className="rounded-full bg-control px-2 py-0.5">{t(`contextImport.review.category.${candidate.sensitive}`)}</span>}
          {candidate.replacedBy && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-ink">{t("contextImport.review.replaced")}</span>}
          {candidate.kind === "core"
            ? <button type="button" disabled={busy} className={QUIET} onClick={() => onChange({ id: candidate.id, kind: "subject" })}>{t("contextImport.review.moveToSubject", { subject: candidate.subject })}</button>
            : <button type="button" disabled={busy || coreFull} className={QUIET} onClick={() => onChange({ id: candidate.id, kind: "core" })}>{t("contextImport.review.moveToCore")}</button>}
        </div>
      </div>
    </li>
  );

  const section = (group: ReviewGroup) => (
    <section key={group.key} className="rounded-xl border border-hairline/40 p-3">
      {group.core
        ? <h3 className="text-[14px] font-semibold text-ink">{t("contextImport.review.core")}</h3>
        : <input key={group.title} defaultValue={group.title} maxLength={40} disabled={busy} aria-label={t("contextImport.review.subjectAria")}
            onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== group.title) onRenameSubject(group.title, event.target.value); }}
            className={`${FIELD} max-w-[260px] font-semibold`} />}
      <p className="mt-1 text-[12px] text-ink-secondary">{group.core ? t("contextImport.review.coreHint", { max: CORE_MAX }) : t("contextImport.review.subjectHint")}</p>
      {group.facts.length > 0 && <ul className="mt-2 flex flex-col gap-2.5">{group.facts.map(fact)}</ul>}
      {group.sensitive.length > 0 && <>
        <h4 className="mt-3 text-[12.5px] font-medium text-ink">{t("contextImport.review.sensitive")}</h4>
        <p className="mt-0.5 text-[12px] text-ink-secondary">{t("contextImport.review.sensitiveHint")}</p>
        <ul className="mt-2 flex flex-col gap-2.5">{group.sensitive.map(fact)}</ul>
      </>}
    </section>
  );

  return <div className="flex flex-col gap-3">{groups.map(section)}</div>;
}
