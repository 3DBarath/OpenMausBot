// What the import dialog works out from a job (shared/context-import.ts):
// which step to show, whether to keep asking how the job is doing, how the
// proposed facts are grouped for review, and how dates and estimates read.
// Pure, so it is tested without a browser.
import type { ImportCandidate, ImportEstimate, ImportJobView } from "../../shared/context-import";

export type ImportStep = "source" | "provide" | "waiting" | "scan" | "progress" | "review" | "failed";

export function importStep(job: ImportJobView | null): ImportStep {
  if (!job) return "source";
  switch (job.status) {
    case "created": return "provide";
    case "uploading":
    case "scanning": return "waiting";
    case "scanned": return "scan";
    case "review": return "review";
    case "failed": return "failed";
    default: return "progress";
  }
}

/** The server is working on the job without the person: ask again soon. */
export function importIsBusy(job: ImportJobView | null): boolean {
  return job !== null && ["uploading", "scanning", "preparing", "extracting", "consolidating"].includes(job.status);
}

export interface ReviewGroup {
  /** "core", or the subject in lower case. */
  key: string;
  title: string;
  core: boolean;
  facts: ImportCandidate[];
  /** Facts with a sensitive category: listed under their own heading, unticked to begin with. */
  sensitive: ImportCandidate[];
}

/** Core first, then every subject by name. A subject is one group however it is capitalised. */
export function reviewGroups(candidates: readonly ImportCandidate[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  const group = (key: string, title: string, core: boolean) => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: ReviewGroup = { key, title, core, facts: [], sensitive: [] };
    groups.set(key, created);
    return created;
  };
  for (const candidate of candidates) {
    const target = candidate.kind === "core" ? group("core", "", true) : group(`subject:${candidate.subject.toLowerCase()}`, candidate.subject, false);
    (candidate.sensitive ? target.sensitive : target.facts).push(candidate);
  }
  return [...groups.values()].sort((a, b) => Number(b.core) - Number(a.core) || a.title.localeCompare(b.title));
}

/** How many ticked facts go where. */
export function keptCounts(candidates: readonly ImportCandidate[]): { core: number; subjects: number } {
  const kept = candidates.filter((candidate) => candidate.keep);
  const core = kept.filter((candidate) => candidate.kind === "core").length;
  return { core, subjects: kept.length - core };
}

/** An estimate's time as whole minutes, never "0 to 0". */
export function estimateMinutes(estimate: Pick<ImportEstimate, "minSeconds" | "maxSeconds">): { min: number; max: number } {
  const min = Math.max(1, Math.round(estimate.minSeconds / 60));
  return { min, max: Math.max(min, Math.ceil(estimate.maxSeconds / 60)) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A time as a date input shows it, in the person's own zone. */
export function dayInputValue(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A date input's day as a time: its first moment, or its last when it ends a range. */
export function dayInputTime(value: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = end ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999) : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

export function megabytes(bytes: number): string {
  return (bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0);
}
