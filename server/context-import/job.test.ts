// The import job against a scripted engine: upload, scan, extraction in
// batches, retry then skip, pausing itself when the engine stops answering,
// pause and resume, coming back after a restart, cancel, and save. Temp
// files and candidates are gone after save and after cancel, nothing is
// written before save, and the record that stays holds no text.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { TIDY_MARKER } from "../memory-tidy.ts";
import type { UpkeepEngine } from "../memory-upkeep.ts";
import { appendAboutMe, commitLearned, listLearnedFacts, planLearned, removeLearned } from "../profile-learned.ts";
import { readSharedNote, sharedNotesDir, writeSharedNote } from "../shared-notes.ts";
import { chatGptConversation, claudeConversation, writeExportJson, writeExportZip, type FixtureConversation } from "../testing/context-import-fixtures.ts";
import { IMPORT_MARKER } from "./extract.ts";
import { createContextImport, ENGINE_UNAVAILABLE, ImportError, type ContextImport, type ContextImportDeps } from "./job.ts";
import { listImportRecords } from "./records.ts";

const NOW = new Date(2026, 9, 10, 12);
const DAY = 86_400_000;
const DIR = join(DATA_DIR, "context-import");
let aboutMe = "";
let scratch: string;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  aboutMe = "";
  scratch = mkdtempSync(join(tmpdir(), "omb-import-job-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Seven conversations of 6,000 characters each once cut: three batches (3, 3, 1). */
function conversations(count = 7): FixtureConversation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `conv-${index}`, title: `Chat ${index}`, updatedAt: NOW.getTime() - (index + 1) * DAY,
    messages: Array.from({ length: 4 }, (_, message) => `Chat ${index} message ${message} ${"w".repeat(1_600)}`),
  }));
}

/** One fact per conversation in the batch, the first of each batch core; the conflict check finds nothing. */
function scripted(prompts: string[] = []): UpkeepEngine {
  return {
    generateText: async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith(TIDY_MARKER)) return '{"pairs": []}';
      const titles = [...prompt.matchAll(/^\[(\d+)\] "(Chat \d+|Pasted text)"/gm)];
      return JSON.stringify(titles.map(([, chat, title], index) => ({ text: `The person said something in ${title}`, kind: index === 0 ? "core" : "subject", subject: "Work", aliases: ["job"], chat: Number(chat) })));
    },
  };
}

function make(engine: UpkeepEngine | null, over: Partial<ContextImportDeps> = {}): ContextImport {
  return createContextImport({ engine: () => engine, aboutMe: () => aboutMe, saveAboutMe: (text) => { aboutMe = text; }, now: () => NOW, sleep: async () => undefined, ...over });
}

async function upload(job: ContextImport, list: readonly unknown[], kind: "zip" | "json" = "zip"): Promise<string> {
  const path = join(scratch, `export-${Math.random().toString(36).slice(2)}.${kind}`);
  if (kind === "zip") writeExportZip(path, list);
  else writeExportJson(path, list);
  const { id } = job.create("chatgpt");
  expect((await job.receiveFile(id, Readable.from([readFileSync(path)]), statSync(path).size)).status).toBe("scanning");
  await job.idle();
  return id;
}

async function rejection(work: () => unknown): Promise<ImportError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    return error as ImportError;
  }
  throw new Error("expected an ImportError");
}

