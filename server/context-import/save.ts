// Step 6 of an import, the only one that writes anything the bots read.
// Kept core facts go to About me through the learned-facts path
// (server/profile-learned.ts), so each is listed in Settings with Remove and
// a fact the person removed before is not added again; the source stands
// where a bot's name would. A core fact About me has no room for is filed
// under its subject like any other fact. Kept subject facts go to the shared
// notes, one note per subject.
//
// A save is planned first and refused whole when it would not fit: more new
// notes than the store has room for, or a note past its size limit. Nothing
// is ever cut short to make it fit, because what was cut would be gone with
// the upload. The review screen shows the same plan's problems before Save
// is pressed. Each note is written once, and the save lets other requests
// run between two notes. Saving twice changes nothing: both stores leave out
// a fact they already hold.
import { appendSharedEntries, listSharedNotes, planSharedEntries, sharedNoteEntry, sharedNoteFileName, SHARED_NOTES_MAX_FILES } from "../shared-notes.ts";
import { appendAboutMe, commitLearned, planLearned, type LearnedFact } from "../profile-learned.ts";
import { memoryDate } from "../workspace.ts";
import { CORE_MAX, IMPORT_ORIGIN_LABEL, type ImportCandidate, type ImportFitProblem, type ImportOrigin, type ImportSaveResult } from "../../shared/context-import.ts";

/** The bot id a learned fact from an import carries: `import:chatgpt`. */
export const IMPORT_BOT_PREFIX = "import:";
/** The marks an import's lines carry in About me: `learned by ChatGPT import`. */
export const IMPORT_LINE_MARKS: readonly string[] = Object.values(IMPORT_ORIGIN_LABEL).map((label) => `${label} import`);
/** A note keeps at most this many of the aliases its facts bring. */
const NOTE_ALIASES_MAX = 12;

export interface SaveDeps {
  aboutMe: () => string;
  saveAboutMe: (text: string) => void;
  now: () => Date;
}

/** A save that stopped part of the way: what it could not write and why. The
 * job is kept, and pressing Save again writes only what is still missing. */
export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

interface NoteGroup {
  subject: string;
  aliases: string[];
  lines: string[];
}

export interface SavePlan {
  origin: ImportOrigin;
  /** Core facts that fit in About me, and About me with them added. */
  fitted: LearnedFact[];
  aboutMeText: string;
  /** Core facts About me has no room for: filed under their subject. */
  overflowed: number;
  /** One per note that will be written to. */
  groups: NoteGroup[];
  /** Lines that would be added across the notes. */
  entries: number;
  /** Facts left out because About me or the notes already have them. */
  duplicates: number;
  /** Why the save would be refused; empty when it fits. */
  problems: ImportFitProblem[];
}

