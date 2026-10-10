// Step 6 of an import, the only one that writes anything the bots read.
// Kept core facts go to About me through the learned-facts path
// (server/profile-learned.ts), so each is listed in Settings with Remove and
// a fact the person removed before is not added again; the source stands
// where a bot's name would. What About me has no room for goes to a shared
// note titled "About me, continued". Kept subject facts go to the shared
// notes, one note per subject. Saving twice changes nothing: both stores
// leave out a fact they already hold.
import { sharedNoteEntry, appendSharedEntries } from "../shared-notes.ts";
import { factIdentity } from "../memory-entries.ts";
import { appendAboutMe, commitLearned, planLearned, type LearnedFact } from "../profile-learned.ts";
import { memoryDate } from "../workspace.ts";
import { CORE_MAX, IMPORT_ORIGIN_LABEL, type ImportCandidate, type ImportOrigin, type ImportSaveResult } from "../../shared/context-import.ts";

export const CONTINUED_SUBJECT = "About me, continued";
/** The bot id a learned fact from an import carries: `import:chatgpt`. */
export const IMPORT_BOT_PREFIX = "import:";

export interface SaveDeps {
  aboutMe: () => string;
  saveAboutMe: (text: string) => void;
  now: () => Date;
}

export function saveImportedFacts(origin: ImportOrigin, candidates: readonly ImportCandidate[], deps: SaveDeps): ImportSaveResult {
  const label = IMPORT_ORIGIN_LABEL[origin];
  const kept = candidates.filter((candidate) => candidate.keep && candidate.text.trim());
  const core = kept.filter((candidate) => candidate.kind === "core").slice(0, CORE_MAX);
  const coreIds = new Set(core.map((candidate) => candidate.id));
  const filed = kept.filter((candidate) => !coreIds.has(candidate.id));
  const entry = (candidate: ImportCandidate) => sharedNoteEntry(candidate.text, { date: candidate.date, origin: label, ...(candidate.until ? { until: candidate.until } : {}) });
  const result: ImportSaveResult = { aboutMe: 0, continued: 0, subjects: 0, entries: 0, duplicates: 0, full: [], aboutMeText: deps.aboutMe() };

  // Core facts: About me, as far as it has room.
  const planned = planLearned({ botId: `${IMPORT_BOT_PREFIX}${origin}`, botName: `${label} import` }, core.map((candidate) => candidate.text), result.aboutMeText, memoryDate(deps.now()), deps.now().getTime());
  result.duplicates += core.length - planned.length;
  const fitted: LearnedFact[] = [];
  const overflow: LearnedFact[] = [];
  let next = result.aboutMeText;
  for (const fact of planned) {
    const appended = appendAboutMe(next, [fact.line]);
    if (appended === null) overflow.push(fact);
    else {
      next = appended;
      fitted.push(fact);
    }
  }
  if (fitted.length) {
    // About me first: a failed profile save leaves nothing recorded, and the import can be saved again.
    deps.saveAboutMe(next);
    commitLearned(fitted);
    result.aboutMe = fitted.length;
    result.aboutMeText = next;
  }

  const groups = new Map<string, { subject: string; aliases: string[]; lines: string[] }>();
  const file = (subject: string, aliases: readonly string[], line: string) => {
    const key = subject.toLowerCase();
    const group = groups.get(key) ?? { subject, aliases: [], lines: [] };
    group.aliases.push(...aliases);
    group.lines.push(line);
    groups.set(key, group);
  };
  const byText = new Map(core.map((candidate) => [factIdentity(candidate.text), candidate]));
  for (const fact of overflow) {
    const candidate = byText.get(factIdentity(fact.text));
    file(CONTINUED_SUBJECT, ["about me", "profile"], candidate ? entry({ ...candidate, text: fact.text }) : sharedNoteEntry(fact.text, { date: memoryDate(deps.now()), origin: label }));
  }
  for (const candidate of filed) file(candidate.subject, candidate.aliases, entry(candidate));

  for (const group of groups.values()) {
    const written = appendSharedEntries({ subject: group.subject, aliases: [...new Set(group.aliases)].slice(0, 12), lines: group.lines });
    const continued = group.subject === CONTINUED_SUBJECT;
    if (written.added) {
      result.subjects += 1;
      if (continued) result.continued += written.added;
      else result.entries += written.added;
    }
    result.duplicates += group.lines.length - written.added - written.dropped;
    if (written.dropped && written.reason) result.full.push({ subject: group.subject, dropped: written.dropped, reason: written.reason });
  }
  return result;
}
