// Which conversations are provably the owner's alone, and which hold a
// recalled shared note in their engine session (server/shared-notes-owner.ts
// says who the owner is; server/recall.ts asks before recalling).
//
// A line carries a sender only when a signed-in device sent it, and not
// always then, so a line without one proves nothing about who wrote it. What
// does prove it is the request that wrote the line: when that request was
// the owner's, the line's id is recorded here, at that moment. A
// conversation is the owner's alone when every line a person wrote in it is
// on record. A line nobody vouched for (an older line, a guest's, a
// routine's prompt, one that waited in the queue across a restart) is never
// on record, so the answer for its conversation is "not proven", for good.
//
// Per conversation the file keeps a count and a 128-bit sum over the ids of
// the proven lines, not the ids: a few dozen bytes however long the
// conversation grows. The sum of the lines a conversation holds now must
// equal the sum on record.
//
// The second fact kept here is `recalled`: a shared note was put in front of
// a turn of this conversation, so the engine's own session holds it. A line
// someone else writes there later must not resume that session; the caller
// drops the session and clears the mark.
//
// $OMB_DATA_DIR/shared-notes-threads.json, owner-only. A missing or damaged
// file means nothing is proven: it never grants anything by being absent.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

const THREAD = /^[\w-]{1,128}$/;
const SUM = /^[0-9a-f]{32}$/;
/** Oldest conversations go first past this; theirs become "not proven". */
const MAX_THREADS = 20_000;

interface ThreadRecord {
  /** How many lines are proven the owner's. */
  lines: number;
  /** The XOR of a hash of each proven line's id. */
  sum: Buffer;
  recalled: boolean;
}

function lineHash(threadId: string, messageId: string): Buffer {
  return createHash("sha256").update(`${threadId}\n${messageId}`).digest().subarray(0, 16);
}

function xor(into: Buffer, other: Buffer): void {
  for (let at = 0; at < into.length; at += 1) into[at]! ^= other[at]!;
}

export class OwnerThreads {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly file: string;
  private readonly log: (line: string) => void;

  constructor(file: string, log: (line: string) => void = () => undefined) {
    this.file = file;
    this.log = log;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // absent or unreadable: nothing is proven
    }
    const threads = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { threads?: unknown }).threads : null;
    if (!threads || typeof threads !== "object" || Array.isArray(threads)) return;
    for (const [threadId, value] of Object.entries(threads)) {
      if (!THREAD.test(threadId) || !Array.isArray(value)) continue;
      const [lines, sum, recalled] = value as unknown[];
      if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 0 || typeof sum !== "string" || !SUM.test(sum)) continue;
      this.threads.set(threadId, { lines, sum: Buffer.from(sum, "hex"), recalled: recalled === 1 });
    }
  }

  private record(threadId: string): ThreadRecord | null {
    if (!THREAD.test(threadId)) return null;
    let record = this.threads.get(threadId);
    if (!record) {
      record = { lines: 0, sum: Buffer.alloc(16), recalled: false };
      this.threads.set(threadId, record);
      while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!);
    }
    return record;
  }

  /** Write the record. False when it could not be saved: the caller then
   * acts as if the fact it wanted to record were not known. */
  private save(): boolean {
    try {
      const threads = Object.fromEntries([...this.threads].map(([threadId, record]) => [threadId, [record.lines, record.sum.toString("hex"), record.recalled ? 1 : 0]]));
      writeFileAtomic(this.file, `${JSON.stringify({ version: 1, threads })}\n`, { mode: 0o600 });
      return true;
    } catch (error) {
      this.log(`shared notes: could not save which conversations are the owner's: ${(error as Error).message}`);
      return false;
    }
  }

  /** The owner's own request wrote this line. Call once per line, when it is written. */
  prove(threadId: string, messageId: string): void {
    const record = messageId ? this.record(threadId) : null;
    if (!record) return;
    record.lines += 1;
    xor(record.sum, lineHash(threadId, messageId));
    // unsaved, the proof lasts until a restart and the conversation is "not proven" after it
    this.save();
  }

  /** Whether every one of these lines, the lines people wrote in the
   * conversation, was proven the owner's. False for a conversation with no
   * such line on record. */
  ownerOnly(threadId: string, personLineIds: readonly string[]): boolean {
    const record = this.threads.get(threadId);
    if (!record || !personLineIds.length || record.lines !== personLineIds.length) return false;
    if (new Set(personLineIds).size !== personLineIds.length) return false;
    const sum = Buffer.alloc(16);
    for (const id of personLineIds) xor(sum, lineHash(threadId, id));
    return sum.equals(record.sum);
  }

  /** A shared note is about to be put in front of a turn of this
   * conversation. False when that could not be recorded: the note must then
   * not be recalled, because nothing would know to drop the session later. */
  noteRecalled(threadId: string): boolean {
    const record = this.record(threadId);
    if (!record) return false;
    if (record.recalled) return true;
    record.recalled = true;
    if (this.save()) return true;
    record.recalled = false;
    return false;
  }

  /** Whether this conversation's engine session may hold a recalled shared note. */
  recalled(threadId: string): boolean {
    return this.threads.get(threadId)?.recalled === true;
  }

  /** The engine session that held the note is gone (a fresh one was started and took over). */
  sessionDropped(threadId: string): void {
    const record = this.threads.get(threadId);
    if (!record?.recalled) return;
    record.recalled = false;
    // unsaved, the mark comes back after a restart and one more session is dropped: the safe side
    this.save();
  }
}
