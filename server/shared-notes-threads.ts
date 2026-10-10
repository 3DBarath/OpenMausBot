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
// Two files, both owner-only:
//
//   $OMB_DATA_DIR/shared-notes-threads.json   the record: the proofs
//   $OMB_DATA_DIR/shared-notes-proof.json     what an adoption must respect
//
// The second holds what must not go away with the record. `since` is the
// moment proof began here: a line older than it could not have been proven
// when it was written, and only such a line can be adopted
// (shared-notes-adopt.ts). It is written in both files and never worked out
// again while either one still says it. The second file also holds what
// rules a conversation out of adoption for good: the conversations an import
// from a backup brought in, the moment the whole installation was last put
// back from an archive, and the moment either file was last found missing or
// unreadable (`lostAt`). After such a loss nobody can tell an older line
// from a later one nobody vouched for, or a conversation that was already
// adopted and lost its standing from one that never was, so nothing that
// existed before the loss is adopted. A missing or damaged file never
// grants anything by being absent.
//
// Every message the owner sends records a proof, on every installation,
// whether or not it has any shared note. So a proof costs nothing on the
// request: it is kept in memory at once and the file is written a moment
// later, off the request path, many proofs to one write, and once more when
// the server shuts down (`flush`). A crash can lose the last moments of
// proof, and all that costs is that those conversations recall nothing.
// Written at once are the `recalled` mark (losing that would let a session
// that holds a note be handed on; it is set once per conversation, only
// where a note was actually recalled) and an adoption.
//
// Every write is a whole snapshot, written to a scratch file, synced to the
// disk and then renamed over the record (`commit`), so a power cut leaves
// the old record or the new one, never a torn one. The rename is the one
// synchronous step every write ends in, slow or immediate: it compares the
// snapshot with what is already there in the same breath, so a snapshot
// that was slow to reach the disk can never land on top of a newer one.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { renameWithRetry, writeFileAtomic } from "./atomic.ts";

/** How long proofs are gathered before the file is written. */
const WRITE_DELAY_MS = 250;

const THREAD = /^[\w-]{1,128}$/;
const SUM = /^[0-9a-f]{32}$/;
/** Oldest conversations go first past this; theirs become "not proven". */
const MAX_THREADS = 20_000;
/** Imported conversations named one by one; past this, everything before now is marked instead. */
const MAX_IMPORTED = 50_000;

/** What an adoption must respect (the second file, above). */
interface Anchor {
  since: number;
  /** A first start wrote this file and has not yet written the record. */
  fresh: boolean;
  lostAt: number | null;
  /** Everything from before this moment came from a backup. */
  restoredAt: number | null;
  /** The last restore of the whole installation this file has taken note of. */
  restore: string | null;
  /** An import of conversations began and has not said which ones it made. */
  importing: number | null;
  imported: Set<string>;
}

