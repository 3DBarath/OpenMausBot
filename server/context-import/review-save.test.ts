// Review and save: sensitive facts start unticked, Core holds 30, the newer
// of two conflicting facts wins, About me overflows into "About me,
// continued", and the import record holds no text.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { contradictionPrompt, parseContradictions } from "../memory-tidy.ts";
import { listLearnedFacts } from "../profile-learned.ts";
import { readSharedNote, sharedNotesDir } from "../shared-notes.ts";
import { CORE_MAX, type ImportCandidate } from "../../shared/context-import.ts";
import { parseImportCandidates } from "./extract.ts";
import { appendImportRecord, clearImportRecords, importedHashes, listImportRecords, recordView } from "./records.ts";
import { applyContradictions, capCore, consolidationChunks, contradictionEntries, patchCandidates, ReviewError } from "./review.ts";
import { CONTINUED_SUBJECT, saveImportedFacts } from "./save.ts";

const NOW = new Date(2026, 9, 10, 12);
let aboutMe = "";
const deps = { aboutMe: () => aboutMe, saveAboutMe: (text: string) => { aboutMe = text; }, now: () => NOW };

function candidate(text: string, over: Partial<ImportCandidate> = {}): ImportCandidate {
  return { id: `id-${text}`, text, kind: "subject", subject: "General", aliases: [], date: "2026-01-01", sensitive: null, chatTitle: "Chat", keep: true, ...over };
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  aboutMe = "";
});

describe("review", () => {
  it("starts a sensitive fact unticked", () => {
    const parsed = parseImportCandidates(JSON.stringify([
      { text: "Owes 40,000 on a car loan", kind: "subject", subject: "money", sensitive: "money" },
      { text: "Lives in Pune", kind: "core", subject: "home", sensitive: null },
    ]), [], "2026-10-10")!;
    expect(parsed.map((entry) => [entry.sensitive, entry.keep])).toEqual([["money", false], [null, true]]);
  });

  it("keeps the 30 newest core facts in Core and moves the rest to their subject", () => {
    const many = Array.from({ length: 34 }, (_, index) => candidate(`Core ${index}`, { kind: "core", subject: "Work", date: `2026-01-${String(index + 1).padStart(2, "0")}` }));
    const capped = capCore([...many, candidate("Filed", { subject: "Food" })]);
    expect(capped.filter((entry) => entry.kind === "core")).toHaveLength(CORE_MAX);
    expect(capped.filter((entry) => entry.kind === "subject").map((entry) => entry.text)).toEqual(["Core 0", "Core 1", "Core 2", "Core 3", "Filed"]);
    expect(capped.find((entry) => entry.text === "Core 0")).toMatchObject({ kind: "subject", subject: "Work" });
    expect(capCore(many.slice(0, 5))).toEqual(many.slice(0, 5));
  });

  it("lets the newer of two conflicting facts win and leaves the older one unticked, pointing at it", () => {
    const facts = [
      candidate("Lives in Pune", { subject: "home", date: "2026-03-01" }),
      candidate("Lives in Mumbai", { subject: "home", date: "2024-05-01" }),
      candidate("Loves pasta", { subject: "food", date: "2025-01-01" }),
      candidate("Hates pasta", { subject: "food", date: "2025-01-01" }),
    ];
    const [chunk] = consolidationChunks(facts);
    expect(chunk!.map((entry) => entry.text)).toEqual(["Loves pasta", "Hates pasta", "Lives in Mumbai", "Lives in Pune"]);
    expect(contradictionPrompt(contradictionEntries(chunk!))).toContain("[2] (2024-05-01) Lives in Mumbai\n[3] (2026-03-01) Lives in Pune");
    // the model says keep the older city; the dates decide. On the same day its choice stands.
    const pairs = parseContradictions('{"pairs": [{"a": 2, "b": 3, "keep": "a"}, {"a": 0, "b": 1, "keep": "b"}, {"a": 3, "b": 0, "keep": "a"}]}', chunk!.length);
    const settled = applyContradictions(facts, pairs, chunk!);
    expect(settled.map((entry) => [entry.text, entry.keep, entry.replacedBy])).toEqual([
      ["Lives in Pune", true, undefined],
      ["Lives in Mumbai", false, "id-Lives in Pune"],
      ["Loves pasta", false, "id-Hates pasta"],
      ["Hates pasta", true, undefined],
    ]);
    expect(consolidationChunks(Array.from({ length: 450 }, (_, index) => candidate(`F${index}`))).map((group) => group.length)).toEqual([200, 200, 50]);
  });

  it("applies the person's ticks, edits, moves and renames, and refuses what breaks a rule", () => {
    const facts = [candidate("Lives in Pune", { kind: "core", subject: "home" }), candidate("Loves pasta", { subject: "food" }), candidate("Hates olives", { subject: "Food" })];
    const patched = patchCandidates(facts, {
      renameSubject: { from: "food", to: "Eating: [out]" },
      changes: [{ id: "id-Lives in Pune", keep: false, text: "  Lives in Pune,\nnear the river " }, { id: "id-Loves pasta", kind: "core" }],
    });
    expect(patched).toEqual([
      candidate("Lives in Pune, near the river", { id: "id-Lives in Pune", kind: "core", subject: "home", keep: false }),
      candidate("Loves pasta", { kind: "core", subject: "Eating out" }),
      candidate("Hates olives", { subject: "Eating out" }),
    ]);
    expect(() => patchCandidates(facts, { changes: [{ id: "gone", keep: false }] })).toThrowError(ReviewError);
    expect(() => patchCandidates(facts, { changes: [{ id: "id-Loves pasta", text: "   " }] })).toThrowError(/cannot be empty/);
    const full = Array.from({ length: CORE_MAX }, (_, index) => candidate(`Core ${index}`, { kind: "core" }));
    expect(() => patchCandidates([...full, candidate("One more")], { changes: [{ id: "id-One more", kind: "core" }] })).toThrowError(/at most 30/);
    // moving one out makes room, in the same request
    expect(patchCandidates([...full, candidate("One more")], { changes: [{ id: "id-Core 0", kind: "subject" }, { id: "id-One more", kind: "core" }] }).filter((entry) => entry.kind === "core")).toHaveLength(CORE_MAX);
  });
});

