import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HoldShots } from "./browser-commit-shots.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await removeTempDir(dir); });

/** A data directory with an attachments folder, as the server has it. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-hold-shots-"));
  scratch.push(dir);
  const attachments = join(dir, "attachments");
  mkdirSync(attachments);
  const removed: string[] = [];
  const ledger = join(dir, "browser-hold-shots.json");
  const open = () => new HoldShots(ledger, attachments, (path) => { removed.push(path); });
  const picture = (name: string) => { const path = join(attachments, name); writeFileSync(path, "jpeg"); return path; };
  return { dir, attachments, ledger, removed, open, picture };
}
const SHOT = "123e4567-e89b-12d3-a456-426614174000.jpg";
const OTHER = "223e4567-e89b-12d3-a456-426614174000.jpg";

describe("the screenshots open commit cards are showing", () => {
  it("lists a picture while its card is open, and forgets it when the card settles", () => {
    const f = fixture();
    const shots = f.open();
    const path = f.picture(SHOT);
    expect(shots.keep(path)).toBe(path);
    expect(JSON.parse(readFileSync(f.ledger, "utf8"))).toEqual([SHOT]);
    shots.drop(path);
    expect(f.removed).toEqual([path]);
    expect(JSON.parse(readFileSync(f.ledger, "utf8"))).toEqual([]);
  });

  // A server that stops mid-hold never settles the card, so nothing deletes
  // its picture. The next start does.
  it("deletes at the next start every picture a stopped server left behind", () => {
    const f = fixture();
    const before = f.open();
    const left = [before.keep(f.picture(SHOT)), before.keep(f.picture(OTHER))];
    const kept = f.picture("323e4567-e89b-12d3-a456-426614174000.jpg");
    // The server stops here. A new one starts on the same data.
    const after = f.open();
    expect(after.sweep()).toBe(2);
    expect(f.removed.sort()).toEqual(left.sort());
    expect(f.removed).not.toContain(kept);
    expect(JSON.parse(readFileSync(f.ledger, "utf8"))).toEqual([]);
    expect(after.sweep()).toBe(0);
  });

  it("deletes nothing at a first start, and nothing a damaged list names outside the attachments folder", () => {
    const f = fixture();
    expect(f.open().sweep()).toBe(0);
    expect(existsSync(f.ledger)).toBe(false);
    writeFileSync(join(f.dir, "config.json"), "{}");
    for (const damaged of ["not json", JSON.stringify({ shots: [SHOT] }), JSON.stringify(["../config.json", "/etc/hosts", "notes.txt", 7, null, `sub/${SHOT}`])]) {
      writeFileSync(f.ledger, damaged);
      expect(f.open().sweep(), damaged).toBe(0);
    }
    expect(f.removed).toEqual([]);
    expect(existsSync(join(f.dir, "config.json"))).toBe(true);
  });

  it("gives up the picture when it cannot be listed: one that would never be deleted is not shown", () => {
    const f = fixture();
    const path = f.picture(SHOT);
    const shots = new HoldShots(join(f.dir, "no-such-folder", "list.json"), f.attachments, (removed) => { f.removed.push(removed); });
    expect(() => shots.keep(path)).toThrow();
    expect(f.removed).toEqual([path]);
  });

  it("refuses to list a path that is not a picture in the attachments folder", () => {
    const f = fixture();
    const shots = f.open();
    expect(() => shots.keep(join(f.dir, "config.json"))).toThrow(/not a screenshot/);
    expect(() => shots.keep(join(f.attachments, "notes.txt"))).toThrow(/not a screenshot/);
    expect(f.removed).toEqual([]);
  });
});