/** What saving these candidates would write, without writing anything. */
export function planSave(origin: ImportOrigin, candidates: readonly ImportCandidate[], deps: Pick<SaveDeps, "aboutMe" | "now">): SavePlan {
  const label = IMPORT_ORIGIN_LABEL[origin];
  const kept = candidates.filter((candidate) => candidate.keep && candidate.text.trim());
  const core = kept.filter((candidate) => candidate.kind === "core").slice(0, CORE_MAX);
  const coreIds = new Set(core.map((candidate) => candidate.id));
  const entry = (candidate: ImportCandidate) => sharedNoteEntry(candidate.text, { date: candidate.date, origin: label, ...(candidate.until ? { until: candidate.until } : {}) });
  const aboutMe = deps.aboutMe();
  const plan: SavePlan = { origin, fitted: [], aboutMeText: aboutMe, overflowed: 0, groups: [], entries: 0, duplicates: 0, problems: [] };

  // Core facts: About me, as far as it has room, a line at a time.
  const overflow: ImportCandidate[] = [];
  let planned = 0;
  for (const candidate of core) {
    const [fact] = planLearned({ botId: `${IMPORT_BOT_PREFIX}${origin}`, botName: `${label} import` }, [candidate.text], plan.aboutMeText, memoryDate(deps.now()), deps.now().getTime());
    if (!fact) continue;
    planned += 1;
    const appended = appendAboutMe(plan.aboutMeText, [fact.line]);
    if (appended === null) overflow.push({ ...candidate, text: fact.text });
    else {
      plan.aboutMeText = appended;
      plan.fitted.push(fact);
    }
  }
  plan.duplicates += core.length - planned;
  plan.overflowed = overflow.length;

  // Everything else, and what About me had no room for: one note per subject.
  // Two subjects that make the same file name are one note.
  const groups = new Map<string, NoteGroup>();
  for (const candidate of [...overflow, ...kept.filter((candidate) => !coreIds.has(candidate.id))]) {
    const key = sharedNoteFileName(candidate.subject).toLowerCase();
    const group = groups.get(key) ?? { subject: candidate.subject, aliases: [], lines: [] };
    for (const alias of candidate.aliases) if (group.aliases.length < NOTE_ALIASES_MAX && !group.aliases.includes(alias)) group.aliases.push(alias);
    group.lines.push(entry(candidate));
    groups.set(key, group);
  }

  const notes = listSharedNotes();
  let newNotes = 0;
  for (const group of groups.values()) {
    const note = planSharedEntries(group, notes);
    plan.duplicates += group.lines.length - note.fresh;
    if (!note.fresh) continue;
    plan.groups.push(group);
    plan.entries += note.fit;
    if (!note.exists) newNotes += 1;
    if (note.fit < note.fresh) plan.problems.push({ kind: "bytes", subject: group.subject, over: note.fresh - note.fit });
  }
  const room = Math.max(0, SHARED_NOTES_MAX_FILES - notes.length);
  if (newNotes > room) plan.problems.unshift({ kind: "files", needed: newNotes, room });
  return plan;
}

/** A plan's problems as the refusal the person reads. */
export function saveRefusal(problems: readonly ImportFitProblem[]): string {
  const parts = problems.slice(0, 4).map((problem) => problem.kind === "files"
    ? `These facts need ${problem.needed} new shared note(s) and there is room for ${problem.room}.`
    : `The note “${problem.subject}” would be too large: ${problem.over} fact(s) do not fit.`);
  const more = problems.length > 4 ? ` And ${problems.length - 4} more note(s) are too large.` : "";
  return `Nothing was saved, because not everything you ticked fits. ${parts.join(" ")}${more} Untick some facts, give facts that share a subject the same subject, or split a large subject in two, then save again.`;
}

const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Write the kept facts. Throws SaveError when the save would not fit (then
 * nothing was written) or a write failed part of the way (then what was
 * written stays, and saving again adds only the rest). */
export async function saveImportedFacts(origin: ImportOrigin, candidates: readonly ImportCandidate[], deps: SaveDeps): Promise<ImportSaveResult> {
  const plan = planSave(origin, candidates, deps);
  if (plan.problems.length) throw new SaveError(saveRefusal(plan.problems));
  const result: ImportSaveResult = { aboutMe: 0, overflowed: plan.overflowed, subjects: 0, entries: 0, duplicates: plan.duplicates, full: [], aboutMeText: deps.aboutMe() };

  if (plan.fitted.length) {
    // About me first: a failed profile save leaves nothing recorded, and the import can be saved again.
    deps.saveAboutMe(plan.aboutMeText);
    commitLearned(plan.fitted);
    result.aboutMe = plan.fitted.length;
    result.aboutMeText = plan.aboutMeText;
  }

  for (const group of plan.groups) {
    // read, merged and written in one step, so a note edited meanwhile is never overwritten
    const written = appendSharedEntries(group);
    if (written.added) {
      result.subjects += 1;
      result.entries += written.added;
    }
    if (written.dropped) {
      throw new SaveError(`The note “${group.subject}” changed while the import was being saved, and ${written.dropped} fact(s) no longer fit. What was saved so far stays. Save again to see what is left.`);
    }
    await breathe();
  }
  return result;
}
