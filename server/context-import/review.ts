// Steps 4 and 5 of an import: settling conflicts between the proposed facts
// and what the person may change before saving. Conflicts use the
// contradiction step Memory upkeep has (server/memory-tidy.ts); the newer
// fact wins and the older one stays in the list, unticked, pointing at it.
// Core, which goes to About me, holds at most 30 facts. Pure here.
import { cleanFactText, cleanSubject } from "./extract.ts";
import type { MemoryEntryLine } from "../memory-entries.ts";
import type { Contradiction } from "../memory-tidy.ts";
import { CORE_MAX, type CandidatePatch, type ImportCandidate } from "../../shared/context-import.ts";

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

/** What the person changed in the review: ticks, text, where a fact goes, and a subject's name. */
export function patchCandidates(candidates: readonly ImportCandidate[], patch: CandidatePatch): ImportCandidate[] {
  let next = [...candidates];
  if (patch.renameSubject) {
    const from = patch.renameSubject.from.trim().toLowerCase();
    const to = cleanSubject(patch.renameSubject.to);
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
      updated.text = text;
    }
    if (change.subject !== undefined) updated.subject = cleanSubject(change.subject);
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
