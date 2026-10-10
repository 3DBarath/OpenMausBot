// Shared notes: facts about the person that belong to no single bot, filed
// by subject in $OMB_DATA_DIR/shared-notes/<subject>.md. A note has the shape
// of a bot's topic file (frontmatter with `title` and `aliases`, then dated
// entries), so the same word matching finds it. An entry an import wrote
// ends with `(imported · ChatGPT)`, which is how "delete everything imported"
// tells it from a line the person wrote. Bots get no tool for this folder:
// automatic recall is the only way the app puts a note in front of a turn,
// and only in a one-to-one chat the installation's owner started
// (server/recall.ts). The folder is ordinary data under the app's data
// folder: a bot that can run commands on this computer as the app's user
// can read these files like any other file that user owns.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { topicFileName } from "./memory-capture.ts";
import { factIdentity, parseMemoryEntries, untilMark } from "./memory-entries.ts";
import { mergeTopicText, parseTopicHeader, readTopicHead, topicBody, type TopicHeader } from "./memory-topics.ts";
import { redactSecretsInText } from "./redact.ts";
import { isMemoryTopicName } from "./workspace.ts";
import { IMPORT_ORIGIN_LABEL } from "../shared/context-import.ts";
import type { SharedNoteInfo } from "../shared/shared-notes.ts";

export const SHARED_NOTES_MAX_FILES = 200;
export const SHARED_NOTE_MAX_BYTES = 64 * 1024;

/** The subject facts are filed under when they have none of their own, and
 * the one an import folds its rarest subjects into. */
export const GENERAL_SUBJECT = "General";

/** Words that turn up in questions about anything. A shared note is never
 * found by one of them, in its name, its title or an alias, and an import
 * does not keep one as an alias: a note that answers to "today" or "help"
 * is recalled for unrelated messages. */
const COMMON_WORDS = new Set((
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use " +
  "that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were " +
  "what about after again also another always anything around because before being best better between both could does doing done each even every everything " +
  "first found give goes going great help into keep last least less little look made mean might more most must need never next nothing often other " +
  "people person please point question questions answer answers really right same should show since small something sometimes still stuff tell thank thanks their then there these " +
  "thing things think those through today tomorrow yesterday tonight under until used user using want wants week where which while whole would year years " +
  "able above across actually almost already although anyone anywhere away back became become below called came cannot certain " +
  "different during either else enough ever everyone few find got however idea important information info inside instead kind know later let lot " +
  "may maybe mine myself near none now off once others own part per perhaps quite rather said seem several short simply someone soon sure " +
  "than thought together took toward try turn upon various via way ways went whether within without yes yet general misc notes note fact facts details " +
  "assistant chat chats conversation conversations message messages reply replies response remember recall ask asked asking").split(/\s+/));

export function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word.toLowerCase());
}

/** A fact as it is filed under the general subject when its own subject was
 * folded away (an import files under a bounded number of subjects): the
 * subject it had stays in front of its text, so asking about that subject
 * still finds the entry, whatever the note's few aliases are. */
export function foldedFactText(subject: string, text: string, max: number): string {
  const tag = subject.replace(/[:·\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!tag || text.toLowerCase().startsWith(`${tag.toLowerCase()}: `)) return text;
  return `${tag}: ${text}`.slice(0, max).trimEnd();
}

/** The subjects that entries of the general note are tagged with, as words:
 * what such a note answers to beyond its own name and aliases. */
export function foldedSubjectWords(body: string): string[] {
  const words = new Set<string>();
  for (const line of body.split("\n")) {
    const tag = /^\s*[-*•]\s+(?:\d{4}-\d{2}-\d{2}\s+·\s+)?([^:·\n]{1,40}):\s/.exec(line)?.[1];
    if (!tag) continue;
    for (const word of tag.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if ((word.length >= 3 || /^\d{2,}$/.test(word)) && !COMMON_WORDS.has(word)) words.add(word);
    }
  }
  return [...words];
}

/** ` (imported · ChatGPT)` at the end of an entry's text, before any ` · until` mark. */
const IMPORTED_IN_LINE = / \(imported · [^()\n]{1,40}\)(?= · |$)/;
/** The marks an import itself writes, exactly: ` (imported · ChatGPT)`,
 * ` (imported · Claude)`, ` (imported · Pasted text)`. "Delete everything
 * imported" removes the lines that end with one of these (before any
 * ` · until` mark) and no other line: not a line under such an entry, and
 * not a line the person ended with words of their own in the same shape. */
const IMPORT_MARKS = Object.values(IMPORT_ORIGIN_LABEL).map((label) => ` (imported · ${label})`);
const UNTIL_TAIL = / · until \d{4}-\d{2}-\d{2}$/;

/** Whether this one line is an entry an import wrote. */
export function importedLine(line: string): boolean {
  if (!/^\s*[-*•]\s/.test(line)) return false;
  const body = line.trimEnd().replace(UNTIL_TAIL, "");
  return IMPORT_MARKS.some((mark) => body.endsWith(mark));
}

export class SharedNotesError extends Error {
  readonly status: number;
  readonly code: "invalid-name" | "too-large" | "too-many";
  constructor(message: string, status: number, code: "invalid-name" | "too-large" | "too-many") {
    super(message);
    this.name = "SharedNotesError";
    this.status = status;
    this.code = code;
  }
}

export function sharedNotesDir(): string {
  return join(DATA_DIR, "shared-notes");
}

/** A subject as its file name: "Food" is food.md, "About me, continued" is about-me-continued.md. */
export function sharedNoteFileName(subject: string): string {
  return topicFileName(subject) ?? topicFileName(`${subject} notes`) ?? "notes.md";
}

/** Only a regular file is a note: a link planted in the folder is never read through. */
function regularFile(path: string): { bytes: number } | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { bytes: stat.size } : null;
  } catch {
    return null;
  }
}

