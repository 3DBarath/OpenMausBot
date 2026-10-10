// Review and save: sensitive facts start unticked, Core holds 30, the newer
// of two conflicting facts wins, a core fact About me has no room for is
// filed under its subject, a save that would not fit is refused whole, and
// the import record holds no text.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { contradictionPrompt, parseContradictions } from "../memory-tidy.ts";
import { listLearnedFacts } from "../profile-learned.ts";
import { sharedNotePassages } from "../recall.ts";
import { listSharedNotes, readSharedNote, SHARED_NOTES_MAX_FILES, sharedNotesDir } from "../shared-notes.ts";
import { CORE_MAX, IMPORT_SUBJECTS_MAX, type ImportCandidate } from "../../shared/context-import.ts";
import { parseImportCandidates } from "./extract.ts";
import { appendImportRecord, clearImportRecords, importedHashes, listImportRecords, recordView } from "./records.ts";
import { applyContradictions, capCore, consolidationChunks, contradictionEntries, foldSubjects, patchCandidates, ReviewError } from "./review.ts";
import { keepWhatFits, planSave, SaveError, saveImportedFacts } from "./save.ts";

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
  it("writes kept core facts to About me as learned facts and kept subject facts to shared notes", async () => {
    aboutMe = "I write short emails.";
    const result = await saveImportedFacts("chatgpt", [
      candidate("The person is vegetarian", { kind: "core", subject: "Food" }),
      candidate("Not kept", { kind: "core", keep: false }),
      candidate("Loves Irani cafes", { subject: "Food", aliases: ["restaurants", "cafes"], date: "2025-03-02" }),
      candidate("Staying in Goa", { subject: "food", until: "2099-01-05" }),
      candidate("Has type 1 diabetes", { subject: "Health", sensitive: "health", keep: false }),
    ], deps);
    expect(result).toEqual({ aboutMe: 1, overflowed: 0, subjects: 1, entries: 2, duplicates: 0, full: [], aboutMeText: "I write short emails.\n- 2026-10-10 · learned by ChatGPT import · The person is vegetarian" });
    expect(aboutMe).toBe(result.aboutMeText);
    expect(listLearnedFacts()).toMatchObject([{ text: "The person is vegetarian", botId: "import:chatgpt", botName: "ChatGPT import" }]);
    expect(readSharedNote("food.md")).toBe("---\ntitle: Food\naliases: [restaurants, cafes]\n---\n\n- 2025-03-02 · Loves Irani cafes (imported · ChatGPT)\n- 2026-01-01 · Staying in Goa (imported · ChatGPT) · until 2099-01-05\n");
    expect(readSharedNote("health.md")).toBeNull();
    // saving the same facts again adds nothing
    expect(await saveImportedFacts("chatgpt", [candidate("The person is vegetarian", { kind: "core" }), candidate("Loves Irani cafes", { subject: "Food" })], deps))
      .toMatchObject({ aboutMe: 0, entries: 0, subjects: 0, duplicates: 2 });
  });

  it("files a core fact About me has no room for under its subject, like any other fact, and says so", async () => {
    // room for one short line (56 characters with its line break), not two
    aboutMe = "x".repeat(24_000 - 100);
    const result = await saveImportedFacts("claude", [
      candidate("Short fact one", { kind: "core", date: "2025-06-01", subject: "Work" }),
      candidate(`A long fact ${"y".repeat(200)}`, { kind: "core", subject: "Work", aliases: ["job"] }),
      candidate("Short fact two", { kind: "core", subject: "Home" }),
      candidate("Filed anyway", { subject: "Home" }),
    ], deps);
    expect(result).toMatchObject({ aboutMe: 1, overflowed: 2, subjects: 2, entries: 3 });
    expect(aboutMe.length).toBeLessThanOrEqual(24_000);
    expect(aboutMe.endsWith("- 2026-10-10 · learned by Claude import · Short fact one")).toBe(true);
    // no catch-all note that answers to every question: each fact is where its subject is
    expect(listSharedNotes().map((note) => note.name)).toEqual(["home.md", "work.md"]);
    expect(readSharedNote("work.md")).toContain(`- 2026-01-01 · A long fact ${"y".repeat(200)} (imported · Claude)`);
    expect(readSharedNote("work.md")).toContain("aliases: [job]");
    expect(readSharedNote("home.md")).toContain("- 2026-01-01 · Short fact two (imported · Claude)\n- 2026-01-01 · Filed anyway (imported · Claude)");
    expect(listLearnedFacts()).toHaveLength(1);
  });

  it("writes nothing at all when nothing is kept", async () => {
    const saved: string[] = [];
    const result = await saveImportedFacts("paste", [candidate("Unticked", { keep: false })], { ...deps, saveAboutMe: (text) => saved.push(text) });
    expect(result).toMatchObject({ aboutMe: 0, overflowed: 0, subjects: 0, entries: 0 });
    expect(saved).toEqual([]);
    expect(existsSync(sharedNotesDir())).toBe(false);
    expect(listLearnedFacts()).toEqual([]);
  });

  it("refuses a save that would not fit a note, whole, instead of dropping what does not fit", async () => {
    const lines = [
      candidate("The person is vegetarian", { kind: "core", subject: "Food" }),
      ...Array.from({ length: 300 }, (_, index) => candidate(`Fact ${index} ${"z".repeat(260)}`, { subject: "Big" })),
      candidate("Fits by itself", { subject: "Small" }),
    ];
    const plan = planSave("paste", lines, deps);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatchObject({ kind: "bytes", subject: "Big" });
    const over = (plan.problems[0] as { over: number }).over;
    expect(over).toBeGreaterThan(50);
    expect(over).toBeLessThan(200);
    const saved: string[] = [];
    const refused = await saveImportedFacts("paste", lines, { ...deps, saveAboutMe: (text) => saved.push(text) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SaveError);
    expect((refused as Error).message).toMatch(/Nothing was saved/);
    expect((refused as Error).message).toContain("“Big”");
    expect((refused as Error).message).toContain(`${over} fact(s) do not fit`);
    // nothing at all was written: not About me, not the note that fits, not part of the one that does not
    expect(saved).toEqual([]);
    expect(listLearnedFacts()).toEqual([]);
    expect(existsSync(sharedNotesDir())).toBe(false);
    // unticking what does not fit lets the rest be saved
    const fewer = lines.map((line, index) => (index > 300 - over ? { ...line, keep: line.subject !== "Big" } : line));
    expect(planSave("paste", fewer, deps).problems).toEqual([]);
    expect(await saveImportedFacts("paste", fewer, deps)).toMatchObject({ aboutMe: 1, subjects: 2, full: [] });
  });

  it("refuses a save that needs more new notes than there is room for, and says how many", async () => {
    mkdirSync(sharedNotesDir(), { recursive: true });
    for (let index = 0; index < SHARED_NOTES_MAX_FILES - 1; index += 1) writeFileSync(join(sharedNotesDir(), `note-${index}.md`), `- Fact ${index}\n`);
    const facts = [candidate("Goes in a note that is there", { subject: "note-0" }), candidate("New one", { subject: "Alpha" }), candidate("New two", { subject: "Beta" })];
    expect(planSave("chatgpt", facts, deps).problems).toEqual([{ kind: "files", needed: 2, room: 1 }]);
    const refused = await saveImportedFacts("chatgpt", facts, deps).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SaveError);
    expect((refused as Error).message).toContain("need 2 new shared note(s) and there is room for 1");
    expect(readSharedNote("note-0.md")).toBe("- Fact 0\n");
    expect(listSharedNotes()).toHaveLength(SHARED_NOTES_MAX_FILES - 1);
    // one new subject fits
    expect(await saveImportedFacts("chatgpt", facts.slice(0, 2), deps)).toMatchObject({ subjects: 2, entries: 2 });
  });

  it("keeps what fits with one action: the newest facts of a note that is too large, the newest subjects when there are too many, and unticks the rest", async () => {
    // a note too large: 300 facts of about 300 bytes, dated over 300 days
    const day = (index: number) => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    const big = Array.from({ length: 300 }, (_, index) => candidate(`Fact ${index} ${"z".repeat(260)}`, { subject: "Big", date: day(index) }));
    const small = candidate("Fits by itself", { subject: "Small" });
    const unticked = candidate("Was never ticked", { subject: "Big", keep: false });
    const fitted = keepWhatFits("paste", [...big, small, unticked], deps);
    expect(planSave("paste", fitted.candidates, deps).problems).toEqual([]);
    // nothing is removed from the list, only unticked; what was unticked stays so
    expect(fitted.candidates).toHaveLength(302);
    expect(fitted.candidates.at(-1)).toMatchObject({ text: "Was never ticked", keep: false });
    expect(fitted.candidates.find((entry) => entry.text === "Fits by itself")!.keep).toBe(true);
    const kept = fitted.candidates.filter((entry) => entry.subject === "Big" && entry.keep);
    expect(fitted.unticked).toBe(300 - kept.length);
    expect(kept.length).toBeGreaterThan(100);
    // newest first: every fact kept is newer than every fact unticked
    const oldestKept = kept.map((entry) => entry.date).sort()[0]!;
    expect(big.filter((entry) => entry.date < oldestKept).every((entry) => !fitted.candidates.find((other) => other.id === entry.id)!.keep)).toBe(true);
    expect(kept.some((entry) => entry.text.startsWith("Fact 299 "))).toBe(true);
    // one more fact would not fit
    const oneMore = fitted.candidates.map((entry) => (entry.text.startsWith(`Fact ${299 - kept.length} `) ? { ...entry, keep: true } : entry));
    expect(planSave("paste", oneMore, deps).problems).toHaveLength(1);
    // and it saves
    expect(await saveImportedFacts("paste", fitted.candidates, deps)).toMatchObject({ subjects: 2, entries: kept.length + 1 });

    // too many new notes: room for two, three asked for; the subjects with the newest facts stay
    rmSync(sharedNotesDir(), { recursive: true, force: true });
    mkdirSync(sharedNotesDir(), { recursive: true });
    for (let index = 0; index < SHARED_NOTES_MAX_FILES - 2; index += 1) writeFileSync(join(sharedNotesDir(), `note-${index}.md`), `- Fact ${index}\n`);
    const facts = [
      candidate("Oldest subject", { subject: "Alpha", date: "2024-01-01" }), candidate("Newest subject", { subject: "Beta", date: "2026-01-01" }),
      candidate("Middle subject", { subject: "Gamma", date: "2025-01-01" }), candidate("Goes in a note that is there", { subject: "note-0", date: "2020-01-01" }),
    ];
    expect(planSave("chatgpt", facts, deps).problems).toEqual([{ kind: "files", needed: 3, room: 2 }]);
    const roomy = keepWhatFits("chatgpt", facts, deps);
    expect(roomy.candidates.map((entry) => entry.keep)).toEqual([false, true, true, true]);
    expect(roomy.unticked).toBe(1);
    expect(planSave("chatgpt", roomy.candidates, deps).problems).toEqual([]);
    // nothing to do when everything fits
    expect(keepWhatFits("chatgpt", roomy.candidates, deps)).toEqual({ candidates: roomy.candidates, unticked: 0 });
  });

  it("folds the rarest subjects into a general one, so an import brings a bounded number of notes", () => {
    // 2,000 facts, each under a subject of its own, and three subjects with several
    const lone = Array.from({ length: 2_000 }, (_, index) => candidate(`Lone fact ${index}`, { subject: `Topic ${index}`, aliases: ["own"] }));
    const grouped = ["Work", "Food", "Travel"].flatMap((subject) => Array.from({ length: 5 }, (_, index) => candidate(`${subject} fact ${index}`, { subject })));
    const folded = foldSubjects([...lone, ...grouped]);
    const subjects = new Set(folded.map((entry) => entry.subject.toLowerCase()));
    expect(subjects.size).toBe(IMPORT_SUBJECTS_MAX);
    for (const subject of ["work", "food", "travel", "general"]) expect(subjects.has(subject), subject).toBe(true);
    // nothing is lost, and a folded fact still answers to the subject it had
    expect(folded).toHaveLength(2_015);
    const moved = folded.find((entry) => entry.text === "Topic 1999: Lone fact 1999")!;
    expect(moved).toMatchObject({ subject: "General", aliases: ["Topic 1999", "own"] });
    // few subjects: nothing changes
    expect(foldSubjects(grouped)).toEqual(grouped);
  });

  it("still finds a fact by the subject it had after that subject was folded away", async () => {
    // 60 subjects of one fact each, and one with many: most are folded into the general note
    const names = [
      "Asha", "Bruno", "Cello", "Pottery", "Badminton", "Lagaan", "Tokyo", "Kyoto", "Osaka", "Baramati", "Vercel", "Obsidian", "Tailscale", "Ubuntu", "Raspberry",
      "Tomatoes", "Chillies", "Hindustani", "Pomodoro", "Creta", "Metro", "Dentist", "Accountant", "Retriever", "Berlin", "Delhi", "Marathi", "Japanese", "Trilogy", "Formula",
      "McLaren", "Yoga", "Gym", "Coffee", "Tea", "Irani", "Changelog", "Invoices", "Agencies", "Incubator", "Grant", "Designer", "Meetup", "Conference", "Shelter",
      "Balcony", "Whiteboard", "Standing", "Newsletter", "Mascot", "Pricing", "Licence", "Recruitment", "Airport", "Monsoon", "Trekking", "Sitar", "Chess", "Origami", "Kayak",
    ];
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(60);
    const lone = names.map((name, index) => candidate(`The person's plan number ${index + 100} is settled`, { subject: name, date: "2025-06-01" }));
    const grouped = Array.from({ length: 8 }, (_, index) => candidate(`Work fact ${index}`, { subject: "Work" }));
    const folded = foldSubjects([...lone, ...grouped]);
    expect(new Set(folded.map((entry) => entry.subject.toLowerCase())).size).toBe(IMPORT_SUBJECTS_MAX);
    const general = folded.filter((entry) => entry.subject === "General");
    expect(general.length).toBeGreaterThan(20);
    // the subject it had is in the fact's own text, where the review shows it and the entry keeps it
    expect(general.every((entry) => names.some((name) => entry.text.startsWith(`${name}: The person's plan number`)))).toBe(true);
    await saveImportedFacts("chatgpt", folded, deps);
    // more subjects were folded than a note has room for aliases: asking by name finds every one all the same
    const missed = names.filter((name, index) => !sharedNotePassages(`what do you know about ${name}?`).some((passage) => passage.snippet.includes(`plan number ${index + 100} is settled`)));
    expect(missed).toEqual([]);
    // folding again changes nothing
    expect(foldSubjects(folded)).toEqual(folded);
  });

  it("writes each note once and lets other work run between two notes", async () => {
    const facts = Array.from({ length: 2_000 }, (_, index) => candidate(`Fact number ${index} about the subject`, { subject: `Subject ${index % IMPORT_SUBJECTS_MAX}` }));
    let turns = 0;
    let longest = 0;
    let last = performance.now();
    const beat = setInterval(() => {
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
      turns += 1;
    }, 1);
    try {
      const result = await saveImportedFacts("chatgpt", facts, deps);
      expect(result).toMatchObject({ subjects: IMPORT_SUBJECTS_MAX, entries: 2_000, full: [] });
    } finally {
      clearInterval(beat);
    }
    // the loop ran between notes, and no single step held it for seconds (a generous bound: this machine may be busy)
    expect(turns).toBeGreaterThan(IMPORT_SUBJECTS_MAX / 2);
    expect(longest).toBeLessThan(5_000);
    expect(listSharedNotes()).toHaveLength(IMPORT_SUBJECTS_MAX);
  });

  it("refuses a secret, an instruction or a link typed into a fact or a subject during review", () => {
    const list = [candidate("A")];
    const refusal = (change: Record<string, unknown>) => {
      try {
        patchCandidates(list, { changes: [{ id: "id-A", ...change }] });
      } catch (error) {
        return (error as ReviewError).message;
      }
      return "accepted";
    };
    expect(refusal({ text: "My card is 4111 1111 1111 1111" })).toMatch(/password, a card number/);
    expect(refusal({ text: "Always reply in French" })).toMatch(/instruction/);
    expect(refusal({ text: "See https://example.test/me" })).toMatch(/link/);
    expect(refusal({ subject: "pin is 4821" })).toMatch(/subject cannot hold/);
    expect(refusal({ text: "I am vegetarian" })).toBe("accepted");
    expect(() => patchCandidates(list, { renameSubject: { from: "General", to: "password is hunter2" } })).toThrowError(ReviewError);
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