describe("save", () => {
  it("writes kept core facts to About me as learned facts and kept subject facts to shared notes", () => {
    aboutMe = "I write short emails.";
    const result = saveImportedFacts("chatgpt", [
      candidate("The person is vegetarian", { kind: "core", subject: "Food" }),
      candidate("Not kept", { kind: "core", keep: false }),
      candidate("Loves Irani cafes", { subject: "Food", aliases: ["restaurants", "cafes"], date: "2025-03-02" }),
      candidate("Staying in Goa", { subject: "food", until: "2099-01-05" }),
      candidate("Has type 1 diabetes", { subject: "Health", sensitive: "health", keep: false }),
    ], deps);
    expect(result).toEqual({ aboutMe: 1, continued: 0, subjects: 1, entries: 2, duplicates: 0, full: [], aboutMeText: "I write short emails.\n- 2026-10-10 · learned by ChatGPT import · The person is vegetarian" });
    expect(aboutMe).toBe(result.aboutMeText);
    expect(listLearnedFacts()).toMatchObject([{ text: "The person is vegetarian", botId: "import:chatgpt", botName: "ChatGPT import" }]);
    expect(readSharedNote("food.md")).toBe("---\ntitle: Food\naliases: [restaurants, cafes]\n---\n\n- 2025-03-02 · Loves Irani cafes (imported · ChatGPT)\n- 2026-01-01 · Staying in Goa (imported · ChatGPT) · until 2099-01-05\n");
    expect(readSharedNote("health.md")).toBeNull();
    // saving the same facts again adds nothing
    expect(saveImportedFacts("chatgpt", [candidate("The person is vegetarian", { kind: "core" }), candidate("Loves Irani cafes", { subject: "Food" })], deps))
      .toMatchObject({ aboutMe: 0, entries: 0, subjects: 0, duplicates: 2 });
  });

  it("puts core facts About me has no room for into the \"About me, continued\" note, and says so", () => {
    // room for one short line (56 characters with its line break), not two
    aboutMe = "x".repeat(24_000 - 100);
    const result = saveImportedFacts("claude", [
      candidate("Short fact one", { kind: "core", date: "2025-06-01" }),
      candidate(`A long fact ${"y".repeat(200)}`, { kind: "core" }),
      candidate("Short fact two", { kind: "core" }),
    ], deps);
    expect(result).toMatchObject({ aboutMe: 1, continued: 2, subjects: 1, entries: 0 });
    expect(aboutMe.length).toBeLessThanOrEqual(24_000);
    expect(aboutMe.endsWith("- 2026-10-10 · learned by Claude import · Short fact one")).toBe(true);
    const note = readSharedNote("about-me-continued.md")!;
    expect(note).toContain(`title: ${CONTINUED_SUBJECT}`);
    expect(note).toContain("- 2026-01-01 · Short fact two (imported · Claude)");
    expect(listLearnedFacts()).toHaveLength(1);
  });

  it("writes nothing at all when nothing is kept", () => {
    const saved: string[] = [];
    const result = saveImportedFacts("paste", [candidate("Unticked", { keep: false })], { ...deps, saveAboutMe: (text) => saved.push(text) });
    expect(result).toMatchObject({ aboutMe: 0, continued: 0, subjects: 0, entries: 0 });
    expect(saved).toEqual([]);
    expect(existsSync(sharedNotesDir())).toBe(false);
    expect(listLearnedFacts()).toEqual([]);
  });

  it("reports a subject that could not take every entry", () => {
    const lines = Array.from({ length: 300 }, (_, index) => candidate(`Fact ${index} ${"z".repeat(260)}`, { subject: "Big" }));
    const result = saveImportedFacts("paste", lines, deps);
    expect(result.full).toEqual([{ subject: "Big", dropped: 300 - result.entries, reason: "bytes" }]);
    expect(result.entries).toBeGreaterThan(100);
    expect(readSharedNote("big.md")).toContain("(imported · Pasted text)");
  });
});

