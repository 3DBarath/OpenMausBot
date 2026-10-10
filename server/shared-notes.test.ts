// The shared notes store: the entry line, the name gate, both caps, the
// scrub, owner-only modes, and "delete everything imported".
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { parseMemoryEntries } from "./memory-entries.ts";
import {
  appendSharedEntries, deleteImportedEntries, deleteSharedNote, describeSharedNotes, listSharedNotes, readSharedNote,
  SHARED_NOTE_MAX_BYTES, SHARED_NOTES_MAX_FILES, sharedNoteEntry, sharedNoteFileName, sharedNoteIdentities, sharedNotesDir,
  SharedNotesError, writeSharedNote,
} from "./shared-notes.ts";

const entry = (text: string, until?: string) => sharedNoteEntry(text, { date: "2025-03-02", origin: "ChatGPT", ...(until ? { until } : {}) });

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the entry line and the file name", () => {
  it("writes a dated entry that ends with its import mark and still parses as a memory entry", () => {
    expect(entry("The person  is vegetarian")).toBe("- 2025-03-02 · The person is vegetarian (imported · ChatGPT)");
    const timed = entry("Staying in Goa", "2099-01-05");
    expect(timed).toBe("- 2025-03-02 · Staying in Goa (imported · ChatGPT) · until 2099-01-05");
    expect(parseMemoryEntries(timed)[0]).toMatchObject({ date: "2025-03-02", until: "2099-01-05", body: "Staying in Goa (imported · ChatGPT)" });
    expect(sharedNoteEntry("x", { date: "2025-03-02", origin: "Evil) · until 2000-01-01 (" })).toBe("- 2025-03-02 · x (imported · Evil until 2000-01-01)");
  });

  it("names a file from the subject, with a fallback for a reserved or empty one", () => {
    expect(sharedNoteFileName("Food")).toBe("food.md");
    expect(sharedNoteFileName("About me, continued")).toBe("about-me-continued.md");
    expect(sharedNoteFileName("archive")).toBe("archive-notes.md");
    expect(sharedNoteFileName("!!!")).toBe("notes.md");
  });
});

describe("appending entries", () => {
  it("creates the note with a header, owner-only, and merges later entries and aliases", () => {
    expect(appendSharedEntries({ subject: "Food", aliases: ["restaurants", "dinner"], lines: [entry("The person is vegetarian")] }))
      .toEqual({ name: "food.md", added: 1, dropped: 0 });
    expect(readSharedNote("food.md")).toBe("---\ntitle: Food\naliases: [restaurants, dinner]\n---\n\n- 2025-03-02 · The person is vegetarian (imported · ChatGPT)\n");
    if (process.platform !== "win32") {
      expect(statSync(join(sharedNotesDir(), "food.md")).mode & 0o777).toBe(0o600);
      expect(statSync(sharedNotesDir()).mode & 0o777).toBe(0o700);
    }
    appendSharedEntries({ subject: "food", aliases: ["lunch"], lines: [entry("The person loves Irani cafes")] });
    const text = readSharedNote("food.md")!;
    expect(text).toContain("aliases: [restaurants, dinner, lunch]");
    expect(text.trim().split("\n").at(-1)).toBe("- 2025-03-02 · The person loves Irani cafes (imported · ChatGPT)");
    expect(listSharedNotes().map((note) => note.name)).toEqual(["food.md"]);
    // a title keeps its comma; an alias loses what would break the list it sits in
    appendSharedEntries({ subject: "About me,\ncontinued", aliases: ["a, b", "[c]"], lines: [entry("Short fact")] });
    expect(readSharedNote("about-me-continued.md")).toBe("---\ntitle: About me, continued\naliases: [a b, c]\n---\n\n- 2025-03-02 · Short fact (imported · ChatGPT)\n");
    expect(describeSharedNotes().find((note) => note.name === "about-me-continued.md")).toMatchObject({ title: "About me, continued", aliases: ["a b", "c"] });
  });

  it("leaves out a fact the note already holds, imported or written by hand", () => {
    writeSharedNote("food.md", "---\ntitle: Food\n---\n\n- The person is vegetarian\n- 2025-01-01 · Hates olives (imported · Claude)\n");
    const result = appendSharedEntries({ subject: "Food", aliases: [], lines: [entry("The person is vegetarian."), entry("Hates olives"), entry("Hates olives"), entry("Loves pasta")] });
    expect(result).toEqual({ name: "food.md", added: 1, dropped: 0 });
    expect(sharedNoteIdentities()).toEqual(new Set(["The person is vegetarian", "Hates olives", "Loves pasta"]));
  });

  it("redacts a credential before it reaches the file", () => {
    appendSharedEntries({ subject: "Work", aliases: [], lines: [entry("The deploy key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")] });
    const text = readSharedNote("work.md")!;
    expect(text).not.toContain("sk-ant-api03-AAAA");
    expect(text).toContain("redacted");
  });

  it("stops at 64 KB per note and says how many lines did not fit", () => {
    const lines = Array.from({ length: 400 }, (_, index) => entry(`Fact number ${index} ${"x".repeat(250)}`));
    const result = appendSharedEntries({ subject: "Big", aliases: [], lines });
    expect(result.reason).toBe("bytes");
    expect(result.added).toBeGreaterThan(100);
    expect(result.added + result.dropped).toBe(400);
    const bytes = Buffer.byteLength(readSharedNote("big.md")!, "utf8");
    expect(bytes).toBeLessThanOrEqual(SHARED_NOTE_MAX_BYTES);
    // a full note takes nothing more, and keeps what it has
    expect(appendSharedEntries({ subject: "Big", aliases: [], lines: [entry(`One more ${"y".repeat(280)}`)] })).toMatchObject({ added: 0, dropped: 1, reason: "bytes" });
    expect(Buffer.byteLength(readSharedNote("big.md")!, "utf8")).toBe(bytes);
  });

  it("stops at 200 notes, and still adds to a note that exists", () => {
    mkdirSync(sharedNotesDir(), { recursive: true });
    for (let index = 0; index < SHARED_NOTES_MAX_FILES; index += 1) writeFileSync(join(sharedNotesDir(), `subject-${index}.md`), "- a fact\n");
    expect(appendSharedEntries({ subject: "One too many", aliases: [], lines: [entry("New fact")] })).toEqual({ name: "one-too-many.md", added: 0, dropped: 1, reason: "files" });
    expect(readSharedNote("one-too-many.md")).toBeNull();
    expect(appendSharedEntries({ subject: "subject 3", aliases: [], lines: [entry("New fact")] })).toMatchObject({ name: "subject-3.md", added: 1 });
    expect(() => writeSharedNote("another.md", "- x\n")).toThrowError(SharedNotesError);
  });
});

