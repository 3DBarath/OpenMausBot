// Whose a routine is on an OMB Cloud home. Only a routine the owner provably wrote runs with the owner's shell: its
// writer and the fingerprint of what they wrote are recorded (cloud-lending.ts), and what came before is settled once
// (cloud-owner.ts). Every other routine runs confined, like a guest's. When the records cannot tell (a routine from
// before the Cloud was only the owner's, or one a bot changed in a conversation someone else wrote in), the owner is
// told once, in plain words, and one click on its run from their own device makes it theirs.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { createCloudRoutineAuthors } from "./cloud-lending.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export const ROUTINE_UNCONFIRMED = "OpenMausBot can't tell who wrote this routine, so it runs without a shell until you confirm it's yours: press Run with full access on its run, or open it and save it.";
export const ROUTINE_ENGINE_REFUSAL = `This bot's engine needs a shell, so this run stopped. ${ROUTINE_UNCONFIRMED}`;
/** The one notification, short enough to keep what to press. */
export const ROUTINE_NOTICE = "It can't use a shell until you confirm it's yours: press Run with full access on its run.";
export const CONVERSATION_FROM_BEFORE = "This conversation is from before My Cloud was only yours, so this bot works in it without a shell. Start a new conversation to use it fully.";
export const CONVERSATION_ENGINE_REFUSAL = "This conversation is from before My Cloud was only yours, and this bot's engine can't work in it. Start a new conversation.";

type Authors = ReturnType<typeof createCloudRoutineAuthors>;
type Shape = { prompt?: string; botId?: string; runOn?: string; schedule?: unknown; target?: string; groupId?: string | null; attachments?: { id: string; path: string }[] };

/** What a routine proposal card showed, bar an interval's anchor: a card the owner allowed proves only while the routine runs exactly that. */
export function approvalShape(shape: Shape): string {
  const schedule = shape.schedule && typeof shape.schedule === "object" ? { ...(shape.schedule as Record<string, unknown>) } : null;
  if (schedule) delete schedule.anchorAt;
  return JSON.stringify([shape.prompt ?? "", shape.botId ?? "", shape.runOn ?? "maus", schedule, shape.target ?? "bot", shape.groupId ?? null,
    (shape.attachments ?? []).map((attachment) => [attachment.id, attachment.path])]);
}

export interface CloudRoutineOwnerOptions {
  authors: Authors;
  ownerKey: string;
  nobodyKey: string;
  routine(id: string): Routine | undefined;
  /** The owner or one of their earlier keys (index.ts cloudOwnerPerson). */
  ownerPerson(person: string): boolean;
  /** Which routines' owner was already told they run confined (0600). Missing or damaged: told about none. */
  noticesFile: string;
}

const NoticesFile = z.object({ version: z.literal(1), told: z.array(z.string().max(128)).max(10_000) }).strict();

export function createCloudRoutineOwner(options: CloudRoutineOwnerOptions) {
  const { authors, ownerKey, nobodyKey } = options;
  let writing: string | undefined;
  let told = new Set<string>();
  try { told = new Set(NoticesFile.parse(JSON.parse(readFileSync(options.noticesFile, "utf8"))).told); } catch {}
  const saveTold = () => writeFileAtomic(options.noticesFile, JSON.stringify({ version: 1, told: [...told].filter((id) => options.routine(id)) }), { mode: 0o600 });
  /** Never the owner without proof, so a routine that is not theirs runs confined. */
  const recordedOpener = (routineId: string): string => {
    const routine = options.routine(routineId);
    if (routine && authors.authored(routineId, routine)) return ownerKey;
    const writer = authors.writer(routineId);
    if (writer === ownerKey) return ownerKey;
    return writer && !options.ownerPerson(writer) ? writer : nobodyKey;
  };

  const owner = {
    /** Whoever writes the routines created or changed while `work` runs opens their results conversation. */
    as<T>(writer: string, work: () => T): T {
      const previous = writing;
      writing = writer;
      try { return work(); } finally { writing = previous; }
    },
    /** The owner wrote what it runs now. */
    own(routineId: string | undefined): void {
      const routine = routineId ? options.routine(routineId) : undefined;
      if (!routine) return;
      authors.record(routine.id, routine);
      authors.wrote(routine.id, ownerKey);
    },
    isOwners(routineId: string | undefined): boolean {
      const routine = routineId ? options.routine(routineId) : undefined;
      if (!routine) return false;
      return authors.authored(routine.id, routine) || (authors.writer(routine.id) === ownerKey && !authors.recorded(routine.id));
    },
    /** A run carries what it runs; it is the owner's only while that is exactly what the owner wrote. */
    authoredRun(run: RoutineRun): boolean {
      const routine = options.routine(run.routineId);
      return Boolean(routine) && authors.authored(run.routineId, {
        ...routine!, prompt: run.prompt, target: run.target, botId: run.botId, groupId: run.groupId, attachments: run.attachments, runOn: run.runOn,
      });
    },
    /** Approving a change never makes anyone else's routine the owner's: `wasOwners` is taken before the change. */
    applied(action: string, routineId: string | undefined, wasOwners: boolean): void {
      if (action === "create" || ((action === "update" || action === "pause" || action === "resume") && wasOwners)) owner.own(routineId);
    },
    /** Who opens a run's and the results' conversations. */
    opener(routineId: string): string {
      return writing ?? recordedOpener(routineId);
    },
    /** Someone other than the owner (or nobody provable) last wrote it. */
    someoneElses(routineId: string): boolean {
      const writer = authors.writer(routineId);
      return writer !== undefined && !options.ownerPerson(writer);
    },
    /** It exists and its runs work without a shell until the owner confirms it. */
    unconfirmed(routineId: string): boolean {
      return Boolean(options.routine(routineId)) && recordedOpener(routineId) !== ownerKey;
    },
    /** One click from one of the owner's own devices: what it runs now is theirs. False when there is no such routine. */
    confirm(routineId: string): boolean {
      if (!options.routine(routineId)) return false;
      owner.own(routineId);
      if (told.delete(routineId)) saveTold();
      return true;
    },
    /** True the first time a run of this unconfirmed routine is reported; the owner is told once, not at every run. */
    tellOnce(routineId: string): boolean {
      if (told.has(routineId)) return false;
      told.add(routineId);
      try { saveTold(); } catch (error) { console.warn(`cloud home: could not record a routine notice (${(error as Error).message})`); }
      return true;
    },
  };
  return owner;
}

export type CloudRoutineOwner = ReturnType<typeof createCloudRoutineOwner>;
