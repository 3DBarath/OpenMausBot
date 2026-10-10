// Which conversations are provably the owner's alone: only lines the
// owner's own request wrote are on record, a conversation with any other
// line is "not proven", and nothing is ever proven by a file being absent,
// damaged or unwritable.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OwnerThreads } from "./shared-notes-threads.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-owner-threads-"));
  file = join(dir, "shared-notes-threads.json");
});
afterEach(() => {
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

  it("keeps the record across a restart, with no line id and no text in the file", () => {
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
});
