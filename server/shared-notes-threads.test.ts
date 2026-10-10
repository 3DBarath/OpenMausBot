// Which conversations are provably the owner's alone: only lines the
// owner's own request wrote are on record, a conversation with any other
// line is "not proven", and nothing is ever proven by a file being absent,
// damaged or unwritable.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerThreads } from "./shared-notes-threads.ts";

let dir: string;
let file: string;
/** Where the moment proof began is kept, apart from the record. */
let anchor: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-owner-threads-"));
  file = join(dir, "shared-notes-threads.json");
  anchor = join(dir, "shared-notes-proof.json");
});
afterEach(() => {
  vi.useRealTimers();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("the owner's conversations", () => {
  it("is the owner's alone only when every line a person wrote is on record", () => {
    const threads = new OwnerThreads(file);
    // nothing on record proves nothing, whatever the conversation holds
    expect(threads.ownerOnly("t1", [])).toBe(false);
    expect(threads.ownerOnly("t1", ["m1"])).toBe(false);
    threads.prove("t1", "m1");
    expect(threads.ownerOnly("t1", ["m1"])).toBe(true);
    threads.prove("t1", "m2");
    expect(threads.ownerOnly("t1", ["m1", "m2"])).toBe(true);
    expect(threads.ownerOnly("t1", ["m2", "m1"])).toBe(true);
    // a line nobody vouched for: a guest's, an edit by someone else, a routine's prompt, an older line
    expect(threads.ownerOnly("t1", ["m1", "m2", "guest"])).toBe(false);
    expect(threads.ownerOnly("t1", ["m1", "guest"])).toBe(false);
    expect(threads.ownerOnly("t1", ["m1"])).toBe(false);
    expect(threads.ownerOnly("t1", ["m1", "m1"])).toBe(false);
    // and proof for one conversation is none for another
    expect(threads.ownerOnly("t2", ["m1", "m2"])).toBe(false);
    // once the stranger's line is gone (the conversation no longer holds it) it is the owner's again
    expect(threads.ownerOnly("t1", ["m1", "m2"])).toBe(true);
  });

  it("keeps the record across a restart, with no line id and no text in the file", async () => {
    const before = new OwnerThreads(file);
    before.prove("thread-a", "message-one");
    before.prove("thread-a", "message-two");
    expect(before.noteRecalled("thread-a")).toBe(true);
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain("message-one");
    const after = new OwnerThreads(file);
    expect(after.ownerOnly("thread-a", ["message-one", "message-two"])).toBe(true);
    expect(after.ownerOnly("thread-a", ["message-one", "message-two", "later"])).toBe(false);
    expect(after.recalled("thread-a")).toBe(true);
    after.sessionDropped("thread-a");
    await after.flush();
    expect(new OwnerThreads(file).recalled("thread-a")).toBe(false);
  });

  it("proves nothing from a missing, damaged or foreign-shaped file", () => {
    expect(new OwnerThreads(join(dir, "absent.json")).ownerOnly("t1", ["m1"])).toBe(false);
    for (const text of ["{ not json", "[]", '{"threads": []}', '{"threads": {"t1": "yes"}}', '{"threads": {"t1": [1, "short", 1]}}', '{"threads": {"t1": [-1, "00000000000000000000000000000000", 0]}}']) {
      writeFileSync(file, text);
      const threads = new OwnerThreads(file);
      expect(threads.ownerOnly("t1", ["m1"]), text).toBe(false);
      expect(threads.recalled("t1"), text).toBe(false);
    }
    // a record that claims one line with an empty sum matches no real line
    writeFileSync(file, '{"version":1,"threads":{"t1":[1,"00000000000000000000000000000000",0]}}');
    expect(new OwnerThreads(file).ownerOnly("t1", ["m1"])).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses to recall where it cannot record that it did, and says so", () => {
    const lines: string[] = [];
    const threads = new OwnerThreads(file, (line) => lines.push(line));
    threads.prove("t1", "m1");
    chmodSync(dir, 0o500);
    // the mark could not be saved: no note may go into a session nothing would know to drop
    expect(threads.noteRecalled("t1")).toBe(false);
    expect(threads.recalled("t1")).toBe(false);
    // a proof that could not be saved lasts for this run and is gone after a restart
    threads.prove("t1", "m2");
    expect(threads.ownerOnly("t1", ["m1", "m2"])).toBe(true);
    expect(new OwnerThreads(file).ownerOnly("t1", ["m1", "m2"])).toBe(false);
    expect(lines.join("\n")).toMatch(/could not save/);
  });

  it("ignores a conversation id that is not one", () => {
    const threads = new OwnerThreads(file);
    threads.prove("../etc", "m1");
    threads.prove("t1", "");
    expect(threads.ownerOnly("../etc", ["m1"])).toBe(false);
    expect(threads.noteRecalled("../etc")).toBe(false);
  });

  it("writes the record off the request path: many lines become one write, and a shutdown flushes it", async () => {
    // an installation with 20,000 conversations on record
    const threads: Record<string, [number, string, number]> = {};
    for (let index = 0; index < 20_000; index += 1) threads[`thread-${index}`] = [3, "0123456789abcdef0123456789abcdef", 0];
    writeFileSync(file, JSON.stringify({ version: 1, since: 1_700_000_000_000, threads }));
    const before = readFileSync(file, "utf8");
    const record = new OwnerThreads(file);
    expect(record.since).toBe(1_700_000_000_000);
    const started = process.cpuUsage();
    for (let index = 0; index < 300; index += 1) record.prove("busy-thread", `message-${index}`);
    const spent = process.cpuUsage(started);
    // nothing was written while the lines were being recorded, and recording them cost next to nothing
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((spent.user + spent.system) / 1000).toBeLessThan(300);
    // the proof holds at once, in memory
    expect(record.ownerOnly("busy-thread", Array.from({ length: 300 }, (_, index) => `message-${index}`))).toBe(true);
    // a shutdown writes what is pending
    await record.flush();
    const after = new OwnerThreads(file);
    expect(after.ownerOnly("busy-thread", Array.from({ length: 300 }, (_, index) => `message-${index}`))).toBe(true);
    // and without a shutdown it is written by itself a moment later
    record.prove("later-thread", "m1");
    await expect.poll(() => new OwnerThreads(file).ownerOnly("later-thread", ["m1"]), { timeout: 10_000, interval: 50 }).toBe(true);
  });

  it("writes the mark that a session holds a note at once, because losing it would hand the session on", () => {
    const record = new OwnerThreads(file);
    // a first start writes down when proof began, and nothing else
    const fresh = readFileSync(file, "utf8");
    expect(JSON.parse(fresh)).toEqual({ version: 1, since: record.since, threads: {} });
    record.prove("t1", "m1");
    expect(readFileSync(file, "utf8")).toBe(fresh);
    expect(record.noteRecalled("t1")).toBe(true);
    // on disk before the note is sent, with the proofs made so far
    const saved = new OwnerThreads(file);
    expect(saved.recalled("t1")).toBe(true);
    expect(saved.ownerOnly("t1", ["m1"])).toBe(true);
  });

  it("keeps the moment proof began across restarts, and a file that does not say gets this one", () => {
    const first = new OwnerThreads(file);
    expect(first.since).toBeGreaterThan(Date.now() - 5_000);
    expect(new OwnerThreads(file).since).toBe(first.since);
    // a record from before the moment was kept: proof for its lines stands, and "since" is now
    writeFileSync(file, '{"version":1,"threads":{}}');
    const later = new OwnerThreads(file);
    expect(later.since).toBeGreaterThanOrEqual(first.since);
    expect(JSON.parse(readFileSync(file, "utf8")).since).toBe(later.since);
  });

  // The moment proof began decides which lines count as older, and older
  // lines are the ones an adoption may take. So it is never worked out again
  // from a record that has gone: it is kept in a file of its own.
  it("does not begin proof again when the record is lost: the moment is kept apart from it, and the loss is remembered", async () => {
    const T0 = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const first = new OwnerThreads(file);
    first.prove("t1", "m1");
    await first.flush();
    expect(first.since).toBe(T0);
    // the record goes missing (deleted, a disk that lost it), and the server starts again later
    rmSync(file);
    vi.setSystemTime(T0 + 500_000);
    const lines: string[] = [];
    const after = new OwnerThreads(file, (line) => lines.push(line));
    expect(after.since).toBe(T0);
    expect(first.lostAt).toBeNull();
    expect(after.lostAt).toBe(T0 + 500_000);
    expect(lines.join("\n")).toMatch(/missing or unreadable/);
    // nothing is proven by the loss, and the record exists again
    expect(after.ownerOnly("t1", ["m1"])).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, since: T0, threads: {} });
    // the next start finds a record, and still knows there was a loss and when
    vi.setSystemTime(T0 + 600_000);
    const again = new OwnerThreads(file);
    expect(again.since).toBe(T0);
    expect(again.lostAt).toBe(T0 + 500_000);
    // a record that cannot be read is a lost one too, and the later loss is the one kept
    writeFileSync(file, "{ torn");
    vi.setSystemTime(T0 + 700_000);
    const torn = new OwnerThreads(file);
    expect(torn.since).toBe(T0);
    expect(torn.lostAt).toBe(T0 + 700_000);
  });

  it("reads the loss of the file beside the record as a loss too, and takes the moment from the record", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const first = new OwnerThreads(file);
    first.importing()(["t-in"]);
    expect(first.noteRecalled("t1")).toBe(true);
    // what rules conversations out of adoption went with that file: nothing from before now is adopted
    rmSync(anchor);
    vi.setSystemTime(1_700_000_900_000);
    const after = new OwnerThreads(file);
    expect(after.since).toBe(1_700_000_000_000);
    expect(after.lostAt).toBe(1_700_000_900_000);
    // the proofs were not lost
    expect(after.recalled("t1")).toBe(true);
    expect(JSON.parse(readFileSync(anchor, "utf8"))).toEqual({ version: 1, since: 1_700_000_000_000, lostAt: 1_700_000_900_000 });
    // where the two files disagree the earlier moment stands: it leaves fewer lines to count as older
    writeFileSync(anchor, JSON.stringify({ version: 1, since: 1_600_000_000_000 }));
    const earlier = new OwnerThreads(file);
    expect(earlier.since).toBe(1_600_000_000_000);
    expect(JSON.parse(readFileSync(file, "utf8")).since).toBe(1_600_000_000_000);
    writeFileSync(file, JSON.stringify({ version: 1, since: 1_500_000_000_000, threads: {} }));
    expect(new OwnerThreads(file).since).toBe(1_500_000_000_000);
    expect(JSON.parse(readFileSync(anchor, "utf8")).since).toBe(1_500_000_000_000);
  });

  it("finishes a first start that was cut short between the two files, and that is no loss", () => {
    const first = new OwnerThreads(file);
    expect(first.lostAt).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, since: first.since, threads: {} });
    expect(JSON.parse(readFileSync(anchor, "utf8"))).toEqual({ version: 1, since: first.since });
    // the server died after the first file and before the record
    rmSync(file);
    writeFileSync(anchor, JSON.stringify({ version: 1, since: 1_700_000_000_000, fresh: true }));
    const resumed = new OwnerThreads(file);
    expect(resumed.since).toBe(1_700_000_000_000);
    expect(resumed.lostAt).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(anchor, "utf8"))).toEqual({ version: 1, since: 1_700_000_000_000 });
    // or after the record and before the first start was marked over
    writeFileSync(anchor, JSON.stringify({ version: 1, since: 1_700_000_000_000, fresh: true }));
    expect(new OwnerThreads(file).lostAt).toBeNull();
    expect(JSON.parse(readFileSync(anchor, "utf8"))).toEqual({ version: 1, since: 1_700_000_000_000 });
    // once the first start is over, a record that is gone is a loss
    rmSync(file);
    expect(new OwnerThreads(file).lostAt).not.toBeNull();
  });

  it("clears the scratch files a killed run left behind, and nothing else", () => {
    new OwnerThreads(file);
    // an earlier run's process is never this one
    const earlier = process.pid + 1;
    const stale = [`${file}.${earlier}.11111111-1111-4111-8111-111111111111.tmp`, `${file}.${earlier + 1}.22222222-2222-4222-8222-222222222222.tmp`];
    for (const path of stale) writeFileSync(path, "{ half a snapshot");
    const other = join(dir, "something-else.json.1.tmp");
    writeFileSync(other, "not ours");
    // a write of this process that is under way is left alone
    const live = `${file}.${process.pid}.33333333-3333-4333-8333-333333333333.tmp`;
    writeFileSync(live, "{ being written");
    const after = new OwnerThreads(file);
    for (const path of stale) expect(existsSync(path), path).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(anchor)).toBe(true);
    expect(after.lostAt).toBeNull();
  });

  // Conversations that came in from a backup were never written through a
  // person's request here. Those brought in beside the others are marked one
  // by one; a restore of the whole installation marks everything before it.
  it("remembers which conversations an import brought in, apart from the record and across its loss", () => {
    const first = new OwnerThreads(file);
    expect(first.imported("t-in")).toBe(false);
    const done = first.importing();
    done(["t-in", "t-in-2", "../not-a-thread"]);
    expect(first.imported("t-in")).toBe(true);
    expect(first.imported("t-mine")).toBe(false);
    expect(first.restoredAt).toBeNull();
    rmSync(file);
    const after = new OwnerThreads(file);
    expect(after.imported("t-in")).toBe(true);
    expect(after.imported("t-in-2")).toBe(true);
    expect(after.imported("../not-a-thread")).toBe(false);
    expect(after.restoredAt).toBeNull();
  });

  it("marks everything when an import was cut short or nobody said which conversations it made", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const first = new OwnerThreads(file);
    // the import started and the server died before it finished
    first.importing();
    vi.setSystemTime(1_700_000_100_000);
    const after = new OwnerThreads(file);
    expect(after.restoredAt).toBe(1_700_000_100_000);
    // one that failed and took back what it made marks nothing more
    vi.setSystemTime(1_700_000_200_000);
    after.importing()(null);
    expect(new OwnerThreads(file).restoredAt).toBe(1_700_000_100_000);
  });

  it("marks everything from before a restore of the whole installation, once per restore", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    expect(new OwnerThreads(file).restoredAt).toBeNull();
    // the installation was replaced from an archive at this moment
    const restore = { id: "11111111-1111-4111-8111-111111111111", at: 1_700_000_050_000 };
    vi.setSystemTime(1_700_000_060_000);
    expect(new OwnerThreads(file, undefined, { restore }).restoredAt).toBe(1_700_000_050_000);
    // every later start names the same restore: nothing moves
    vi.setSystemTime(1_700_000_070_000);
    expect(new OwnerThreads(file, undefined, { restore: { ...restore, at: 1_700_000_069_000 } }).restoredAt).toBe(1_700_000_050_000);
    // the archive may bring its own files: a restore they do not know is a new one
    writeFileSync(anchor, JSON.stringify({ version: 1, since: 1_600_000_000_000 }));
    expect(new OwnerThreads(file, undefined, { restore }).restoredAt).toBe(1_700_000_050_000);
    // a second restore moves the mark forward, never back
    const second = { id: "22222222-2222-4222-8222-222222222222", at: 1_700_000_065_000 };
    expect(new OwnerThreads(file, undefined, { restore: second }).restoredAt).toBe(1_700_000_065_000);
    expect(new OwnerThreads(file, undefined, { restore: { id: "33333333-3333-4333-8333-333333333333", at: 1_650_000_000_000 } }).restoredAt).toBe(1_700_000_065_000);
    // a time the caller could not read is "now"
    vi.setSystemTime(1_700_000_080_000);
    expect(new OwnerThreads(file, undefined, { restore: { id: "44444444-4444-4444-8444-444444444444", at: Number.NaN } }).restoredAt).toBe(1_700_000_080_000);
  });
});
