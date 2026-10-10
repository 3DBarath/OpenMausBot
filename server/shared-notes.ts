// Shared notes: facts about the person that belong to no single bot, filed
// by subject in $OMB_DATA_DIR/shared-notes/<subject>.md. A note has the shape
// of a bot's topic file (frontmatter with `title` and `aliases`, then dated
// entries), so the same word matching finds it. An entry an import wrote
// ends with `(imported · ChatGPT)`, which is how "delete everything imported"
// tells it from a line the person wrote. Bots have no tool for this folder:
// automatic recall is the only way a note reaches a turn, and only in a
// one-to-one chat the installation's owner started (server/recall.ts).
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { topicFileName } from "./memory-capture.ts";
import { factIdentity, parseMemoryEntries, untilMark } from "./memory-entries.ts";
import { mergeTopicText, parseTopicHeader, readTopicHead, topicBody, type TopicHeader } from "./memory-topics.ts";
import { redactSecretsInText } from "./redact.ts";
import { isMemoryTopicName } from "./workspace.ts";
import type { SharedNoteInfo } from "../shared/shared-notes.ts";

export const SHARED_NOTES_MAX_FILES = 200;
export const SHARED_NOTE_MAX_BYTES = 64 * 1024;

/** ` (imported · ChatGPT)` at the end of an entry's text, before any ` · until` mark. */
const IMPORTED_IN_LINE = / \(imported · [^()\n]{1,40}\)(?= · |$)/;
const IMPORTED_BODY = / \(imported · [^()\n]{1,40}\)$/;

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

/** Add entry lines to a subject's note, creating it with a header the first
 * time. A line whose fact the note already holds is left out. Both caps
 * hold: `dropped` counts the lines that did not fit and `reason` says which
 * cap stopped them; nothing already in the note is ever removed to make room. */
export function appendSharedEntries(input: { subject: string; aliases: readonly string[]; lines: readonly string[] }): { name: string; added: number; dropped: number; reason?: "files" | "bytes" } {
  const wanted = sharedNoteFileName(input.subject);
  const existing = listSharedNotes().find((note) => note.name.toLowerCase() === wanted.toLowerCase());
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
  if (!fresh.length) return { name, added: 0, dropped: 0 };
  if (!existing && listSharedNotes().length >= SHARED_NOTES_MAX_FILES) return { name, added: 0, dropped: fresh.length, reason: "files" };
  const title = oneLine(input.subject, 80) || name.replace(/\.md$/, "");
  const aliases = [...new Set(input.aliases.map(aliasSafe).filter(Boolean))];
  const merged = (lines: readonly string[]) => mergeTopicText(current, { title, aliases, lines });
  let fit = fresh.length;
  while (fit > 0 && Buffer.byteLength(merged(fresh.slice(0, fit)), "utf8") > SHARED_NOTE_MAX_BYTES) fit -= 1;
  if (fit > 0) {
    mkdirSync(sharedNotesDir(), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(sharedNotesDir(), name), merged(fresh.slice(0, fit)), { mode: 0o600 });
  }
  return { name, added: fit, dropped: fresh.length - fit, ...(fit < fresh.length ? { reason: "bytes" as const } : {}) };
}

/** Remove every entry an import wrote, from every note. A note left with no
 * text of its own is deleted; lines the person wrote stay. */
export function deleteImportedEntries(): { entries: number; files: number } {
  let entries = 0;
  let files = 0;
  for (const note of listSharedNotes()) {
    const text = readSharedNote(note.name);
    if (text === null) continue;
    const drop = new Set<number>();
    for (const entry of parseMemoryEntries(text)) {
      if (!IMPORTED_BODY.test(entry.body)) continue;
      entries += 1;
      for (let line = entry.line; line < entry.end; line += 1) drop.add(line);
    }
    if (!drop.size) continue;
    const rest = text.split("\n").filter((_, index) => !drop.has(index)).join("\n");
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
    const entries = parseMemoryEntries(readSharedNote(note.name) ?? "");
    return {
      name: note.name,
      title: note.header.title ?? note.name.replace(/\.md$/, ""),
      aliases: note.header.aliases,
      bytes: note.bytes,
      entries: entries.length,
      imported: entries.filter((entry) => IMPORTED_BODY.test(entry.body)).length,
    };
  });
}