describe("reading, writing and deleting one note", () => {
  it("refuses a name that is not one plain .md file", () => {
    for (const name of ["../config.md", "a/b.md", ".hidden.md", "notes.txt", ""]) {
      expect(readSharedNote(name), name).toBeNull();
      expect(deleteSharedNote(name), name).toBe(false);
      expect(() => writeSharedNote(name, "x"), name).toThrowError(SharedNotesError);
    }
  });

  it("refuses a note over the size cap and never reads through a link", () => {
    expect(() => writeSharedNote("big.md", "x".repeat(SHARED_NOTE_MAX_BYTES + 1))).toThrowError(/64 KB/);
    if (process.platform === "win32") return;
    mkdirSync(sharedNotesDir(), { recursive: true });
    writeFileSync(join(DATA_DIR, "secret.txt"), "the secret");
    symlinkSync(join(DATA_DIR, "secret.txt"), join(sharedNotesDir(), "link.md"));
    expect(readSharedNote("link.md")).toBeNull();
    expect(listSharedNotes()).toEqual([]);
  });

  it("writes, describes and deletes", () => {
    writeSharedNote("family.md", "---\ntitle: Family\naliases: [sister, asha]\n---\n\n- 2025-01-01 · Sister Asha lives in Delhi (imported · Claude)\n- Mother's birthday is in May\n");
    expect(describeSharedNotes()).toEqual([{ name: "family.md", title: "Family", aliases: ["sister", "asha"], bytes: Buffer.byteLength(readFileSync(join(sharedNotesDir(), "family.md"))), entries: 1, imported: 1 }]);
    expect(deleteSharedNote("family.md")).toBe(true);
    expect(deleteSharedNote("family.md")).toBe(false);
    expect(describeSharedNotes()).toEqual([]);
  });
});

describe("delete everything imported", () => {
  it("removes imported entries, keeps hand-written lines, and deletes a note left empty", () => {
    appendSharedEntries({ subject: "Food", aliases: ["dinner"], lines: [entry("The person is vegetarian"), entry("Staying in Goa", "2099-01-05")] });
    writeSharedNote("family.md", "---\ntitle: Family\n---\n\n- 2025-01-01 · Sister Asha lives in Delhi (imported · Claude)\n- 2025-02-02 · Mother's birthday is in May\n");
    expect(deleteImportedEntries()).toEqual({ entries: 3, files: 1 });
    expect(readSharedNote("food.md")).toBeNull();
    expect(readSharedNote("family.md")).toBe("---\ntitle: Family\n---\n\n- 2025-02-02 · Mother's birthday is in May\n");
    expect(deleteImportedEntries()).toEqual({ entries: 0, files: 0 });
  });

  it("removes exactly the lines that carry an import's own mark, and nothing else", () => {
    writeSharedNote("travel.md", [
      "---", "title: Travel", "---", "",
      "- 2025-01-01 · Prefers window seats (imported · ChatGPT)",
      "  my own note under it: aisle on long flights",
      "- 2025-01-02 · Bought a rail pass (imported · from Japan)",
      "- 2025-01-03 · Staying in Goa (imported · Claude) · until 2099-01-05",
      "- 2025-01-04 · Pasted fact (imported · Pasted text)",
      "- 2025-01-05 · Someone wrote (imported · ChatGPT) in the middle of a line",
      "- 2025-01-06 · A mark of no import (imported · Gemini)",
      "",
    ].join("\n"));
    expect(describeSharedNotes()[0]).toMatchObject({ imported: 3 });
    expect(deleteImportedEntries()).toEqual({ entries: 3, files: 0 });
    expect(readSharedNote("travel.md")).toBe([
      "---", "title: Travel", "---", "",
      "  my own note under it: aisle on long flights",
      "- 2025-01-02 · Bought a rail pass (imported · from Japan)",
      "- 2025-01-05 · Someone wrote (imported · ChatGPT) in the middle of a line",
      "- 2025-01-06 · A mark of no import (imported · Gemini)",
      "",
    ].join("\n"));
  });
});
