// Steps 4 and 5 of an import: settling conflicts between the proposed facts
// and what the person may change before saving. Conflicts use the
// contradiction step Memory upkeep has (server/memory-tidy.ts); the newer
// fact wins and the older one stays in the list, unticked, pointing at it.
// Core, which goes to About me, holds at most 30 facts. Pure here.
import { cleanFactText, cleanSubject, FALLBACK_SUBJECT, TEXT_MAX } from "./extract.ts";
import { holdsCodeOrLink, holdsSecret, readsAsInstruction, usableAlias } from "./screen.ts";
import type { MemoryEntryLine } from "../memory-entries.ts";
import type { Contradiction } from "../memory-tidy.ts";
import { foldedFactText } from "../shared-notes.ts";
import { CORE_MAX, IMPORT_SUBJECTS_MAX, type CandidatePatch, type ImportCandidate } from "../../shared/context-import.ts";

/** contradictionPrompt lists at most this many lines (PROMPT_ENTRIES in memory-tidy.ts). */
export const CONSOLIDATE_CHUNK = 200;

export class ReviewError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReviewError";
    this.status = status;
  }
}

/** Candidates in the groups one contradiction call reads: facts on one
 * subject side by side, oldest first, at most 200 a call. */
export function consolidationChunks(candidates: readonly ImportCandidate[]): ImportCandidate[][] {
  const sorted = [...candidates].sort((a, b) => a.subject.toLowerCase().localeCompare(b.subject.toLowerCase()) || a.date.localeCompare(b.date));
  const chunks: ImportCandidate[][] = [];
  for (let at = 0; at < sorted.length; at += CONSOLIDATE_CHUNK) chunks.push(sorted.slice(at, at + CONSOLIDATE_CHUNK));
  return chunks;
}

/** A chunk as the lines contradictionPrompt numbers: the date and the fact. */
export function contradictionEntries(chunk: readonly ImportCandidate[]): MemoryEntryLine[] {
  return chunk.map((candidate, line) => ({ line, end: line + 1, raw: "", prefix: "", body: candidate.text, date: candidate.date, until: candidate.until ?? null, struck: false }));
}

/** Mark the loser of each pair. The newer fact wins; on the same day, the
 * one the model kept. A fact takes part in one pair at most. */
export function applyContradictions(candidates: readonly ImportCandidate[], pairs: readonly Contradiction[], chunk: readonly ImportCandidate[]): ImportCandidate[] {
  const replaced = new Map<string, string>();
  const touched = new Set<string>();
  for (const pair of pairs) {
    const a = chunk[pair.a];
    const b = chunk[pair.b];
    if (!a || !b || a.id === b.id || touched.has(a.id) || touched.has(b.id)) continue;
    const winner = a.date === b.date ? (pair.keep === "a" ? a : b) : a.date > b.date ? a : b;
    const loser = winner === a ? b : a;
    replaced.set(loser.id, winner.id);
    touched.add(a.id);
    touched.add(b.id);
  }
  return candidates.map((candidate) => (replaced.has(candidate.id) ? { ...candidate, keep: false, replacedBy: replaced.get(candidate.id)! } : candidate));
}

/** Core holds at most 30 facts: the newest stay, the rest move to their subject. */
export function capCore(candidates: readonly ImportCandidate[]): ImportCandidate[] {
  const core = candidates.filter((candidate) => candidate.kind === "core");
  if (core.length <= CORE_MAX) return [...candidates];
  const stay = new Set([...core].sort((a, b) => b.date.localeCompare(a.date)).slice(0, CORE_MAX).map((candidate) => candidate.id));
  return candidates.map((candidate) => (candidate.kind === "core" && !stay.has(candidate.id) ? { ...candidate, kind: "subject" as const } : candidate));
}

function screenedSubject(raw: string): string {
  const subject = cleanSubject(raw);
  if (holdsSecret(subject) || holdsCodeOrLink(subject)) throw new ReviewError("A subject cannot hold a password, a number that identifies you, a command or a link.", 400);
  return subject;
}

/** One import files its facts under a bounded number of subjects, so a
 * model that names a subject per fact cannot fill the shared notes with
 * hundreds of one-line notes. The subjects with the most facts stay; the
 * rest are folded into the general one. A folded fact keeps the subject it
 * had in front of its own text ("Asha: lives in Delhi"), which is what
 * recall looks for in the general note (server/recall.ts): a note has room
 * for a dozen aliases, and an import can fold many more subjects than that.
 * The subject is kept as an alias too, for as long as there is room. */
export function foldSubjects(candidates: readonly ImportCandidate[], max = IMPORT_SUBJECTS_MAX): ImportCandidate[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.subject.toLowerCase(), (counts.get(candidate.subject.toLowerCase()) ?? 0) + 1);
  if (counts.size <= max) return [...candidates];
  const general = FALLBACK_SUBJECT.toLowerCase();
  const stay = new Set([...counts].filter(([subject]) => subject !== general).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max - 1).map(([subject]) => subject));
  return candidates.map((candidate) => {
    const subject = candidate.subject.toLowerCase();
    if (subject === general || stay.has(subject)) return candidate;
    const aliases = usableAlias(candidate.subject) && !candidate.aliases.includes(candidate.subject) ? [candidate.subject, ...candidate.aliases] : candidate.aliases;
    return { ...candidate, text: foldedFactText(candidate.subject, candidate.text, TEXT_MAX), subject: FALLBACK_SUBJECT, aliases };
  });
}

/** What the person changed in the review: ticks, text, where a fact goes, and a subject's name. */
export function patchCandidates(candidates: readonly ImportCandidate[], patch: CandidatePatch): ImportCandidate[] {
  let next = [...candidates];
  if (patch.renameSubject) {
    const from = patch.renameSubject.from.trim().toLowerCase();
    const to = screenedSubject(patch.renameSubject.to);
    next = next.map((candidate) => (candidate.subject.toLowerCase() === from ? { ...candidate, subject: to } : candidate));
  }
  for (const change of patch.changes ?? []) {
    const at = next.findIndex((candidate) => candidate.id === change.id);
    if (at === -1) throw new ReviewError("That fact is no longer part of this import.", 404);
    const updated = { ...next[at]! };
    if (change.keep !== undefined) updated.keep = change.keep;
    if (change.text !== undefined) {
      const text = cleanFactText(change.text);
      if (!text) throw new ReviewError("A fact cannot be empty. Untick it to leave it out.", 400);
      // what the import would not take from a model it does not take from an edit either
      if (holdsSecret(change.text.replace(/\s+/g, " ")) || holdsSecret(text)) throw new ReviewError("A fact cannot hold a password, a card number or an identity or bank number. Leave that part out.", 400);
      if (readsAsInstruction(text)) throw new ReviewError("A fact cannot be an instruction, a command, code or a link. Write it as something true about you.", 400);
      updated.text = text;
    }
    if (change.subject !== undefined) updated.subject = screenedSubject(change.subject);
    if (change.kind !== undefined && change.kind !== updated.kind) {
      if (change.kind === "core" && next.filter((candidate) => candidate.kind === "core").length >= CORE_MAX) {
        throw new ReviewError(`Core holds at most ${CORE_MAX} facts. Move one to a subject first.`, 409);
      }
      updated.kind = change.kind;
    }
    next[at] = updated;
  }
  return next;
}
