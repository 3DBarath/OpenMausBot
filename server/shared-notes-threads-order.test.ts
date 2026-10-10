// The record of the owner's conversations is written two ways: a moment
// after a proof, without holding the server up, and at once for the facts
// that must not be lost (a session now holds a note; an adoption). Whatever
// order the disk finishes them in, an older snapshot must never land on top
// of a newer one, and a snapshot is synced before it takes the file's place.
//
// The slow disk is made here: the last slow step of a delayed write (its
// rename, or the sync before it) waits until the test lets it go.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => {
  const state = {
    steps: [] as string[],
    held: null as null | { reached: () => void; wait: Promise<void>; release: () => void },
    async slow(): Promise<void> {
      const held = state.held;
      if (!held) return;
      held.reached();
      await held.wait;
    },
    /** From now on the next slow step waits. `reached` settles when a write is waiting there. */
    hold(): { reached: Promise<void>; release: () => void } {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      state.held = { reached, wait, release };
      return { reached: arrived, release: () => { state.held = null; release(); } };
    },
  };
  return state;
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const mocked = {
    ...actual,
    async rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
      await disk.slow();
      disk.steps.push("rename");
      return actual.rename(from, to);
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      disk.steps.push("write");
      return actual.writeFile(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = (async (...input: Parameters<typeof write>) => {
        disk.steps.push("write");
        return write(...input);
      }) as typeof handle.writeFile;
      handle.sync = async () => {
        await disk.slow();
        disk.steps.push("sync");
        return sync();
      };
      return handle;
    },
  };
  return { ...mocked, default: mocked };
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const mocked = {
    ...actual,
    renameSync(from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) {
      disk.steps.push("rename");
      return actual.renameSync(from, to);
    },
    fsyncSync(fd: number) {
      disk.steps.push("sync");
      return actual.fsyncSync(fd);
    },
  };
  return { ...mocked, default: mocked };
});

// the test setup has already loaded the modules that write files: load them again, over the disk above
vi.resetModules();
const { OwnerThreads } = await import("./shared-notes-threads.ts");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-owner-threads-order-"));
  file = join(dir, "shared-notes-threads.json");
  disk.held = null;
  disk.steps.length = 0;
});
afterEach(() => {
  disk.held?.release();
  disk.held = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("the order the record's writes land in", () => {
  it("keeps the mark that a session holds a note when a slower, older write finishes after it", async () => {
    const record = new OwnerThreads(file);
    const slow = disk.hold();
    // a proof: written a moment later, and that write is now stuck on a slow disk
    record.prove("t1", "m1");
    await slow.reached;
    // meanwhile a note is recalled: the mark is written at once and is on disk
    expect(record.noteRecalled("t1")).toBe(true);
    expect(new OwnerThreads(file).recalled("t1")).toBe(true);
    // the slow write finishes last, carrying a snapshot from before the mark
    slow.release();
    await record.flush();
    const after = new OwnerThreads(file);
    expect(after.recalled("t1")).toBe(true);
    expect(after.ownerOnly("t1", ["m1"])).toBe(true);
  });

  it("keeps an adoption written at once when a slower, older write finishes after it", async () => {
    const record = new OwnerThreads(file);
    const slow = disk.hold();
    record.prove("t1", "m1");
    await slow.reached;
    expect(record.adopt("t2", ["old-1", "old-2"], [])).toBe("adopted");
    expect(record.writeNow()).toBe(true);
    expect(new OwnerThreads(file).ownerOnly("t2", ["old-1", "old-2"])).toBe(true);
    slow.release();
    await record.flush();
    const after = new OwnerThreads(file);
    expect(after.ownerOnly("t2", ["old-1", "old-2"])).toBe(true);
    expect(after.ownerOnly("t1", ["m1"])).toBe(true);
  });

  it("still writes what changed while a slow write was under way", async () => {
    const record = new OwnerThreads(file);
    const slow = disk.hold();
    record.prove("t1", "m1");
    await slow.reached;
    // a second proof arrives while the first write is stuck; nothing is written at once
    record.prove("t1", "m2");
    slow.release();
    // without a shutdown: the write that was under way lands, then one more carries the second proof
    await expect.poll(() => new OwnerThreads(file).ownerOnly("t1", ["m1", "m2"]), { timeout: 10_000, interval: 50 }).toBe(true);
  });

  it("syncs every snapshot to the disk before it takes the record's place", async () => {
    const record = new OwnerThreads(file);
    const first = [...disk.steps];
    const written = (from: number): string[] => disk.steps.slice(from);
    // the delayed write: written, synced, and only then renamed over the record
    let from = disk.steps.length;
    record.prove("t1", "m1");
    await expect.poll(() => written(from).includes("rename"), { timeout: 10_000, interval: 25 }).toBe(true);
    expect(written(from)).toEqual(["write", "sync", "rename"]);
    // the write made at once
    from = disk.steps.length;
    expect(record.noteRecalled("t1")).toBe(true);
    expect(written(from)).toEqual(["sync", "rename"]);
    // and a first start: the file beside the record, the record, then that file again, each synced before its rename
    expect(first).toEqual(["sync", "rename", "sync", "rename", "sync", "rename"]);
  });
});