describe("from upload to save", () => {
  it("scans, reads in batches, reviews and saves; nothing is written before save and nothing is left after", async () => {
    const prompts: string[] = [];
    const job = make(scripted(prompts));
    const id = await upload(job, conversations().map(chatGptConversation));
    expect(job.view(id)).toMatchObject({
      status: "scanned", origin: "chatgpt",
      scan: { format: "chatgpt", conversations: 7, withOwnMessages: 7, alreadyRead: 0 },
      estimate: { conversations: 7, chars: 42_000, calls: 4 },
    });
    // another range, asked for before anything is spent
    expect(job.view(id, { cap: 2 }).estimate).toMatchObject({ conversations: 2, calls: 2 });
    if (process.platform !== "win32") {
      expect(statSync(join(DIR, "job.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(DIR, "tmp", `${id}.upload`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(DIR, "tmp")).mode & 0o777).toBe(0o700);
    }

    expect(job.extract(id, { botId: "bot-1" }).status).toBe("preparing");
    await job.idle();
    const review = job.view(id);
    expect(review).toMatchObject({ status: "review", botId: "bot-1", progress: { batches: 3, done: 3, skipped: 0, candidates: 7, duplicates: 0 } });
    expect(review.candidates!.filter((candidate) => candidate.kind === "core").map((candidate) => candidate.chatTitle)).toEqual(["Chat 0", "Chat 3", "Chat 6"]);
    // three extraction calls, newest conversations first, then one conflict check
    expect(prompts.map((prompt) => (prompt.startsWith(IMPORT_MARKER) ? "import" : "tidy"))).toEqual(["import", "import", "import", "tidy"]);
    expect(prompts[0]).toContain('[1] "Chat 0"');
    expect(prompts[2]).toContain('[1] "Chat 6"');
    // only the person's side is sent
    expect(prompts.join("\n")).not.toContain("Assistant reply");
    // nothing has been written where a bot reads
    expect(aboutMe).toBe("");
    expect(existsSync(sharedNotesDir())).toBe(false);
    expect(listLearnedFacts()).toEqual([]);
    expect(listImportRecords()).toEqual([]);

    job.patch(id, { changes: [{ id: review.candidates![1]!.id, keep: false }] });
    const result = job.save(id);
    expect(result).toMatchObject({ aboutMe: 3, continued: 0, subjects: 1, entries: 3 });
    expect(aboutMe.split("\n")).toHaveLength(3);
    expect(aboutMe).toContain("learned by ChatGPT import · The person said something in Chat 0");
    expect(readSharedNote("work.md")).toContain("(imported · ChatGPT)");
    expect(readSharedNote("work.md")).not.toContain("Chat 1");
    // the upload, the cut text and the candidates are gone
    expect(existsSync(DIR)).toBe(false);
    expect(job.current()).toBeNull();
    // one record stays, and it says nothing of what was read
    const [record] = listImportRecords();
    expect(record).toMatchObject({ id, origin: "chatgpt", conversations: 7, aboutMe: 3, sharedNotes: 3, from: NOW.getTime() - 7 * DAY, to: NOW.getTime() - DAY });
    expect(record!.hashes).toHaveLength(7);
    const onDisk = readFileSync(join(DATA_DIR, "context-imports.json"), "utf8");
    expect(onDisk).not.toMatch(/Chat \d|message|The person said/);
  });

  it("reads only what an earlier import did not, and a bare Claude file is told by its shape", async () => {
    const job = make(scripted());
    const first = await upload(job, conversations(3).map(claudeConversation), "json");
    expect(job.view(first).origin).toBe("claude");
    job.extract(first, { botId: "bot-1" });
    await job.idle();
    job.save(first);
    expect(readSharedNote("work.md")).toContain("(imported · Claude)");
    // a newer export: the three read before are left out
    const second = await upload(job, conversations(5).map(claudeConversation), "json");
    expect(job.view(second)).toMatchObject({ scan: { conversations: 5, alreadyRead: 3 }, estimate: { conversations: 2 } });
    await job.cancel(second);
    // the same export again: nothing left to read
    const third = await upload(job, conversations(3).map(claudeConversation), "json");
    expect(job.view(third).estimate).toMatchObject({ conversations: 0, calls: 0 });
    expect((await rejection(() => job.extract(third, { botId: "bot-1" }))).message).toMatch(/nothing to read/);
  });

  it("drops a fact that About me, a shared note or the list of removed facts already has", async () => {
    // Chat 0's fact is in About me by hand, Chat 1's in a shared note, Chat 2's was removed by the person before
    const removed = planLearned({ botId: "b1", botName: "Scout" }, ["The person said something in Chat 2"], "", "2026-10-01");
    commitLearned(removed);
    removeLearned(removed[0]!.id, appendAboutMe("", [removed[0]!.line])!);
    aboutMe = "The person said something in Chat 0.";
    writeSharedNote("work.md", "---\ntitle: Work\n---\n\n- 2025-01-01 · The person said something in Chat 1 (imported · Claude)\n");
    const job = make(scripted());
    const id = await upload(job, conversations(5).map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    const review = job.view(id);
    expect(review.candidates!.map((candidate) => candidate.chatTitle)).toEqual(["Chat 3", "Chat 4"]);
    expect(review.progress).toMatchObject({ candidates: 2, duplicates: 3 });
  });

  it("imports pasted text in pieces, with no hashes in its record", async () => {
    const prompts: string[] = [];
    const job = make(scripted(prompts));
    const { id } = job.create("paste");
    const view = job.receiveText(id, "- I am vegetarian\n- I live in Pune\n");
    expect(view).toMatchObject({ status: "scanned", scan: { format: "paste", conversations: 1 }, estimate: { conversations: 1, calls: 2 } });
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    expect(prompts[0]).toContain("text the person pasted");
    expect(prompts[0]).toContain("Person: - I am vegetarian\nPerson: - I live in Pune");
    expect(job.save(id)).toMatchObject({ aboutMe: 1 });
    expect(aboutMe).toContain("learned by Pasted text import");
    expect(listImportRecords()[0]).toMatchObject({ origin: "paste", conversations: 1, from: null, to: null, hashes: [] });
    expect(existsSync(DIR)).toBe(false);
  });
});

describe("failures and pacing", () => {
  it("retries a batch once, then skips it and carries on", async () => {
    let calls = 0;
    const waits: number[] = [];
    const working = scripted();
    const engine: UpkeepEngine = {
      generateText: async (prompt, options) => {
        calls += 1;
        // the second batch answers with prose, twice
        if (prompt.includes('"Chat 3"')) return "I found nothing useful.";
        return working.generateText!(prompt, options);
      },
    };
    const job = make(engine, { sleep: async (ms) => { waits.push(ms); }, callGapMs: 2_000, retryDelayMs: 15_000 });
    const id = await upload(job, conversations().map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "review", progress: { batches: 3, done: 3, skipped: 1, candidates: 4 } });
    // 3 batches + 1 retry + the conflict check
    expect(calls).toBe(5);
    expect(waits.filter((ms) => ms === 15_000)).toHaveLength(1);
    expect(waits.filter((ms) => ms === 2_000).length).toBeGreaterThanOrEqual(2);
    // a skipped batch's conversations were not read: a later import may read them
    job.save(id);
    expect(listImportRecords()[0]!.hashes).toHaveLength(4);
  });

  it("pauses itself after three batches in a row fail, gives them back, and finishes on resume", async () => {
    let limited = true;
    let calls = 0;
    const working = scripted();
    const engine: UpkeepEngine = {
      generateText: async (prompt, options) => {
        calls += 1;
        if (limited) throw new Error("429 usage limit reached, token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        return working.generateText!(prompt, options);
      },
    };
    const job = make(engine);
    const id = await upload(job, conversations().map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    const paused = job.view(id);
    expect(paused).toMatchObject({ status: "paused", pausedBy: "engine", progress: { batches: 3, done: 0, skipped: 0, candidates: 0 } });
    expect(paused.note).toMatch(/paused itself/);
    expect(paused.note).toContain("429 usage limit reached");
    expect(paused.note).not.toContain("sk-ant-api03-AAAA");
    // three batches, each tried twice, and then no more
    expect(calls).toBe(6);
    limited = false;
    expect(job.resume(id).status).toBe("extracting");
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "review", progress: { done: 3, skipped: 0, candidates: 7 } });
    expect(job.view(id).note).toBeUndefined();
  });

  it("reaches review without the conflict check when that call fails, and says so", async () => {
    const working = scripted();
    const engine: UpkeepEngine = { generateText: async (prompt, options) => (prompt.startsWith(TIDY_MARKER) ? Promise.reject(new Error("down")) : working.generateText!(prompt, options)) };
    const job = make(engine);
    const id = await upload(job, conversations(2).map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "review" });
    expect(job.view(id).note).toMatch(/were not checked/);
  });

  it("gives up on a call that takes too long", async () => {
    const engine: UpkeepEngine = { generateText: () => new Promise(() => undefined) };
    const job = make(engine, { callTimeoutMs: 20 });
    const id = await upload(job, conversations(1).map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "review", progress: { batches: 1, done: 1, skipped: 1, candidates: 0 } });
  });

  it("refuses a bot whose engine has no quick text call", async () => {
    const job = make({});
    const id = await upload(job, conversations(1).map(chatGptConversation));
    const refused = await rejection(() => job.extract(id, { botId: "bot-1" }));
    expect(refused).toMatchObject({ status: 409, message: ENGINE_UNAVAILABLE });
    expect(job.view(id).status).toBe("scanned");
  });
});

describe("pause, resume, restart and cancel", () => {
  /** An engine whose first call waits until it is released or its signal aborts. */
  function gated() {
    const working = scripted();
    let open: (() => void) | null = null;
    let first = true;
    const signals: AbortSignal[] = [];
    const reached = new Promise<void>((resolve) => { open = resolve; });
    const engine: UpkeepEngine = {
      generateText: async (prompt, options) => {
        if (first) {
          first = false;
          signals.push(options!.signal!);
          open!();
          await new Promise<void>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        }
        return working.generateText!(prompt, options);
      },
    };
    return { engine, reached, signals };
  }

  it("stops the call in flight on pause and reads that batch again on resume", async () => {
    const { engine, reached, signals } = gated();
    const job = make(engine);
    const id = await upload(job, conversations().map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await reached;
    expect(job.view(id).status).toBe("extracting");
    expect(job.pause(id)).toMatchObject({ status: "paused", pausedBy: "person" });
    await job.idle();
    expect(signals[0]!.aborted).toBe(true);
    expect(job.view(id)).toMatchObject({ status: "paused", progress: { done: 0, skipped: 0 } });
    expect((await rejection(() => job.pause(id))).status).toBe(409);
    job.resume(id);
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "review", progress: { done: 3, skipped: 0, candidates: 7 } });
  });

  it("comes back paused after a restart, with what it had read, and finishes on resume", async () => {
    const { engine, reached } = gated();
    const before = make(scripted());
    const id = await upload(before, conversations().map(chatGptConversation));
    // read one batch, then stop as a killed server would: mid-call, nothing flushed after
    const slow = make(engine);
    slow.start();
    expect(slow.view(id).status).toBe("scanned");
    slow.extract(id, { botId: "bot-1" });
    await reached;
    const stored = JSON.parse(readFileSync(join(DIR, "job.json"), "utf8")) as { status: string };
    expect(stored.status).toBe("extracting");

    const after = make(scripted());
    after.start();
    expect(after.view(id)).toMatchObject({ status: "paused", pausedBy: "restart", progress: { batches: 3, done: 0 } });
    after.resume(id);
    await after.idle();
    expect(after.view(id)).toMatchObject({ status: "review", progress: { done: 3, candidates: 7 } });
    // a review survives a restart too
    const later = make(scripted());
    later.start();
    expect(later.view(id).candidates).toHaveLength(7);
    await slow.cancel(id).catch(() => undefined);
  });

  it("drops an upload or a scan that a restart cut short, and a job file that cannot be read", () => {
    const job = make(scripted());
    const { id } = job.create("chatgpt");
    expect(existsSync(join(DIR, "job.json"))).toBe(true);
    const restarted = make(scripted());
    restarted.start();
    expect(restarted.current()).toBeNull();
    expect(existsSync(DIR)).toBe(false);
    expect(() => restarted.view(id)).toThrowError(ImportError);
    // and it never blocks the next import
    expect(restarted.create("paste").status).toBe("created");
    writeFileSync(join(DIR, "job.json"), "{ not json");
    const again = make(scripted());
    again.start();
    expect(again.current()).toBeNull();
    expect(existsSync(DIR)).toBe(false);
  });

  it("cancel deletes the upload, the cut text and the candidates, and leaves no record", async () => {
    const { engine, reached } = gated();
    const job = make(engine);
    const id = await upload(job, conversations().map(chatGptConversation));
    job.extract(id, { botId: "bot-1" });
    await reached;
    expect(readdirSync(join(DIR, "tmp")).sort()).toEqual([`${id}.batches.json`, `${id}.rows.json`, `${id}.upload`]);
    await job.cancel(id);
    expect(existsSync(DIR)).toBe(false);
    expect(job.current()).toBeNull();
    expect(listImportRecords()).toEqual([]);
    expect(aboutMe).toBe("");
    expect(existsSync(sharedNotesDir())).toBe(false);
    // and a new import can start
    expect(job.create("paste").status).toBe("created");
  });

  it("waits for a backup to finish before the next call", async () => {
    const prompts: string[] = [];
    const job = make(scripted(prompts));
    const id = await upload(job, conversations(1).map(chatGptConversation));
    job.hold();
    job.extract(id, { botId: "bot-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prompts).toEqual([]);
    job.release();
    await job.idle();
    expect(job.view(id).status).toBe("review");
  });
});

describe("what is refused", () => {
  it("allows one import at a time and only the next step", async () => {
    const job = make(scripted());
    const { id } = job.create("chatgpt");
    expect((await rejection(() => job.create("paste")))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.receiveText(id, "text")))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.extract(id, { botId: "bot-1" })))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.save(id)))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.patch(id, {})))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.resume(id)))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.view("someone-else")))).toMatchObject({ status: 404 });
    await job.cancel(id);
    const paste = job.create("paste");
    expect((await rejection(() => job.receiveFile(paste.id, Readable.from([Buffer.from("[]")]))))).toMatchObject({ status: 409 });
    expect((await rejection(() => job.receiveText(paste.id, "   ")))).toMatchObject({ status: 400 });
    expect((await rejection(() => job.receiveText(paste.id, "x".repeat(100_001))))).toMatchObject({ status: 413 });
  });

  it("refuses an upload over the limit, by its declared size or as it arrives, and an empty one", async () => {
    const job = make(scripted(), { uploadMaxBytes: 1_000 });
    const { id } = job.create("chatgpt");
    expect((await rejection(() => job.receiveFile(id, Readable.from([Buffer.alloc(10)]), 5_000)))).toMatchObject({ status: 413 });
    const tooMuch = await rejection(() => job.receiveFile(id, Readable.from([Buffer.alloc(600), Buffer.alloc(600)])));
    expect(tooMuch).toMatchObject({ status: 413 });
    expect(tooMuch.message).toMatch(/conversations\.json/);
    expect(existsSync(join(DIR, "tmp", `${id}.upload`))).toBe(false);
    expect(job.view(id).status).toBe("created");
    expect((await rejection(() => job.receiveFile(id, Readable.from([]))))).toMatchObject({ status: 400 });
    // an upload that breaks off leaves nothing behind and can be tried again
    const broken = Readable.from((async function* () {
      yield Buffer.from("[{");
      throw new Error("socket closed");
    })());
    expect((await rejection(() => job.receiveFile(id, broken)))).toMatchObject({ status: 400 });
    expect(existsSync(join(DIR, "tmp", `${id}.upload`))).toBe(false);
    expect(job.view(id).status).toBe("created");
  });

  it("fails the scan of a file that holds no conversations, in words, and lets it be cancelled", async () => {
    const job = make(scripted());
    const path = join(scratch, "notes.json");
    writeExportJson(path, [{ hello: "world" }]);
    const { id } = job.create("chatgpt");
    await job.receiveFile(id, Readable.from([readFileSync(path)]));
    await job.idle();
    expect(job.view(id)).toMatchObject({ status: "failed", error: "No ChatGPT or Claude conversations were found in that file. 1 item(s) had a shape this version does not know." });
    await job.cancel(id);
    expect(existsSync(DIR)).toBe(false);
  });
});