function moment(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A JSON object from a file, or null when it is absent, unreadable or anything else. */
function readObject(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readAnchor(file: string): Anchor | null {
  const raw = readObject(file);
  const since = moment(raw?.since);
  if (!raw || since === null) return null;
  const imported = Array.isArray(raw.imported) ? raw.imported.filter((id): id is string => typeof id === "string" && THREAD.test(id)) : [];
  return {
    since, fresh: raw.fresh === true, lostAt: moment(raw.lostAt), restoredAt: moment(raw.restoredAt),
    restore: typeof raw.restore === "string" && raw.restore ? raw.restore : null,
    importing: moment(raw.importing), imported: new Set(imported),
  };
}

function later(one: number | null, other: number): number {
  return one === null ? other : Math.max(one, other);
}

/** Remove a scratch file, whatever state it is in. Never throws. */
function discard(scratch: string): void {
  try {
    rmSync(scratch, { force: true });
  } catch {
    /* left where it is: the next start removes it */
  }
}

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
  private readonly anchorFile: string;
  private readonly anchor: Anchor;
  private readonly log: (line: string) => void;
  /** Goes up with every change; what is on disk is as of `written`. */
  private version = 0;
  private written = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  /** `restore` names the last time the whole installation was put back from
   * an archive, if it ever was (server/workspace-backup.ts keeps the
   * receipt): everything from before it came from that archive. */
  constructor(file: string, log: (line: string) => void = () => undefined, options: { anchor?: string; restore?: { id: string; at: number } | null } = {}) {
    this.file = file;
    this.log = log;
    this.anchorFile = options.anchor ?? join(dirname(file), "shared-notes-proof.json");
    // A run that was killed between writing a snapshot and renaming it left
    // its scratch file behind: those are removed here, so they never pile
    // up. Never this process's own, which may be a write under way.
    try {
      const prefix = `${basename(file)}.`;
      const mine = `${prefix}${process.pid}.`;
      for (const name of readdirSync(dirname(file))) {
        if (name.startsWith(prefix) && name.endsWith(".tmp") && !name.startsWith(mine)) discard(join(dirname(file), name));
      }
    } catch {
      /* no folder yet: nothing to clear */
    }
    const now = Date.now();
    const stored = readObject(file); // absent or unreadable: nothing is proven
    const threads = stored?.threads;
    if (threads && typeof threads === "object" && !Array.isArray(threads)) {
      for (const [threadId, value] of Object.entries(threads)) {
        if (!THREAD.test(threadId) || !Array.isArray(value)) continue;
        const [lines, sum, recalled, adopted] = value as unknown[];
        if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 0 || typeof sum !== "string" || !SUM.test(sum)) continue;
        this.threads.set(threadId, { lines, sum: Buffer.from(sum, "hex"), recalled: recalled === 1, adopted: adopted === 1 });
      }
    }
    const recorded = moment(stored?.since);
    const kept = readAnchor(this.anchorFile);
    // A first start has neither file. One that was cut short has the second
    // file, marked fresh, and perhaps the record. Anything else with a file
    // missing or unreadable is a loss: of the proofs, or of what rules a
    // conversation out of adoption.
    const first = kept ? kept.fresh : stored === null;
    const lost = !first && (kept === null || stored === null);
    // The moment proof began is whatever either file still says, the earlier
    // of the two where they differ (it leaves fewer lines to count as
    // older). Only a first start makes it now.
    const since = kept && recorded !== null ? Math.min(kept.since, recorded) : kept?.since ?? recorded ?? now;
    this.since = since;
    this.anchor = kept ? { ...kept, since } : { since, fresh: first, lostAt: null, restoredAt: null, restore: null, importing: null, imported: new Set() };
    let noted = first || lost || kept?.since !== since;
    if (lost) {
      this.anchor.lostAt = later(this.anchor.lostAt, now);
      log("shared notes: the record of which conversations are the owner's was missing or unreadable. Nothing is proven by that: conversations from before now recall no shared note until the owner writes in a new one, and they cannot be adopted.");
    }
    if (this.anchor.importing !== null) {
      // an import was under way when the server stopped: which conversations it made is not known
      this.anchor.restoredAt = later(this.anchor.restoredAt, now);
      this.anchor.importing = null;
      noted = true;
    }
    if (options.restore && options.restore.id !== this.anchor.restore) {
      this.anchor.restoredAt = later(this.anchor.restoredAt, moment(options.restore.at) ?? now);
      this.anchor.restore = options.restore.id;
      noted = true;
    }
    // On disk in an order that a crash at any point leaves readable for what
    // it is: the second file first, saying what was found (a first start, a
    // loss), then the record, then the first start is over.
    const anchored = noted ? this.saveAnchor() : true;
    const saved = stored === null || recorded !== since ? anchored && this.saveNow() : true;
    if (this.anchor.fresh && anchored && saved) {
      this.anchor.fresh = false;
      this.saveAnchor();
    }
  }

  /** When the record, or the file beside it, was last found missing or
   * unreadable: nothing that existed before then can be adopted. */
  get lostAt(): number | null {
    return this.anchor.lostAt;
  }

  /** Everything from before this moment came from a backup: the whole
   * installation was put back from an archive then, or an import of
   * conversations was cut short and what it made is not known. */
  get restoredAt(): number | null {
    return this.anchor.restoredAt;
  }

  /** Whether an import from a backup brought this conversation in. */
  imported(threadId: string): boolean {
    return this.anchor.imported.has(threadId);
  }

  /** Conversations are about to be brought in from a backup, beside the
   * ones already here. Call the answer with the conversations it made, or
   * with null when it made none (it failed and took back what it had done).
   * That an import is under way is on disk before it starts: a server that
   * stops in the middle marks everything, since it cannot name what came in. */
  importing(): (threadIds: readonly string[] | null) => void {
    const began = Date.now();
    this.anchor.importing = began;
    this.saveAnchor();
    return (threadIds) => {
      for (const threadId of threadIds ?? []) if (THREAD.test(threadId)) this.anchor.imported.add(threadId);
      if (this.anchor.imported.size > MAX_IMPORTED) {
        // too many to name: everything that exists now is marked instead
        this.anchor.imported.clear();
        this.anchor.restoredAt = later(this.anchor.restoredAt, Date.now());
      }
      if (this.anchor.importing === began) this.anchor.importing = null;
      this.saveAnchor();
    };
  }

  private saveAnchor(): boolean {
    const { since, fresh, lostAt, restoredAt, restore, importing, imported } = this.anchor;
    const text = `${JSON.stringify({
      version: 1, since, ...(fresh ? { fresh: true } : {}), ...(lostAt !== null ? { lostAt } : {}), ...(restoredAt !== null ? { restoredAt } : {}),
      ...(restore ? { restore } : {}), ...(importing !== null ? { importing } : {}), ...(imported.size ? { imported: [...imported] } : {}),
    })}\n`;
    try {
      writeFileAtomic(this.anchorFile, text, { mode: 0o600 });
      return true;
    } catch (error) {
      this.log(`shared notes: could not save what an adoption must respect: ${(error as Error).message}`);
      return false;
    }
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

  private scratch(): string {
    return `${this.file}.${process.pid}.${randomUUID()}.tmp`;
  }

  /** The one way a snapshot becomes the record, for every write. The
   * snapshot is already on the disk, synced, in a scratch file. One
   * synchronous step, so nothing can come between the comparison and the
   * rename: a snapshot older than what the record already holds is thrown
   * away, and the rest land in the order they were taken. (Every change
   * raises `version`, so two snapshots of one version are the same bytes.) */
  private commit(scratch: string, version: number): void {
    if (this.written > version) {
      discard(scratch);
      return;
    }
    renameWithRetry(scratch, this.file);
    this.written = version;
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

  /** Write the file without holding the server up: the slow part (the bytes
   * and the sync) happens off the request path, the commit is one quick
   * step. Never rejects. */
  private writeLater(): Promise<void> {
    if (this.writing) return this.writing;
    const version = this.version;
    const text = this.text();
    const scratch = this.scratch();
    let wrote = false;
    const work = (async () => {
      try {
        const handle = await open(scratch, "wx", 0o600);
        try {
          await handle.writeFile(text);
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.commit(scratch, version);
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
    const scratch = this.scratch();
    let fd: number | null = null;
    try {
      fd = openSync(scratch, "wx", 0o600);
      writeFileSync(fd, this.text());
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      // taken and committed in one go, so it is never older than what the record holds
      this.commit(scratch, version);
      return true;
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* the write already failed */
        }
      }
      discard(scratch);
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
   * answered cards from before `since`, `later` the ones since. `held` is a
   * reason outside the lines that rules the conversation out: it came from
   * a backup, or it is from before the record was lost.
   *
   * - "already": the conversation is the owner's alone as it stands, or it
   *   was adopted before. It is left exactly as it is: adoption happens once
   *   and is never taken back or repeated, so a conversation that lost its
   *   standing after it was adopted stays without it.
   * - "restored", "lost": `held`, given back. Nothing is recorded.
   * - "later": something written since proof began is not on record. Nobody
   *   vouched for it then, and adopting does not vouch for it now.
   * - "empty": there is nothing older to adopt.
   * - "adopted": the record now holds every one of these lines. */
  adopt<Held extends string = never>(threadId: string, older: readonly string[], later: readonly string[], held?: Held): "adopted" | "already" | "later" | "empty" | Held {
    const existing = this.threads.get(threadId);
    const all = [...older, ...later];
    if (existing?.adopted || (all.length > 0 && this.ownerOnly(threadId, all))) return "already";
    if (held) return held;
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