/** Every note, name and header only: cheap enough to run before each turn. */
export function listSharedNotes(): Array<{ name: string; bytes: number; header: TopicHeader }> {
  let names: string[];
  try {
    names = readdirSync(sharedNotesDir());
  } catch {
    return [];
  }
  return names
    .filter(isMemoryTopicName)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      const path = join(sharedNotesDir(), name);
      const file = regularFile(path);
      return file ? [{ name, bytes: file.bytes, header: parseTopicHeader(readTopicHead(path)) }] : [];
    });
}

/** One note's text. The name gate runs here, so no caller can turn this into
 * a read of another path. Null for anything invalid or unreadable. */
export function readSharedNote(name: string): string | null {
  if (!isMemoryTopicName(name)) return null;
  const path = join(sharedNotesDir(), name);
  if (!regularFile(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Replace one note: the name gate, the same scrub as bot memory, both caps,
 * owner-only modes and an atomic write. */
export function writeSharedNote(name: string, text: string): void {
  if (!isMemoryTopicName(name)) throw new SharedNotesError("A shared note is one .md file name with no folders in it.", 400, "invalid-name");
  const clean = redactSecretsInText(text);
  if (Buffer.byteLength(clean, "utf8") > SHARED_NOTE_MAX_BYTES) {
    throw new SharedNotesError(`A shared note holds at most ${SHARED_NOTE_MAX_BYTES / 1024} KB. Split it into two subjects.`, 413, "too-large");
  }
  const path = join(sharedNotesDir(), name);
  if (!regularFile(path) && listSharedNotes().length >= SHARED_NOTES_MAX_FILES) {
    throw new SharedNotesError(`There are already ${SHARED_NOTES_MAX_FILES} shared notes. Delete one first.`, 409, "too-many");
  }
  mkdirSync(sharedNotesDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, clean, { mode: 0o600 });
}

export function deleteSharedNote(name: string): boolean {
  if (!isMemoryTopicName(name)) return false;
  const path = join(sharedNotesDir(), name);
  if (!regularFile(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** One imported entry line: `- 2025-03-02 · The person is vegetarian (imported · ChatGPT)`. */
export function sharedNoteEntry(text: string, opts: { date: string; origin: string; until?: string }): string {
  const body = text.replace(/\s+/g, " ").trim().replace(/ · until \d{4}-\d{2}-\d{2}$/, "");
  const origin = opts.origin.replace(/[()·\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `- ${opts.date} · ${body} (imported · ${origin})${untilMark(opts.until)}`;
}

/** The identity of one entry line with its import mark left out, so the same
 * fact imported twice, or written by hand and then imported, is one fact. */
function entryIdentity(line: string): string {
  if (!/^\s*[-*•]\s/.test(line)) return "";
  const entry = parseMemoryEntries(line.replace(IMPORTED_IN_LINE, ""))[0];
  if (entry) return entry.struck ? "" : factIdentity(entry.body);
  return factIdentity(line);
}

function identitiesOf(text: string): Set<string> {
  return new Set(text.split("\n").map(entryIdentity).filter(Boolean));
}

/** Every fact the shared notes already hold, for "is this already written down". */
export function sharedNoteIdentities(): Set<string> {
  const out = new Set<string>();
  for (const note of listSharedNotes()) {
    for (const key of identitiesOf(readSharedNote(note.name) ?? "")) out.add(key);
  }
  return out;
}

/** A title is one line; an alias also loses what would break the `[a, b]` list it sits in. */
const oneLine = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);
const aliasSafe = (value: string) => oneLine(value.replace(/[,[\]]+/g, " "), 40);

/** What adding entry lines to a subject's note would do, without writing
 * anything: which lines are new, how many of them fit under the size limit,
 * and the note's text with those added. `notes` is a listing taken once
 * when many subjects are planned together. */
export interface SharedEntriesPlan {
  name: string;
  /** The note is there already; adding to it needs no room for a new file. */
  exists: boolean;
  /** Lines whose fact the note does not hold yet. */
  fresh: number;
  /** How many of them fit; the rest would pass the size limit. */
  fit: number;
  /** The note's text with the lines that fit added. */
  text: string;
}

export function planSharedEntries(
  input: { subject: string; aliases: readonly string[]; lines: readonly string[] },
  notes: ReadonlyArray<{ name: string }> = listSharedNotes(),
): SharedEntriesPlan {
  const wanted = sharedNoteFileName(input.subject);
  const existing = notes.find((note) => note.name.toLowerCase() === wanted.toLowerCase());
  const name = existing?.name ?? wanted;
  const current = existing ? readSharedNote(name) : null;
  const seen = identitiesOf(current ?? "");
  const fresh: string[] = [];
  for (const line of input.lines) {
    const key = entryIdentity(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(redactSecretsInText(line));
  }
  if (!fresh.length) return { name, exists: Boolean(existing), fresh: 0, fit: 0, text: current ?? "" };
  const title = oneLine(input.subject, 80) || name.replace(/\.md$/, "");
  const aliases = [...new Set(input.aliases.map(aliasSafe).filter(Boolean))];
  const merged = (count: number) => mergeTopicText(current, { title, aliases, lines: fresh.slice(0, count) });
  // The size only grows with the number of lines: find the most that fit by
  // halving, so a note that takes a thousand lines is merged ten times, not a thousand.
  let fit = 0;
  let text = current ?? "";
  for (let low = 1, high = fresh.length; low <= high;) {
    const middle = (low + high) >> 1;
    const candidate = merged(middle);
    if (Buffer.byteLength(candidate, "utf8") <= SHARED_NOTE_MAX_BYTES) {
      fit = middle;
      text = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return { name, exists: Boolean(existing), fresh: fresh.length, fit, text };
}

/** Add entry lines to a subject's note, creating it with a header the first
 * time. A line whose fact the note already holds is left out. Both caps
 * hold: `dropped` counts the lines that did not fit and `reason` says which
 * cap stopped them; nothing already in the note is ever removed to make room.
 * The note is written once. */
export function appendSharedEntries(input: { subject: string; aliases: readonly string[]; lines: readonly string[] }): { name: string; added: number; dropped: number; reason?: "files" | "bytes" } {
  const notes = listSharedNotes();
  const plan = planSharedEntries(input, notes);
  if (!plan.fresh) return { name: plan.name, added: 0, dropped: 0 };
  if (!plan.exists && notes.length >= SHARED_NOTES_MAX_FILES) return { name: plan.name, added: 0, dropped: plan.fresh, reason: "files" };
  if (plan.fit > 0) {
    mkdirSync(sharedNotesDir(), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(sharedNotesDir(), plan.name), plan.text, { mode: 0o600 });
  }
  return { name: plan.name, added: plan.fit, dropped: plan.fresh - plan.fit, ...(plan.fit < plan.fresh ? { reason: "bytes" as const } : {}) };
}

/** Remove every entry an import wrote, from every note: exactly the lines
 * that carry an import's own mark (importedLine). A line under such an
 * entry, and any line the person wrote, stays. A note left with no text of
 * its own is deleted. */
export function deleteImportedEntries(): { entries: number; files: number } {
  let entries = 0;
  let files = 0;
  for (const note of listSharedNotes()) {
    const text = readSharedNote(note.name);
    if (text === null) continue;
    const lines = text.split("\n");
    const kept = lines.filter((line) => !importedLine(line));
    if (kept.length === lines.length) continue;
    entries += lines.length - kept.length;
    const rest = kept.join("\n");
    if (topicBody(rest)) writeFileAtomic(join(sharedNotesDir(), note.name), rest, { mode: 0o600 });
    else {
      rmSync(join(sharedNotesDir(), note.name), { force: true });
      files += 1;
    }
  }
  return { entries, files };
}

/** Every note as Settings lists it: title, other words for it, and how much an import wrote. */
export function describeSharedNotes(): SharedNoteInfo[] {
  return listSharedNotes().map((note) => {
    const text = readSharedNote(note.name) ?? "";
    const entries = parseMemoryEntries(text);
    return {
      name: note.name,
      title: note.header.title ?? note.name.replace(/\.md$/, ""),
      aliases: note.header.aliases,
      bytes: note.bytes,
      entries: entries.length,
      imported: text.split("\n").filter(importedLine).length,
    };
  });
}
