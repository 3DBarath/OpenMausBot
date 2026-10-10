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
//
// Every message the owner sends records a proof, on every installation,
// whether or not it has any shared note. So a proof costs nothing on the
// request: it is kept in memory at once and the file is written a moment
// later, off the request path, many proofs to one write, and once more when
// the server shuts down (`flush`). A crash can lose the last moments of
// proof, and all that costs is that those conversations recall nothing. The
// one thing written at once is the `recalled` mark: losing that would let a
// session that holds a note be handed on, and it is set once per
// conversation, only where a note was actually recalled.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic.ts";

/** How long proofs are gathered before the file is written. */
const WRITE_DELAY_MS = 250;

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
  /** The owner adopted this conversation's older lines (adopt, below). Once, and for good. */
  adopted: boolean;
}

function lineHash(threadId: string, messageId: string): Buffer {
  return createHash("sha256").update(`${threadId}\n${messageId}`).digest().subarray(0, 16);
}

function xor(into: Buffer, other: Buffer): void {
  for (let at = 0; at < into.length; at += 1) into[at]! ^= other[at]!;
}

export class OwnerThreads {
  private readonly threads = new Map<string, ThreadRecord>();
  /** When proof began on this installation (epoch ms): the first start of a
   * version that records it. A line older than this could not have been
   * proven when it was written; a line since could. */
  readonly since: number;
  private readonly file: string;
  private readonly log: (line: string) => void;
  /** Goes up with every change; what is on disk is as of `written`. */
  private version = 0;
  private written = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor(file: string, log: (line: string) => void = () => undefined) {
    this.file = file;
    this.log = log;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      raw = null; // absent or unreadable: nothing is proven
    }
    const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { threads?: unknown; since?: unknown } : null;
    const threads = stored?.threads;
    if (threads && typeof threads === "object" && !Array.isArray(threads)) {
      for (const [threadId, value] of Object.entries(threads)) {
        if (!THREAD.test(threadId) || !Array.isArray(value)) continue;
        const [lines, sum, recalled, adopted] = value as unknown[];
        if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 0 || typeof sum !== "string" || !SUM.test(sum)) continue;
        this.threads.set(threadId, { lines, sum: Buffer.from(sum, "hex"), recalled: recalled === 1, adopted: adopted === 1 });
      }
    }
    // Proof begins now where the file does not say when it began, and that
    // is written down at once: every later start must read the same moment.
    const since = stored && typeof stored.since === "number" && Number.isFinite(stored.since) && stored.since > 0 ? stored.since : null;
    this.since = since ?? Date.now();
    if (since === null) this.saveNow();
  }

  private record(threadId: string): ThreadRecord | null {
    if (!THREAD.test(threadId)) return null;
    let record = this.threads.get(threadId);
    if (!record) {
      record = { lines: 0, sum: Buffer.alloc(16), recalled: false, adopted: false };
      this.threads.set(threadId, record);
      while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!);
    }
    return record;
  }

  private text(): string {
    const threads = Object.fromEntries([...this.threads].map(([threadId, record]) => [threadId, [record.lines, record.sum.toString("hex"), record.recalled ? 1 : 0, ...(record.adopted ? [1] : [])]]));
    return `${JSON.stringify({ version: 1, since: this.since, threads })}\n`;
  }

  /** Something changed: write the file soon, once for everything that changes meanwhile. */
  private changed(): void {
    this.version += 1;
    this.arm();
  }

  private arm(): void {
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writeLater();
    }, WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Write the file without holding the server up. Never rejects. */
  private writeLater(): Promise<void> {
    if (this.writing) return this.writing;
    const version = this.version;
    const text = this.text();
    const scratch = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let wrote = false;
    const work = (async () => {
      try {
        await writeFile(scratch, text, { mode: 0o600 });
        // a write made at once meanwhile (noteRecalled, flush) is newer than this one: leave it
        if (this.written >= version) await rm(scratch, { force: true });
        else {
          await rename(scratch, this.file);
          this.written = Math.max(this.written, version);
        }
        wrote = true;
      } catch (error) {
        this.log(`shared notes: could not save which conversations are the owner's: ${(error as Error).message}`);
        await rm(scratch, { force: true }).catch(() => undefined);
      }
    })().finally(() => {
      this.writing = null;
      // Changed again while this was being written: once more. A write that
      // failed is tried again with the next change, never in a loop.
      if (wrote && this.version > this.written) this.arm();
    });
    this.writing = work;
    return work;
  }

  /** Write the record now, on the calling request. False when it could not
   * be saved: the caller then acts as if the fact it wanted to record were
   * not known. */
  private saveNow(): boolean {
    const version = this.version;
    try {
      writeFileAtomic(this.file, this.text(), { mode: 0o600 });
      this.written = version;
      return true;
    } catch (error) {
      this.log(`shared notes: could not save which conversations are the owner's: ${(error as Error).message}`);
      return false;
    }
  }

  /** Write the record at once, after something the owner did by hand and is
   * told the result of (an adoption). False when it could not be written:
   * what was recorded then lasts until a restart. */
  writeNow(): boolean {
    return this.version > this.written ? this.saveNow() : true;
  }

  /** Write whatever is pending and wait for it: the server is shutting down
   * (or a test wants the file). Never rejects. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.writing;
    if (this.version > this.written) this.saveNow();
  }

  /** The owner's own request wrote this line. Call once per line, when it is written. */
  prove(threadId: string, messageId: string): void {
    const record = messageId ? this.record(threadId) : null;
    if (!record) return;
    record.lines += 1;
    xor(record.sum, lineHash(threadId, messageId));
    // In memory now, on disk in a moment: unsaved, the proof lasts until a
    // restart and the conversation is "not proven" after it.
    this.changed();
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

  /** The owner vouches for a conversation's older lines: the one way a line
   * written before proof began becomes the owner's (shared-notes-adopt.ts
   * decides which conversations may be offered). `older` are the lines and
   * answered cards from before `since`, `later` the ones since.
   *
   * - "already": the conversation is the owner's alone as it stands, or it
   *   was adopted before. It is left exactly as it is: adoption happens once
   *   and is never taken back or repeated, so a conversation that lost its
   *   standing after it was adopted stays without it.
   * - "later": something written since proof began is not on record. Nobody
   *   vouched for it then, and adopting does not vouch for it now.
   * - "empty": there is nothing older to adopt.
   * - "adopted": the record now holds every one of these lines. */
  adopt(threadId: string, older: readonly string[], later: readonly string[]): "adopted" | "already" | "later" | "empty" {
    const existing = this.threads.get(threadId);
    const all = [...older, ...later];
    if (existing?.adopted || (all.length > 0 && this.ownerOnly(threadId, all))) return "already";
    // every line since proof began must be exactly what is on record
    if (later.length ? !this.ownerOnly(threadId, later) : Boolean(existing && existing.lines > 0)) return "later";
    if (!older.length) return "empty";
    const record = this.record(threadId);
    if (!record || new Set(all).size !== all.length) return "later";
    for (const id of older) xor(record.sum, lineHash(threadId, id));
    record.lines += older.length;
    record.adopted = true;
    this.changed();
    return "adopted";
  }

  /** A shared note is about to be put in front of a turn of this
   * conversation. False when that could not be recorded: the note must then
   * not be recalled, because nothing would know to drop the session later. */
  noteRecalled(threadId: string): boolean {
    const record = this.record(threadId);
    if (!record) return false;
    if (record.recalled) return true;
    record.recalled = true;
    this.version += 1;
    // at once, and before the note is sent: this is the one fact that must not be lost
    if (this.saveNow()) return true;
    record.recalled = false;
    this.version += 1;
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
    this.changed();
  }
}