describe("the import record", () => {
  it("keeps counts, dates and hashes, and no text", () => {
    appendImportRecord({ id: "job-1", origin: "chatgpt", at: 1_000, conversations: 2, aboutMe: 1, sharedNotes: 3, from: 10, to: 20, hashes: ["aaa", "bbb", ""] });
    appendImportRecord({ id: "job-2", origin: "paste", at: 2_000, conversations: 1, aboutMe: 0, sharedNotes: 1, from: null, to: null, hashes: [] });
    expect(importedHashes()).toEqual(new Set(["aaa", "bbb"]));
    expect(listImportRecords().map(recordView)).toEqual([
      { id: "job-1", origin: "chatgpt", at: 1_000, conversations: 2, aboutMe: 1, sharedNotes: 3, from: 10, to: 20 },
      { id: "job-2", origin: "paste", at: 2_000, conversations: 1, aboutMe: 0, sharedNotes: 1, from: null, to: null },
    ]);
    const onDisk = JSON.parse(readFileSync(join(DATA_DIR, "context-imports.json"), "utf8")) as { imports: Array<Record<string, unknown>> };
    expect(Object.keys(onDisk.imports[0]!).sort()).toEqual(["aboutMe", "at", "conversations", "from", "hashes", "id", "origin", "sharedNotes", "to"]);
    clearImportRecords();
    expect(listImportRecords()).toEqual([]);
    expect(importedHashes()).toEqual(new Set());
  });
});
